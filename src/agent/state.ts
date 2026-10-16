import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ToolCall } from './protocol.js';
import type { AgentStatus } from './loop.js';
import { ToolError, type Tool, type ToolOutput } from '../tools/types.js';

/**
 * The task state: what the orchestrator knows about a task, kept outside the chat. The
 * web chat forgets (a new conversation, a context that ran out, a crash), so the state
 * lives here and goes back to the model in the rollover envelope. It is saved as
 * task-state.json in the session folder, next to transcript.jsonl, after every reply.
 *
 * Model-written parts (checklist, decisions) and results are capped, so the envelope
 * stays small whatever the model writes.
 */

export const TASK_STATE_FILE = 'task-state.json';
export const TASK_TOOL = 'update_task';

export const STATE_LIMITS = {
  goal: 20_000,
  steps: 40,
  step: 300,
  decisions: 20,
  decision: 400,
  files: 200,
  recent: 8,
  result: 300,
  rollovers: 50,
  answer: 4_000,
} as const;

/** Why a new conversation took over: the budget ran out, the model drifted, the provider said the chat is full. */
export type RolloverReason = 'budget' | 'drift' | 'limit';

export interface ChecklistItem {
  text: string;
  done: boolean;
}

/** One tool call, as short as the envelope needs it. */
export interface RecentCall {
  /** The reply it came from, counted over the whole task. */
  reply: number;
  /** "run_command npm test", "read_file src/app.py". */
  call: string;
  ok: boolean;
  /** The first and last lines of the result. */
  result: string;
}

export interface RolloverRecord {
  reason: RolloverReason;
  at: string;
  /** The conversation that took over, counted from 1 over the whole task. */
  chat: number;
  /** How full the previous one was, in characters. */
  chars: number;
}

export interface TaskState {
  version: 1;
  goal: string;
  /** The workspace the task ran in: a resume elsewhere is refused. */
  root: string;
  status: 'running' | AgentStatus;
  startedAt: string;
  updatedAt: string;
  /** Replies and tool calls over every run of the task. */
  iterations: number;
  toolCalls: number;
  /** 1, plus one for every resume. */
  runs: number;
  /** Conversations the task has used. */
  chats: number;
  rollovers: RolloverRecord[];
  checklist: ChecklistItem[];
  decisions: string[];
  /** Workspace paths, "/" separators, most recent last. */
  files: { read: string[]; changed: string[] };
  recent: RecentCall[];
  /** The last reply: the final answer once the task is done. */
  answer: string;
  /** The task-state.json this one was resumed from. */
  resumedFrom?: string;
}

export function newTaskState(goal: string, root: string, at: number): TaskState {
  const now = new Date(at).toISOString();
  return {
    version: 1,
    goal: cap(goal.trim(), STATE_LIMITS.goal),
    root: resolve(root),
    status: 'running',
    startedAt: now,
    updatedAt: now,
    iterations: 0,
    toolCalls: 0,
    runs: 1,
    chats: 1,
    rollovers: [],
    checklist: [],
    decisions: [],
    files: { read: [], changed: [] },
    recent: [],
    answer: '',
  };
}

/** A saved state, ready for another run. */
export function resumedState(saved: TaskState, at: number, from?: string): TaskState {
  const state: TaskState = structuredClone(saved);
  state.status = 'running';
  state.updatedAt = new Date(at).toISOString();
  state.runs += 1;
  state.chats += 1;
  if (from !== undefined) state.resumedFrom = from;
  return state;
}

/** Records what a tool call tells about the task: files read and changed, the latest results. */
export function noteCall(state: TaskState, reply: number, call: ToolCall, output: ToolOutput, root: string): void {
  const path = typeof call.args.path === 'string' ? workspacePath(call.args.path, root) : undefined;
  if (output.ok && path !== undefined) {
    if (call.tool === 'read_file') pushRecent(state.files.read, path, STATE_LIMITS.files);
    if (call.tool === 'write_file' || call.tool === 'edit_file') pushRecent(state.files.changed, path, STATE_LIMITS.files);
  }
  if (call.tool === TASK_TOOL) return; // its effect is the state itself
  pushCall(state, { reply, call: describeCall(call), ok: output.ok, result: shortResult(output.text) });
}

/** Records a call of the last reply that never ran because the task stopped, so a resume knows to send it again. */
export function notePending(state: TaskState, reply: number, call: ToolCall, why: string): void {
  pushCall(state, { reply, call: describeCall(call), ok: false, result: cap(`Not run: ${why}`, STATE_LIMITS.result) });
}

function pushCall(state: TaskState, recent: RecentCall): void {
  state.recent.push(recent);
  if (state.recent.length > STATE_LIMITS.recent) state.recent.splice(0, state.recent.length - STATE_LIMITS.recent);
}

/** "edit_file src/app.py", "run_command npm test": the tool and what it worked on, on one line. */
export function describeCall(call: ToolCall): string {
  const { path, command } = call.args;
  const first = Object.values(call.args).find((value): value is string => typeof value === 'string');
  const what = typeof path === 'string' ? path : typeof command === 'string' ? command : first ?? call.body ?? '';
  const line = (what.split('\n').find((part) => part.trim() !== '') ?? '').trim();
  return cap(`${call.tool}${line === '' ? '' : ` ${line}`}`, 160);
}

/** The first and last lines of a result, within STATE_LIMITS.result characters. */
export function shortResult(text: string): string {
  const lines = text.trim().split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) return '';
  const first = lines[0] ?? '';
  const last = lines.at(-1) ?? '';
  const joined = lines.length <= 2 ? lines.join(' / ') : `${first} / … / ${last}`;
  return cap(joined, STATE_LIMITS.result);
}

/**
 * A path the model gave, as the state lists it: relative to the workspace, "/"
 * separators, no "./". It is resolved the way the path policy resolves it (nothing
 * trimmed; a backslash separates folders on Windows only), so the read-before-edit
 * gate never takes one file for another. Only for bookkeeping: the policy checks the
 * real access. A path outside the workspace stays absolute.
 */
export function workspacePath(input: string, root: string): string {
  const base = resolve(root);
  const target = resolve(base, input);
  const inside = relative(base, target);
  const outside = inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside);
  const path = outside ? target : inside;
  const shown = sep === '\\' ? path.replace(/\\/g, '/') : path;
  return shown === '' ? '.' : shown;
}

/** Parses "- [x] step" lines. Plain lines and "- step" count as steps not done yet. */
export function parseChecklist(text: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    const match = /^(?:[-*+]|\d+[.)])?\s*(?:\[([ xX✓✔-]?)\])?\s*(.*)$/.exec(line);
    const step = (match?.[2] ?? line).trim();
    if (step === '') continue;
    items.push({ text: cap(step, STATE_LIMITS.step), done: /[xX✓✔]/.test(match?.[1] ?? '') });
    if (items.length >= STATE_LIMITS.steps) break;
  }
  return items;
}

/**
 * The tool that lets the model keep its plan and decisions in the state. It touches
 * nothing but the state, so it needs no approval; it still goes through a Toolbox, so
 * its arguments are checked like any other call's.
 */
export function taskTool(current: () => TaskState | undefined): Tool {
  return {
    name: TASK_TOOL,
    description:
      'Keeps your plan and your decisions outside the chat. If this conversation has to start over, the runner ' +
      'gives them back to you with the files you read and changed. After the JSON line, write the whole checklist, ' +
      'one step per line: "- [ ] step", or "- [x] step" once done. It replaces the previous checklist.',
    params: {
      type: 'object',
      properties: {
        checklist: { type: 'string', description: 'The whole checklist, one "- [ ] step" per line.' },
        decision: { type: 'string', description: 'One line to remember: a choice you made and why.' },
      },
    },
    body: 'checklist',
    async run(args) {
      const state = current();
      if (!state) throw new ToolError('No task is running.');
      const checklist = typeof args.checklist === 'string' ? parseChecklist(args.checklist) : undefined;
      const decision = typeof args.decision === 'string' ? args.decision.replace(/\s+/g, ' ').trim() : '';
      if (checklist === undefined && decision === '') {
        throw new ToolError('Nothing to save: write the checklist after the JSON line, or give a "decision".');
      }
      if (checklist !== undefined) state.checklist = checklist;
      if (decision !== '') {
        state.decisions.push(cap(decision, STATE_LIMITS.decision));
        if (state.decisions.length > STATE_LIMITS.decisions) state.decisions.splice(0, state.decisions.length - STATE_LIMITS.decisions);
      }
      const done = state.checklist.filter((item) => item.done).length;
      return {
        ok: true,
        text: `Saved: ${done} of ${state.checklist.length} steps done, ${state.decisions.length} decision${state.decisions.length === 1 ? '' : 's'}.`,
      };
    },
  };
}

export function recordRollover(state: TaskState, record: RolloverRecord): void {
  state.chats = record.chat;
  state.rollovers.push(record);
  if (state.rollovers.length > STATE_LIMITS.rollovers) state.rollovers.splice(0, state.rollovers.length - STATE_LIMITS.rollovers);
}

/** Writes task-state.json in dir: a temporary file, then a rename, so a crash never leaves half a file. */
export async function saveTaskState(dir: string, state: TaskState): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, TASK_STATE_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  const data = `${JSON.stringify(state, null, 2)}\n`;
  await writeFile(temporary, data, { mode: 0o600 });
  try {
    await rename(temporary, file);
  } catch {
    // Windows refuses the rename while something (an antivirus, a sync client) holds the target.
    await writeFile(file, data, { mode: 0o600 });
    await unlink(temporary).catch(() => undefined);
  }
  return file;
}

/** Reads a saved state from a task-state.json file or from the session folder that holds one. */
export async function loadTaskState(path: string): Promise<{ state: TaskState; file: string }> {
  const file = (await stat(path)).isDirectory() ? join(path, TASK_STATE_FILE) : path;
  let data: unknown;
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file}: not a task state (${error instanceof Error ? error.message : String(error)}).`);
  }
  return { state: checkState(data, file), file };
}

/** The most recently updated task-state.json under <data-dir>/sessions, if any. */
export async function findLatestTaskState(sessionsDir: string): Promise<string | undefined> {
  let names: string[];
  try {
    names = await readdir(sessionsDir);
  } catch {
    return undefined;
  }
  let best: { file: string; at: number } | undefined;
  for (const name of names) {
    const file = join(sessionsDir, name, TASK_STATE_FILE);
    const info = await stat(file).catch(() => undefined);
    if (info?.isFile() && (best === undefined || info.mtimeMs > best.at)) best = { file, at: info.mtimeMs };
  }
  return best?.file;
}

const STATUSES: readonly TaskState['status'][] = ['running', 'done', 'max_iterations', 'timeout', 'filtered', 'aborted', 'failed'];

/** Checks the shape of a saved state: it comes from disk, so nothing is taken on trust. */
function checkState(data: unknown, file: string): TaskState {
  const fail = (what: string): never => {
    throw new Error(`${file}: not a task state this version can resume (${what}).`);
  };
  if (!isRecord(data)) return fail('not an object');
  if (data.version !== 1) fail(`version ${String(data.version)}`);
  const text = (key: string): string => (typeof data[key] === 'string' ? (data[key] as string) : fail(`"${key}" is missing`));
  const count = (key: string): number =>
    typeof data[key] === 'number' && Number.isInteger(data[key]) && (data[key] as number) >= 0
      ? (data[key] as number)
      : fail(`"${key}" must be a count`);
  const strings = (value: unknown, key: string, max: number, limit: number): string[] =>
    Array.isArray(value) && value.every((item) => typeof item === 'string')
      ? value.slice(-limit).map((item: string) => cap(item, max))
      : fail(`"${key}" must be a list of strings`);
  const files = isRecord(data.files) ? data.files : fail('"files" is missing');
  const checklist = Array.isArray(data.checklist) ? data.checklist : fail('"checklist" is missing');
  const recent = Array.isArray(data.recent) ? data.recent : fail('"recent" is missing');
  const rollovers = Array.isArray(data.rollovers) ? data.rollovers : [];
  const goal = text('goal');
  if (goal.trim() === '') fail('the goal is empty');
  const status = STATUSES.find((known) => known === data.status) ?? fail(`unknown status ${JSON.stringify(data.status)}`);
  const state: TaskState = {
    version: 1,
    goal: cap(goal, STATE_LIMITS.goal),
    root: text('root'),
    status,
    startedAt: text('startedAt'),
    updatedAt: text('updatedAt'),
    iterations: count('iterations'),
    toolCalls: count('toolCalls'),
    runs: count('runs'),
    chats: count('chats'),
    rollovers: rollovers.filter(isRecord).slice(-STATE_LIMITS.rollovers).map((item) => ({
      reason: (['budget', 'drift', 'limit'] as const).find((reason) => reason === item.reason) ?? 'budget',
      at: typeof item.at === 'string' ? item.at : '',
      chat: typeof item.chat === 'number' ? item.chat : 0,
      chars: typeof item.chars === 'number' ? item.chars : 0,
    })),
    checklist: checklist
      .filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.text === 'string')
      .slice(0, STATE_LIMITS.steps)
      .map((item) => ({ text: cap(String(item.text), STATE_LIMITS.step), done: item.done === true })),
    decisions: strings(data.decisions, 'decisions', STATE_LIMITS.decision, STATE_LIMITS.decisions),
    files: {
      read: strings(files.read, 'files.read', 1_000, STATE_LIMITS.files),
      changed: strings(files.changed, 'files.changed', 1_000, STATE_LIMITS.files),
    },
    recent: recent
      .filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.call === 'string')
      .slice(-STATE_LIMITS.recent)
      .map((item) => ({
        reply: typeof item.reply === 'number' ? item.reply : 0,
        call: cap(String(item.call), 160),
        ok: item.ok === true,
        result: cap(typeof item.result === 'string' ? item.result : '', STATE_LIMITS.result),
      })),
    answer: typeof data.answer === 'string' ? cap(data.answer, STATE_LIMITS.answer) : '',
  };
  if (typeof data.resumedFrom === 'string') state.resumedFrom = data.resumedFrom;
  return state;
}

function pushRecent(list: string[], item: string, limit: number): void {
  const at = list.indexOf(item);
  if (at >= 0) list.splice(at, 1);
  list.push(item);
  if (list.length > limit) list.splice(0, list.length - limit);
}

export function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
