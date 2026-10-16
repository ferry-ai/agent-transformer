import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Agent, type AgentEvent, type AgentResult } from './agent/loop.js';
import { createApprover } from './approval-prompt.js';
import { McpReview } from './mcp-review.js';
import { proseOf, type ToolCall } from './agent/protocol.js';
import { AdapterError, type ChatAdapter } from './core/adapter.js';
import { Transcript } from './core/transcript.js';
import { Checkpoints, type UndoPlan } from './tools/checkpoints.js';
import { connectMcpServers, loadMcpConfig, type McpConnection } from './tools/mcp.js';
import { nativeTools } from './tools/native.js';
import { onExit, processGroups } from './tools/processes.js';
import { createCommandRunner, type SandboxChoice } from './tools/sandbox.js';
import type { CommandRunner } from './tools/shell.js';
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
  sandbox: SandboxChoice;
  sandboxImage: string;
  sandboxNetwork: boolean;
  showThinking: boolean;
  /** Run this one task and exit. Without it, tasks are read from the prompt. */
  task?: string;
  /**
   * For an adapter that reads the terminal while it waits for a reply (--adapter clipboard):
   * gets this readline, so both share stdin. No "is answering" ticker is drawn then.
   */
  attachInput?: (rl: ReturnType<typeof createInterface>) => void;
}

const COMMANDS = `Commands:
  /new          start a new chat (the model forgets the previous tasks)
  /tools        list the tools the model can call
  /undo         put the workspace back as it was before the last change (asks first)
  /checkpoints  list the snapshots taken before each change
  /mcp          list the MCP servers, their tools and which run without asking
  /mcp accept <server>  accept a server's changed tool definitions
  """           start or end a task on several lines
  /help         show this list
  /quit         exit
Ctrl+C while a task runs stops it after the current step; pressed again, it quits.`;

type Ask = (prompt: string) => Promise<string | null>;

export async function runAgentCli(options: AgentCliOptions): Promise<void> {
  const { adapter } = options;
  // Before anything else: the agent never starts on the filesystem root, the home folder or the data dir.
  for (const warning of await checkWorkspace(options.workspace, { dataDir: options.dataDir })) console.log(yellow(`⚠ ${warning}`));
  // What commands leave running dies with the agent: on exit, on a crash, on SIGINT, SIGTERM or SIGHUP.
  let runner: CommandRunner | undefined;
  const removeExitHandlers = onExit(() => {
    processGroups.killAll();
    runner?.closeSync();
  });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  options.attachInput?.(rl);
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
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const approve = createApprover({ ask, print: (text) => console.log(text), interactive, color: tty });

  let mcp: { connections: McpConnection[]; close: () => Promise<void> } = { connections: [], close: async () => undefined };
  try {
    await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
    runner = await createCommandRunner({
      choice: options.sandbox,
      image: options.sandboxImage,
      network: options.sandboxNetwork,
      workspace: options.workspace,
      dataDir: options.dataDir,
      passEnv: options.passEnv,
      confirm: async (question) => {
        if (!interactive) return false;
        return /^(y|yes|s|si|sì)$/i.test((await ask(`${question} [y/N] `))?.trim() ?? '');
      },
      notify: (message) => console.log(yellow(message)),
    });
    const opened = await Checkpoints.open({ workspace: options.workspace, dataDir: options.dataDir });
    const checkpoints = opened instanceof Checkpoints ? opened : undefined;
    if (!(opened instanceof Checkpoints)) console.log(yellow(`⚠ Checkpoints are off: ${opened.unavailable}. /undo will not work.`));
    const mcpFile = options.mcpConfig ?? defaultMcpConfig(options.dataDir);
    if (mcpFile !== undefined) {
      mcp = await connectMcpServers(await loadMcpConfig(mcpFile), (message) => console.log(red(`✖ ${message}`)));
    }
    const mcpReview = new McpReview(mcp.connections, join(options.dataDir, 'mcp-tools.json'), {
      print: (text) => console.log(dim(text)),
      warn: (text) => console.log(red(text)),
      confirm: async (question) => interactive && /^(y|yes|s|si|sì)$/i.test((await ask(`${question} [y/N] `))?.trim() ?? ''),
    });
    await mcpReview.start();
    const toolbox = new Toolbox(
      [
        ...nativeTools({
          root: options.workspace,
          dataDir: options.dataDir,
          confirmWrites: options.confirmWrites,
          runner,
        }),
        ...mcp.connections.flatMap((connection) => connection.tools),
      ],
      {
        approve,
        checkpoint: async (label) => {
          if (!checkpoints) return;
          try {
            const result = await checkpoints.snapshot(`before ${label}`);
            if (result.skipped) console.log(yellow(`⚠ ${result.skipped}`));
          } catch (error) {
            console.log(yellow(`⚠ No checkpoint: ${errorMessage(error)}`));
          }
        },
      },
    );

    await adapter.open();
    const transcript = await Transcript.create(options.dataDir, adapter.name);
    const progress = printer(options.attachInput ? undefined : options.label, options.showThinking, (name) => toolbox.has(name));
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
    console.log((runner.warnings.length > 0 ? red : dim)(`Commands: ${runner.where}`));
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
      if (input === '/mcp') {
        mcpReview.list();
        continue;
      }
      if (input.startsWith('/mcp accept ')) {
        await mcpReview.accept(input.slice('/mcp accept '.length).trim());
        continue;
      }
      if (input === '/undo') {
        await undo(checkpoints, ask, interactive);
        continue;
      }
      if (input === '/checkpoints') {
        const list = (await checkpoints?.list()) ?? [];
        if (!checkpoints) console.log(dim('Checkpoints are off.'));
        else if (list.length === 0) console.log(dim('No checkpoints yet: one is taken before each change.'));
        else {
          for (const [i, checkpoint] of list.entries()) {
            const next = i === 0 ? dim('  ← /undo goes back to here') : '';
            console.log(`  ${checkpoint.at.toLocaleString()}  ${safeLine(checkpoint.label)}${next}`);
          }
        }
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
    processGroups.killAll();
    await runner?.close();
    removeExitHandlers();
    await mcp.close();
    await adapter.close();
  }
}

/** Shows what /undo would restore and remove, and does it after a yes typed on a terminal. */
async function undo(checkpoints: Checkpoints | undefined, ask: Ask, interactive: boolean): Promise<void> {
  if (!checkpoints) {
    console.log(dim('Checkpoints are off: there is nothing to undo.'));
    return;
  }
  let plan: UndoPlan | undefined;
  try {
    plan = await checkpoints.planUndo();
  } catch (error) {
    console.log(red(`✖ ${errorMessage(error)}`));
    return;
  }
  if (!plan) {
    console.log(dim('Nothing to undo: the workspace matches the checkpoints.'));
    return;
  }
  console.log(`/undo goes back to ${plan.checkpoint.at.toLocaleString()}, ${safeLine(plan.checkpoint.label)}:`);
  const lines = [...plan.restore.map((path) => `  restore ${safeLine(path)}`), ...plan.remove.map((path) => `  remove  ${safeLine(path)}`)];
  console.log(lines.slice(0, 40).join('\n') + (lines.length > 40 ? dim(`\n  … and ${lines.length - 40} more`) : ''));
  if (!interactive) {
    console.log(dim('Not done: /undo needs a yes typed on a terminal.'));
    return;
  }
  const answer = (await ask('Go ahead? [y/N] '))?.trim() ?? '';
  if (!/^(y|yes|s|si|sì)$/i.test(answer)) return;
  try {
    const result = await checkpoints.undo(plan);
    console.log(green(`✓ Restored ${result.restored} file${result.restored === 1 ? '' : 's'}, removed ${result.removed}.`));
    for (const path of result.skipped) console.log(yellow(`⚠ Left in place (its folder is not where it was): ${safeLine(path)}`));
  } catch (error) {
    console.log(red(`✖ ${errorMessage(error)}`));
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
function printer(label: string | undefined, showThinking: boolean, isTool: (name: string) => boolean) {
  let stopTicker = (): void => undefined;
  const stop = (): void => {
    stopTicker();
    stopTicker = () => undefined;
  };
  const onEvent = (event: AgentEvent): void => {
    switch (event.type) {
      case 'waiting':
        stop();
        if (label !== undefined) stopTicker = ticker(`${label} is answering (reply ${event.iteration})`);
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
