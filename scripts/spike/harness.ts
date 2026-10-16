/**
 * Runs the spike: the throwaway project in a workspace, then tasks through the real
 * agent loop (src/agent/loop.ts) with the real toolbox, built as src/agent-cli.ts
 * builds it (native tools, command runner, checkpoints, the terminal approver), until
 * the target number of cycles is reached. Every cycle is measured by SpikeMeter.
 *
 * The approver is the normal one: without a terminal it refuses every call that needs
 * approval (every run_command). It is only wrapped to count the refusals.
 */
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Agent, type AgentResult } from '../../src/agent/loop.js';
import type { ContextOptions } from '../../src/agent/context.js';
import { parseToolCalls } from '../../src/agent/protocol.js';
import { findLatestTaskState, loadTaskState, TASK_TOOL } from '../../src/agent/state.js';
import { createApprover } from '../../src/approval-prompt.js';
import { AdapterError, type ChatAdapter } from '../../src/core/adapter.js';
import { Transcript } from '../../src/core/transcript.js';
import { Checkpoints } from '../../src/tools/checkpoints.js';
import { nativeTools } from '../../src/tools/native.js';
import { onExit, processGroups } from '../../src/tools/processes.js';
import { createCommandRunner, DEFAULT_SANDBOX_IMAGE, type SandboxChoice } from '../../src/tools/sandbox.js';
import type { CommandRunner } from '../../src/tools/shell.js';
import { Toolbox } from '../../src/tools/toolbox.js';
import type { Approve } from '../../src/tools/types.js';
import { checkWorkspace } from '../../src/tools/workspace.js';
import { MeteredAdapter, SpikeMeter, totals, type CycleRecord, type SpikeTotals, type TaskRecord } from './meter.js';
import { TASKS, writeProject, type SpikeTask } from './project.js';

export interface SpikeOptions {
  /** An adapter that is already open. The caller closes it. */
  adapter: ChatAdapter;
  /** A fresh, empty folder: the project is written there. */
  workspace: string;
  /** A fresh folder for the session log, the task state and the checkpoints. Never the real data dir. */
  dataDir: string;
  /** Stop starting tasks once this many cycles are done. */
  cycles: number;
  tasks?: readonly SpikeTask[];
  /** Replies per task (--max-iterations). Default 8. */
  maxIterations?: number;
  maxMinutes?: number;
  context?: ContextOptions;
  /** Where commands would run. Default "auto", as in the CLI. */
  sandbox?: SandboxChoice;
  /** Per-cycle JSONL. */
  out?: string;
  /**
   * Stop the run when a task ends on an adapter error or a content filter: never push
   * on against a provider that refuses. Default true.
   */
  stopOnError?: boolean;
  /** Seconds to wait between two tasks (not between the cycles of a task). Default 0. */
  pauseSec?: number;
  /** Replaces the agent's wait between retries (tests and fake runs). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** What the run header says about the adapter. */
  label?: string;
  log?: (line: string) => void;
}

export interface SpikeSummary {
  cycles: CycleRecord[];
  tasks: TaskRecord[];
  totals: SpikeTotals;
  /** Why the run stopped before the target, if it did. */
  stopped?: string;
  sessionDir: string;
}

export async function runSpike(options: SpikeOptions): Promise<SpikeSummary> {
  const log = options.log ?? ((line: string) => console.log(line));
  const tasks = options.tasks ?? TASKS;
  await writeProject(options.workspace);
  for (const warning of await checkWorkspace(options.workspace, { dataDir: options.dataDir })) log(`warning: ${warning}`);

  // As in the CLI: approvals and the image download need a person at a terminal.
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const ask = async (prompt: string): Promise<string | null> => (rl ? rl.question(prompt).catch(() => null) : null);

  let runner: CommandRunner | undefined;
  const removeExitHandlers = onExit(() => {
    processGroups.killAll();
    runner?.closeSync();
  });
  let toolbox: Toolbox | undefined;
  const meter = new SpikeMeter({
    known: (name) => name === TASK_TOOL || toolbox?.has(name) === true,
    out: options.out,
    log,
  });
  try {
    runner = await createCommandRunner({
      choice: options.sandbox ?? 'auto',
      image: DEFAULT_SANDBOX_IMAGE,
      network: false,
      workspace: options.workspace,
      dataDir: options.dataDir,
      passEnv: [],
      confirm: async (question) => interactive && /^(y|yes|s|si|sì)$/i.test((await ask(`${question} [y/N] `))?.trim() ?? ''),
      notify: (message) => log(message),
    });
    const opened = await Checkpoints.open({ workspace: options.workspace, dataDir: options.dataDir });
    const checkpoints = opened instanceof Checkpoints ? opened : undefined;
    if (!checkpoints) log(`warning: checkpoints are off: ${(opened as { unavailable: string }).unavailable}`);

    const normal = createApprover({ ask, print: (text) => log(text), interactive, color: false });
    // Only counts: the decision is the normal approver's, untouched.
    const approve: Approve = async (request) => {
      const decision = await normal(request);
      meter.approval(decision.approved);
      return decision;
    };
    toolbox = new Toolbox(nativeTools({ root: options.workspace, dataDir: options.dataDir, confirmWrites: false, runner }), {
      approve,
      checkpoint: async (label) => {
        if (!checkpoints) return;
        try {
          const result = await checkpoints.snapshot(`before ${label}`);
          if (result.skipped) log(`warning: ${result.skipped}`);
        } catch (error) {
          log(`warning: no checkpoint: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    });

    let running: AbortController | undefined;
    let stopAt: string | undefined;
    const adapter = new MeteredAdapter(options.adapter, meter);
    const transcript = await Transcript.create(options.dataDir, adapter.name);
    const agent = new Agent({
      adapter,
      toolbox,
      root: options.workspace,
      maxIterations: options.maxIterations ?? 8,
      maxDurationMs: (options.maxMinutes ?? 30) * 60_000,
      transcript,
      onEvent: (event) => {
        meter.onEvent(event);
        // A task with stopAt: the user presses Ctrl+C as the first reply that calls that tool arrives, as in the CLI.
        if (event.type === 'reply' && stopAt !== undefined && calls(event.reply.text).includes(stopAt)) running?.abort();
      },
      ...(options.context === undefined ? {} : { context: options.context }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });
    meter.write({
      type: 'run',
      adapter: options.label ?? adapter.name,
      startedAt: new Date().toISOString(),
      target: options.cycles,
      maxIterations: options.maxIterations ?? 8,
      pauseSec: options.pauseSec ?? 0,
      context: options.context ?? {},
      sandbox: runner.where,
      interactive,
    });
    log(`Workspace: ${options.workspace}`);
    log(`Session log: ${transcript.dir}`);
    log(`Commands: ${runner.where}${interactive ? '' : ' (no terminal: every command is refused)'}`);

    let stopped: string | undefined;
    for (const [i, task] of tasks.entries()) {
      if (meter.cycles.length >= options.cycles) break;
      if (i > 0 && (options.pauseSec ?? 0) > 0) await new Promise((done) => setTimeout(done, (options.pauseSec ?? 0) * 1000));
      meter.startTask(i + 1, task.id);
      log(`task ${i + 1} (${task.id}): ${task.prompt}`);
      running = new AbortController();
      stopAt = task.stopAt;
      let result: AgentResult;
      try {
        if (task.resume) {
          // As /resume does: the latest task state saved for this workspace, read back from disk.
          const file = await findLatestTaskState(join(options.dataDir, 'sessions'), options.workspace);
          if (file === undefined) throw new Error('No saved task of this workspace to resume.');
          const saved = await loadTaskState(file);
          result = await agent.resume(saved.state, running.signal, saved.file);
        } else {
          result = await agent.run(task.prompt, running.signal);
        }
      } catch (error) {
        // The loop turns adapter errors into a failed result; anything thrown is a bug worth a stop.
        result = { status: 'failed', answer: '', iterations: 0, toolCalls: 0, pending: 0, error };
      }
      const planned = task.stopAt !== undefined && result.status === 'aborted';
      const problem = await task.check(options.workspace, result).catch((error: unknown) => `check failed: ${String(error)}`);
      const record = meter.endTask(result, problem ?? 'pass', planned);
      log(`task ${i + 1} (${task.id}): ${record.status}, ${record.iterations} replies, ${record.toolCalls} tool calls, check ${record.check}`);
      if ((options.stopOnError ?? true) && !planned && stopsTheRun(result)) {
        stopped = `task ${i + 1} (${task.id}) ended ${result.status}${record.error ? `: ${record.error}` : ''}`;
        break;
      }
    }
    if (stopped === undefined && meter.cycles.length < options.cycles) stopped = `the tasks ran out after ${meter.cycles.length} cycles`;
    const summary = totals(meter.cycles, meter.tasks);
    meter.write({ type: 'summary', finishedAt: new Date().toISOString(), ...(stopped ? { stopped } : {}), totals: summary });
    await meter.flush();
    return { cycles: meter.cycles, tasks: meter.tasks, totals: summary, ...(stopped ? { stopped } : {}), sessionDir: transcript.dir };
  } finally {
    await meter.flush().catch(() => undefined);
    rl?.close();
    processGroups.killAll();
    await runner?.close();
    removeExitHandlers();
  }
}

/** The tools a reply calls, as the agent reads them. */
function calls(text: string): string[] {
  return parseToolCalls(text, { isTool: () => true }).flatMap((block) => (block.kind === 'call' ? [block.call.tool] : []));
}

/** A task that ended on the provider's side (an adapter error, the content filter): going on would push against it. */
export function stopsTheRun(result: AgentResult): boolean {
  if (result.status === 'filtered' || result.status === 'aborted') return true;
  if (result.status !== 'failed') return false;
  return result.error instanceof AdapterError || !(result.error instanceof Error && /malformed tool calls/.test(result.error.message));
}
