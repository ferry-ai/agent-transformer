import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';

/**
 * Pinned MCP tool definitions. The user chose the servers, but what a server says
 * about its tools is untrusted text that reaches the model, and a server can change
 * it at any time (an update, a compromised package, a remote server). The first time
 * a server is seen, a hash of each tool's definition is stored in the data dir; when
 * they change, the agent warns and asks before every call to that server, auto-approved
 * tools included, until the user accepts the new definitions.
 */

/** What a server says about one of its tools. */
export interface ToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}

export interface ServerPin {
  /** What runs: the command line or the URL (never the env or headers, which hold tokens). */
  target: string;
  /** Tool name to the hash of its definition. */
  tools: Record<string, string>;
  acceptedAt: string;
}

export interface Pins {
  version: 1;
  servers: Record<string, ServerPin>;
}

export interface PinCheck {
  state: 'new' | 'same' | 'changed';
  added: string[];
  removed: string[];
  changed: string[];
  /** The command or URL changed. */
  target?: { before: string; now: string };
}

export function pinOf(target: string, tools: ToolDefinition[]): ServerPin {
  const hashes: Record<string, string> = {};
  for (const tool of tools) hashes[tool.name] = hashDefinition(tool);
  return { target, tools: hashes, acceptedAt: new Date().toISOString() };
}

export function hashDefinition(tool: ToolDefinition): string {
  const { name, title, description, inputSchema, outputSchema, annotations } = tool;
  return createHash('sha256').update(canonical({ name, title, description, inputSchema, outputSchema, annotations })).digest('hex');
}

export function comparePin(pinned: ServerPin | undefined, now: ServerPin): PinCheck {
  if (pinned === undefined) return { state: 'new', added: Object.keys(now.tools), removed: [], changed: [] };
  const added = Object.keys(now.tools).filter((name) => !(name in pinned.tools));
  const removed = Object.keys(pinned.tools).filter((name) => !(name in now.tools));
  const changed = Object.keys(now.tools).filter((name) => name in pinned.tools && pinned.tools[name] !== now.tools[name]);
  const check: PinCheck = { state: 'same', added, removed, changed };
  if (pinned.target !== now.target) check.target = { before: pinned.target, now: now.target };
  if (added.length + removed.length + changed.length > 0 || check.target) check.state = 'changed';
  return check;
}

export async function loadPins(file: string): Promise<Pins> {
  const text = await readFile(file, 'utf8').catch(() => undefined);
  if (text === undefined) return { version: 1, servers: {} };
  try {
    const data = JSON.parse(text) as Partial<Pins>;
    if (data.version === 1 && typeof data.servers === 'object' && data.servers !== null) return { version: 1, servers: data.servers };
  } catch {
    // A broken file trusts nothing: every server shows as new or changed.
  }
  return { version: 1, servers: {} };
}

/** Written 0600 and renamed into place, so a crash never leaves half a file. */
export async function savePins(file: string, pins: Pins): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(pins, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

/** JSON with sorted keys: the same definition always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
