import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Agent, type AgentEvent, type AgentResult } from './agent/loop.js';
import { createApprover } from './approval-prompt.js';
import { proseOf, type ToolCall } from './agent/protocol.js';
import { AdapterError, type ChatAdapter } from './core/adapter.js';
import { Transcript } from './core/transcript.js';
import { connectMcpServers, loadMcpConfig, type McpConnection } from './tools/mcp.js';
import { nativeTools } from './tools/native.js';
import { Toolbox } from './tools/toolbox.js';
import { checkWorkspace } from './tools/workspace.js';
import type { ToolOutput } from './tools/types.js';
import { dim, errorMessage, green, red, safe, safeLine, ticker, tty, yellow } from './term.js';

export interface AgentCliOptions {
  adapter: ChatAdapter;
  /** Who is answering, for the progress line ("DeepSeek"). */
  label: string;
  dataDir: string;
  workspace: string;
  /** MCP config given with --mcp; otherwise <data-dir>/mcp.json is used when it exists. */
  mcpConfig?: string;
  maxIterations: number;
  maxMinutes: number;
  confirmWrites: boolean;
  /** Environment variables commands get on top of the basics. */
  passEnv: string[];
  showThinking: boolean;
  /** Run this one task and exit. Without it, tasks are read from the prompt. */
  task?: string;
}

const COMMANDS = `Commands:
  /new      start a new chat (the model forgets the previous tasks)
  /tools    list the tools the model can call
  """       start or end a task on several lines
  /help     show this list
  /quit     exit
Ctrl+C while a task runs stops it after the current step; pressed again, it quits.`;

type Ask = (prompt: string) => Promise<string | null>;

export async function runAgentCli(options: AgentCliOptions): Promise<void> {
  const { adapter } = options;
  // Before anything else: the agent never starts on the filesystem root, the home folder or the data dir.
  for (const warning of await checkWorkspace(options.workspace, { dataDir: options.dataDir })) console.log(yellow(`⚠ ${warning}`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const closed = new Promise<null>((done) => rl.once('close', () => done(null)));
  const ask: Ask = (prompt) => Promise.race([rl.question(prompt).catch(() => null), closed]);
  let running: AbortController | undefined;
  rl.on('SIGINT', () => {
    if (running && !running.signal.aborted) {
      running.abort();
      console.log(dim('\nStopping after the current step. Ctrl+C again to quit.'));
      return;
    }
    rl.close();
    void adapter.close();
  });

  // Fail closed: a piped stdin could answer "y" to a prompt nobody sees.
  const approve = createApprover({
    ask,
    print: (text) => console.log(text),
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    color: tty,
  });

  let mcp: { connections: McpConnection[]; close: () => Promise<void> } = { connections: [], close: async () => undefined };
  try {
    const mcpFile = options.mcpConfig ?? defaultMcpConfig(options.dataDir);
    if (mcpFile !== undefined) {
      mcp = await connectMcpServers(await loadMcpConfig(mcpFile), (message) => console.log(red(`✖ ${message}`)));
      for (const connection of mcp.connections) {
        console.log(dim(`MCP ${connection.name}: ${connection.tools.length} tools`));
      }
    }
    const toolbox = new Toolbox(
      [
        ...nativeTools({
          root: options.workspace,
          dataDir: options.dataDir,
          confirmWrites: options.confirmWrites,
          passEnv: options.passEnv,
        }),
        ...mcp.connections.flatMap((connection) => connection.tools),
      ],
      { approve },
    );

    await adapter.open();
    const transcript = await Transcript.create(options.dataDir, adapter.name);
    const progress = printer(options.label, options.showThinking, (name) => toolbox.has(name));
    const agent = new Agent({
      adapter,
      toolbox,
      root: options.workspace,
      maxIterations: options.maxIterations,
      maxDurationMs: options.maxMinutes * 60_000,
      transcript,
      onEvent: progress.onEvent,
    });
    console.log(dim(`Workspace: ${options.workspace}`));
    console.log(dim(`Session log: ${transcript.dir}`));

    const runTask = async (task: string): Promise<AgentResult> => {
      running = new AbortController();
      const started = Date.now();
      try {
        const result = await agent.run(task, running.signal);
        progress.stop();
        if (result.error instanceof AdapterError && result.error.kind === 'closed') throw result.error;
        printResult(result, Date.now() - started, options);
        return result;
      } finally {
        progress.stop();
        running = undefined;
      }
    };

    if (options.task !== undefined) {
      const result = await runTask(options.task);
      if (result.status !== 'done') process.exitCode = 1;
      return;
    }

    console.log(dim('Ready. Describe a task, or /help for the commands.'));
    for (;;) {
      const line = await ask('task> ');
      if (line === null) break;
      const input = line.trim();
      if (input === '') continue;
      if (input === '/quit' || input === '/exit') break;
      if (input === '/help') {
        console.log(COMMANDS);
        continue;
      }
      if (input === '/tools') {
        console.log(toolbox.list().map((tool) => `  ${safeLine(tool.name)}`).join('\n'));
        continue;
      }
      if (input === '/new') {
        try {
          await adapter.newChat();
          agent.reset();
          await transcript.event('new_chat');
          console.log(dim('New chat.'));
        } catch (error) {
          if (error instanceof AdapterError && error.kind === 'closed') throw error;
          console.log(red(`✖ ${errorMessage(error)}`));
        }
        continue;
      }
      if (input.startsWith('/')) {
        console.log(dim('Unknown command: /help lists them.'));
        continue;
      }
      const task = input === '"""' ? await readBlock(ask) : line;
      if (task === null) break;
      if (task.trim() !== '') await runTask(task);
    }
  } finally {
    rl.close();
    await mcp.close();
    await adapter.close();
  }
}

function defaultMcpConfig(dataDir: string): string | undefined {
  const file = join(dataDir, 'mcp.json');
  return existsSync(file) ? file : undefined;
}

async function readBlock(ask: Ask): Promise<string | null> {
  const lines: string[] = [];
  for (;;) {
    const line = await ask('… ');
    if (line === null) return null;
    if (line.trim() === '"""') return lines.join('\n');
    lines.push(line);
  }
}

/** Prints the agent's progress: what the model says, each call and a line of its result. */
function printer(label: string, showThinking: boolean, isTool: (name: string) => boolean) {
  let stopTicker = (): void => undefined;
  const stop = (): void => {
    stopTicker();
    stopTicker = () => undefined;
  };
  const onEvent = (event: AgentEvent): void => {
    switch (event.type) {
      case 'waiting':
        stop();
        stopTicker = ticker(`${label} is answering (reply ${event.iteration})`);
        break;
      case 'reply': {
        stop();
        if (showThinking && event.reply.thinking) console.log(dim(event.reply.thinking));
        const prose = proseOf(event.reply.text, { isTool });
        if (prose !== '') console.log(`\n${safe(prose)}\n`);
        break;
      }
      case 'call':
        console.log(`→ ${describeCall(event.call)}`);
        break;
      case 'result':
        console.log(dim(`  ${event.output.ok ? '✓' : '✖'} ${summarize(event.output)}`));
        break;
      case 'malformed':
        console.log(red(`  ✖ block ${event.error.index}: ${event.error.message}`));
        break;
      case 'retry':
        stop();
        console.log(dim(`${event.error.message} Trying again in ${Math.round(event.delayMs / 1000)}s (${event.attempt}).`));
        break;
    }
  };
  return { onEvent, stop };
}

/** One line per call, for progress only: the approval prompt shows calls in full. */
function describeCall(call: ToolCall): string {
  const args = JSON.stringify(call.args);
  const shown = args === '{}' ? '' : ` ${args.length > 120 ? `${args.slice(0, 120)}…` : args}`;
  const lines = call.body === undefined ? 0 : call.body.split('\n').length - 1;
  return `${safeLine(call.tool + shown)}${lines > 0 ? dim(` + ${lines} line${lines === 1 ? '' : 's'}`) : ''}`;
}

function summarize(output: ToolOutput): string {
  const lines = output.text.split('\n');
  const first = lines[0] ?? '';
  const head = first.length > 100 ? `${first.slice(0, 100)}…` : first;
  return safeLine(lines.length > 1 ? `${head} (+${lines.length - 1} lines)` : head);
}

function printResult(result: AgentResult, durationMs: number, options: AgentCliOptions): void {
  const stats = `${result.iterations} replies · ${result.toolCalls} tool calls · ${Math.round(durationMs / 1000)}s`;
  switch (result.status) {
    case 'done':
      console.log(green(`✓ Done`) + dim(` (${stats})`));
      break;
    case 'max_iterations': {
      const pending = result.pending > 0 ? `; ${result.pending} tool calls left unrun` : '';
      console.log(yellow(`Stopped at the limit of ${options.maxIterations} replies${pending}.`) + dim(` (${stats}; --max-iterations)`));
      break;
    }
    case 'timeout':
      console.log(yellow(`Stopped: the ${options.maxMinutes}-minute limit ran out.`) + dim(` (${stats}; --max-minutes)`));
      break;
    case 'filtered':
      console.log(yellow(`${options.label} replaced the answer (content filter).`));
      break;
    case 'aborted':
      console.log(yellow('Stopped.') + dim(` (${stats})`));
      break;
    case 'failed':
      console.log(red(`✖ ${errorMessage(result.error)}`) + dim(` (${stats})`));
      break;
  }
}
