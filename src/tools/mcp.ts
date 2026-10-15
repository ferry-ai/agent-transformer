import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JsonSchema, Tool, ToolOutput } from './types.js';

/**
 * One MCP server from the config file. The file uses the usual "mcpServers" shape
 * (as in Claude Desktop or Cursor), so existing configs can be copied in:
 *
 *   { "mcpServers": {
 *       "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
 *       "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } } } }
 *
 * "${NAME}" in env and headers is read from the environment, so tokens stay out of the file.
 */
export interface McpServerConfig {
  name: string;
  /** A local server, started as a child process speaking over stdio. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** A remote server. "http" is Streamable HTTP; "sse" is the older HTTP+SSE transport. */
  url?: string;
  headers?: Record<string, string>;
  type?: 'stdio' | 'http' | 'sse';
  /** Tools that run without asking: true for all of them, or a list of names. */
  autoApprove: boolean | string[];
  /** Longest wait for one tool call. */
  timeoutMs?: number;
}

const CLIENT = { name: 'agent-transformer', version: '0.1.0' };
const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;
/** How much of a local server's stderr is kept to explain a failure. */
const STDERR_TAIL = 2_000;

/** Reads the config file. Servers with "disabled": true are left out. */
export async function loadMcpConfig(file: string): Promise<McpServerConfig[]> {
  const text = await readFile(file, 'utf8');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseMcpConfig(data, dirname(resolve(file)), file);
}

export function parseMcpConfig(data: unknown, baseDir: string, origin = 'MCP config'): McpServerConfig[] {
  const servers = isRecord(data) ? (data.mcpServers ?? data.servers) : undefined;
  if (!isRecord(servers)) throw new Error(`${origin}: expected an object with "mcpServers".`);
  const configs: McpServerConfig[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    const where = `${origin}, server "${name}"`;
    if (!isRecord(entry)) throw new Error(`${where}: expected an object.`);
    if (entry.disabled === true) continue;
    if (!/^[\w-]+$/.test(name)) throw new Error(`${where}: use only letters, digits, "_" and "-" in server names.`);
    const config: McpServerConfig = { name, autoApprove: false };
    if (typeof entry.command === 'string') {
      config.command = entry.command;
      config.args = stringList(entry.args, `${where}, "args"`);
      if (entry.env !== undefined) config.env = expand(stringMap(entry.env, `${where}, "env"`));
      if (typeof entry.cwd === 'string') config.cwd = resolve(baseDir, entry.cwd);
    } else if (typeof entry.url === 'string') {
      config.url = entry.url;
      if (entry.headers !== undefined) config.headers = expand(stringMap(entry.headers, `${where}, "headers"`));
    } else {
      throw new Error(`${where}: needs "command" (local server) or "url" (remote server).`);
    }
    const type = entry.type ?? entry.transport;
    if (type !== undefined) {
      if (type === 'streamable-http' || type === 'streamableHttp') config.type = 'http';
      else if (type === 'stdio' || type === 'http' || type === 'sse') config.type = type;
      else throw new Error(`${where}: unknown "type" ${JSON.stringify(type)}.`);
    }
    if (entry.autoApprove === true) config.autoApprove = true;
    else if (entry.autoApprove !== undefined && entry.autoApprove !== false) {
      config.autoApprove = stringList(entry.autoApprove, `${where}, "autoApprove"`);
    }
    if (typeof entry.timeout === 'number' && entry.timeout > 0) config.timeoutMs = entry.timeout * 1000;
    configs.push(config);
  }
  return configs;
}

export interface McpConnection {
  name: string;
  tools: Tool[];
  close(): Promise<void>;
}

/**
 * Connects to one server and wraps its tools. Their names get the server name in
 * front ("fs.read_file"), so two servers cannot clash with each other or with native tools.
 */
export async function connectMcpServer(config: McpServerConfig, transport?: Transport): Promise<McpConnection> {
  const stderr: string[] = [];
  const client = new Client(CLIENT);
  const connection = transport ?? createTransport(config, stderr);
  try {
    await client.connect(connection, { timeout: CONNECT_TIMEOUT_MS });
  } catch (error) {
    await client.close().catch(() => undefined);
    const tail = stderr.join('').trim().slice(-STDERR_TAIL);
    throw new Error(`MCP server "${config.name}" did not start: ${message(error)}${tail ? `\n${tail}` : ''}`);
  }

  const tools: Tool[] = [];
  try {
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor === undefined ? {} : { cursor }, { timeout: CONNECT_TIMEOUT_MS });
      for (const tool of page.tools) tools.push(wrapTool(client, config, tool));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
  } catch (error) {
    await client.close().catch(() => undefined);
    throw new Error(`MCP server "${config.name}" did not list its tools: ${message(error)}`);
  }

  return { name: config.name, tools, close: () => client.close() };
}

/** Connects to every server; one that fails is reported and skipped. */
export async function connectMcpServers(
  configs: McpServerConfig[],
  warn: (message: string) => void,
): Promise<{ connections: McpConnection[]; close: () => Promise<void> }> {
  const settled = await Promise.allSettled(configs.map((config) => connectMcpServer(config)));
  const connections: McpConnection[] = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') connections.push(result.value);
    else warn(message(result.reason));
  }
  return {
    connections,
    close: async () => {
      await Promise.allSettled(connections.map((connection) => connection.close()));
    },
  };
}

function createTransport(config: McpServerConfig, stderr: string[]): Transport {
  if (config.command !== undefined) {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...getDefaultEnvironment(), ...config.env },
      cwd: config.cwd,
      // Kept for error messages instead of mixing the server's logs into the terminal.
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr.push(chunk.toString('utf8'));
      while (stderr.length > 1 && stderr.join('').length > STDERR_TAIL * 2) stderr.shift();
    });
    return transport;
  }
  const url = new URL(config.url ?? '');
  const requestInit = config.headers ? { headers: config.headers } : undefined;
  if (config.type === 'sse') return new SSEClientTransport(url, { requestInit });
  return new StreamableHTTPClientTransport(url, { requestInit });
}

interface ListedTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
}

function wrapTool(client: Client, config: McpServerConfig, tool: ListedTool): Tool {
  const trusted = config.autoApprove === true || (Array.isArray(config.autoApprove) && config.autoApprove.includes(tool.name));
  const name = `${config.name}.${tool.name}`;
  return {
    name,
    description: tool.description ?? tool.title ?? '',
    params: isRecord(tool.inputSchema) ? (tool.inputSchema as JsonSchema) : { type: 'object' },
    // The whole arguments, never a preview: the user approves exactly what is sent.
    approval: trusted ? undefined : (args) => ({ summary: `call ${name}`, detail: JSON.stringify(args, null, 2) }),
    async run(args, context) {
      const result = await client.callTool({ name: tool.name, arguments: args }, undefined, {
        timeout: config.timeoutMs ?? CALL_TIMEOUT_MS,
        signal: context.signal,
      });
      return toOutput(result);
    },
  };
}

/** Flattens an MCP result to text. Images and audio are described, not sent. */
export function toOutput(result: Record<string, unknown>): ToolOutput {
  const parts: string[] = [];
  const content = Array.isArray(result.content) ? (result.content as unknown[]) : [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    switch (item.type) {
      case 'text':
        parts.push(String(item.text ?? ''));
        break;
      case 'image':
      case 'audio': {
        const bytes = Math.floor((String(item.data ?? '').length * 3) / 4);
        parts.push(`[${item.type} ${String(item.mimeType ?? '')}, ${bytes} bytes, not shown]`);
        break;
      }
      case 'resource': {
        const resource = isRecord(item.resource) ? item.resource : {};
        parts.push(typeof resource.text === 'string' ? resource.text : `[resource ${String(resource.uri ?? '')}]`);
        break;
      }
      case 'resource_link':
        parts.push(`[resource ${String(item.uri ?? '')}${item.name ? ` (${String(item.name)})` : ''}]`);
        break;
      default:
        parts.push(JSON.stringify(item));
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent, null, 2));
  if (parts.length === 0 && 'toolResult' in result) parts.push(JSON.stringify(result.toolResult, null, 2));
  return { ok: result.isError !== true, text: parts.join('\n') };
}

function expand(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    out[key] = value.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? '');
  }
  return out;
}

function stringList(value: unknown, where: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${where}: expected a list of strings.`);
  }
  return value as string[];
}

function stringMap(value: unknown, where: string): Record<string, string> {
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== 'string')) {
    throw new Error(`${where}: expected an object of strings.`);
  }
  return value as Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
