/**
 * Counts what happens in each agent cycle. A cycle is one model reply plus its tool
 * round: it opens when the agent sends the message for a new reply (the 'waiting'
 * event of a new iteration) and closes when the next one opens or the task ends.
 * Retries of the same message (busy, an unreadable reply, a failed upload, a provider
 * 'limit' that rolled the chat over) stay in the cycle that finally got the reply.
 *
 * Three sources feed it, and none of them changes what the agent does:
 * - the agent's onEvent stream (replies, calls, results, malformed blocks, retries,
 *   drift, the read-before-edit gate, budget, summaries, rollovers, uploads off);
 * - MeteredAdapter, a pass-through ChatAdapter that times every send and sees every
 *   adapter error and every content-filtered reply (the agent stops on those without
 *   an event);
 * - the approver, wrapped to count refusals; the wrapped approver decides alone.
 */
import { appendFile } from 'node:fs/promises';
import type { AgentEvent, AgentResult } from '../../src/agent/loop.js';
import type { ToolCall } from '../../src/agent/protocol.js';
import { REPEAT_REQUEST } from '../../src/agent/prompt.js';
import { AdapterError, type ChatAdapter, type ChatReply, type SendOptions } from '../../src/core/adapter.js';

/** What a message sent to the model is, told from its text. */
export type PromptKind =
  | 'task'
  | 'follow-up'
  | 'results'
  | 'results+malformed'
  | 'repeat'
  | 'off-protocol'
  | 'envelope:budget'
  | 'envelope:drift'
  | 'envelope:limit'
  | 'envelope:resume'
  | 'other';

/** Messages that ask the model to redo something: an unreadable reply, a call outside the protocol, malformed blocks, drift. */
export const REASK_KINDS: ReadonlySet<PromptKind> = new Set(['repeat', 'off-protocol', 'results+malformed', 'envelope:drift']);

export function promptKind(message: string): PromptKind {
  if (message === REPEAT_REQUEST) return 'repeat';
  if (message.startsWith('Nothing was run: your reply has')) return 'off-protocol';
  if (message.includes('\n# Task state\n')) {
    if (message.includes('did not follow the tool protocol, so the runner moved the task')) return 'envelope:drift';
    if (message.includes('grew too long (')) return 'envelope:budget';
    if (message.includes("reached the provider's length limit")) return 'envelope:limit';
    return 'envelope:resume';
  }
  if (message.startsWith('New task from the user.')) return 'follow-up';
  if (message.startsWith('Tool results:')) {
    return /Some tool blocks were malformed: send them again, fixed\. Reply \d+ of \d+ used\.[^\n]*$/.test(message) ? 'results+malformed' : 'results';
  }
  if (message.includes('\n# Task\n')) return 'task';
  return 'other';
}

const TOOL_INFO = new Set(['tool', 'tool_call', 'tool-call', 'toolcall', 'tool_use']);

/**
 * True when the text ends inside a fenced code block: the reply was cut off. Fences
 * are read as the protocol parser reads them, nested ```lang blocks inside a tool
 * block included, so a long write_file body does not look cut.
 */
export function endsInsideFence(text: string): boolean {
  let open: { char: string; length: number; tolerant: boolean; nested: number } | undefined;
  for (const line of text.split(/\r?\n/)) {
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence) continue;
    const [, run = '', rest = ''] = fence;
    const char = run[0] ?? '`';
    if (open === undefined) {
      if (char === '`' && rest.includes('`')) continue; // ```inline``` on one line
      open = { char, length: run.length, tolerant: TOOL_INFO.has((rest.trim().split(/\s+/)[0] ?? '').toLowerCase()), nested: 0 };
      continue;
    }
    if (char !== open.char) continue;
    if (rest.trim() === '' && run.length >= open.length) {
      if (open.nested === 0) open = undefined;
      else open.nested -= 1;
    } else if (open.tolerant && rest.trim() !== '' && !rest.includes('`')) {
      open.nested += 1;
    }
  }
  return open !== undefined;
}

/** One send to the adapter. */
export interface Attempt {
  prompt: PromptKind;
  /** Characters of the message, and files attached to it. */
  chars: number;
  attachments: number;
  /** The conversation it went to, counted from 1 like the agent counts them. */
  chat: number;
  /** Wall time of the send, upload and wait for the reply included. */
  ms: number;
  /** The AdapterError kind, or "unexpected" for anything else thrown. */
  error?: string;
  message?: string;
}

export interface CycleRecord {
  type: 'cycle';
  /** Counted over the whole run, from 1. */
  cycle: number;
  /** The task (from 1) and the agent's reply number within it. */
  task: number;
  taskId: string;
  iteration: number;
  chat: number;
  /** What the cycle's first message was. */
  prompt: PromptKind;
  attempts: Attempt[];
  /** The adapter's own reply time (ChatReply.durationMs) of the reply that arrived. */
  replyMs?: number;
  /** Wall time in send() over all attempts, and of the whole cycle (tool round included). */
  sendMs: number;
  cycleMs: number;
  replyChars?: number;
  source?: 'network' | 'dom';
  /** Tool blocks parsed in the reply: valid calls plus malformed blocks. */
  blocks: number;
  calls: number;
  malformed: number;
  /** 1 when the reply was cut off: it ends inside a fenced block, or a tool block is not closed. */
  cutOff: number;
  unknownTools: number;
  /** Calls that ran, by tool (the read-before-edit gate's refusals excluded). */
  tools: Record<string, number>;
  /** Calls that ran and failed, refusals of the approver excluded. */
  toolFailures: number;
  /** Calls the approver refused (no terminal: every run_command). */
  denied: number;
  gated: number;
  /** Messages of this cycle that asked the model to redo something (see REASK_KINDS). */
  reasks: number;
  retries: number;
  drift: number;
  timeouts: number;
  filtered: boolean;
  /** Replies whose text was blank. */
  emptyReplies: number;
  /** Adapter errors, by kind. */
  errors: Record<string, number>;
  /** The last budget event: how full the chat was after this reply. */
  budget?: { chat: number; used: number; limit: number };
  summarized: number;
  /** Files attached to the message that got the reply. */
  attachments: number;
  attachmentsOff: boolean;
  /** This cycle's message opened a new chat. */
  rollover?: { reason: string; chat: number; used: number; limit: number };
  /** Calls of the reply left unrun because the task stopped. */
  pending: number;
  /** The task's status, when it ended in this cycle. */
  end?: string;
  error?: string;
  /** The agent could go on (or end normally) after this cycle. */
  holds: boolean;
  /** It held at the first try: no retry, no re-ask, no malformed, cut-off, blank or gated reply, no drift. */
  clean: boolean;
}

export interface TaskRecord {
  type: 'task';
  task: number;
  id: string;
  status: string;
  iterations: number;
  toolCalls: number;
  pending: number;
  firstCycle: number;
  lastCycle: number;
  ms: number;
  /** "pass", or what the check found wrong. */
  check: string;
  error?: string;
}

const BROKEN: ReadonlySet<string> = new Set(['failed', 'filtered', 'timeout', 'aborted']);

interface Open {
  record: CycleRecord;
  started: number;
  gated: Set<ToolCall>;
  /** The last reply that arrived was blank. */
  lastBlank: boolean;
}

export interface MeterOptions {
  /** Whether a tool name is one the agent offers (the toolbox's and update_task). */
  known: (name: string) => boolean;
  /** Where each record goes as a line of JSON, as soon as it is complete. */
  out?: string;
  /** Progress lines. */
  log?: (line: string) => void;
  now?: () => number;
}

export class SpikeMeter {
  readonly cycles: CycleRecord[] = [];
  readonly tasks: TaskRecord[] = [];
  private readonly options: MeterOptions;
  private readonly now: () => number;
  private open: Open | undefined;
  private task = { index: 0, id: '', started: 0, firstCycle: 0 };
  private chat = 1;
  private pendingRollover: CycleRecord['rollover'];
  private writing: Promise<void> = Promise.resolve();

  constructor(options: MeterOptions) {
    this.options = options;
    this.now = options.now ?? (() => performance.now());
  }

  /** Cycles completed or under way. */
  get count(): number {
    return this.cycles.length + (this.open ? 1 : 0);
  }

  /** Writes a record that is not a cycle or a task (the run header, the summary). */
  write(record: Record<string, unknown>): void {
    const { out } = this.options;
    if (out === undefined) return;
    const line = `${JSON.stringify(record)}\n`;
    this.writing = this.writing.then(() => appendFile(out, line));
  }

  async flush(): Promise<void> {
    await this.writing;
  }

  startTask(index: number, id: string): void {
    this.task = { index, id, started: this.now(), firstCycle: this.count + 1 };
  }

  endTask(result: AgentResult, check: string): TaskRecord {
    const open = this.open;
    if (open) {
      open.record.end = result.status;
      open.record.pending = result.pending;
      if (result.error !== undefined) open.record.error = describe(result.error);
      this.close();
    }
    const record: TaskRecord = {
      type: 'task',
      task: this.task.index,
      id: this.task.id,
      status: result.status,
      iterations: result.iterations,
      toolCalls: result.toolCalls,
      pending: result.pending,
      firstCycle: this.task.firstCycle,
      lastCycle: this.cycles.length,
      ms: Math.round(this.now() - this.task.started),
      check,
      ...(result.error === undefined ? {} : { error: describe(result.error) }),
    };
    this.tasks.push(record);
    this.write({ ...record });
    return record;
  }

  /** For the approver wrapper: one decision on a call that needed approval. */
  approval(approved: boolean): void {
    if (!approved) this.current().denied += 1;
  }

  newChat(): void {
    this.chat += 1;
  }

  /** For MeteredAdapter: one send, its reply or its error. */
  attempt(message: string, options: SendOptions | undefined, ms: number, outcome: { reply: ChatReply } | { error: unknown }): void {
    const record = this.current();
    const attempt: Attempt = {
      prompt: promptKind(message),
      chars: message.length,
      attachments: options?.attachments?.length ?? 0,
      chat: this.chat,
      ms: Math.round(ms),
    };
    record.chat = this.chat;
    record.sendMs += Math.round(ms);
    if ('reply' in outcome) {
      const { reply } = outcome;
      record.replyMs = reply.durationMs;
      record.replyChars = reply.text.length;
      record.source = reply.source;
      record.attachments = attempt.attachments;
      if (reply.filtered === true) record.filtered = true;
      if (reply.text.trim() === '') record.emptyReplies += 1;
    } else {
      const { error } = outcome;
      attempt.error = error instanceof AdapterError ? error.kind : 'unexpected';
      attempt.message = error instanceof Error ? error.message : String(error);
      record.errors[attempt.error] = (record.errors[attempt.error] ?? 0) + 1;
      if (attempt.error === 'timeout') record.timeouts += 1;
    }
    record.attempts.push(attempt);
    if ('reply' in outcome && this.open) this.open.lastBlank = outcome.reply.text.trim() === '';
  }

  readonly onEvent = (event: AgentEvent): void => {
    if (event.type === 'waiting') {
      this.waiting(event.iteration);
      return;
    }
    const record = this.current();
    switch (event.type) {
      case 'reply':
        record.calls = event.calls;
        record.blocks += event.calls;
        if (endsInsideFence(event.reply.text)) record.cutOff = 1;
        break;
      case 'malformed':
        record.malformed += 1;
        record.blocks += 1;
        if (/tool block is not closed/i.test(event.error.message)) record.cutOff = 1;
        break;
      case 'call':
        if (!this.options.known(event.call.tool)) record.unknownTools += 1;
        break;
      case 'gated':
        record.gated += 1;
        this.open?.gated.add(event.call);
        break;
      case 'result':
        if (this.open?.gated.has(event.call)) break;
        record.tools[event.call.tool] = (record.tools[event.call.tool] ?? 0) + 1;
        if (!event.output.ok && !/^The user did not allow this call\./.test(event.output.text) && this.options.known(event.call.tool)) {
          record.toolFailures += 1;
        }
        break;
      case 'retry':
        record.retries += 1;
        break;
      case 'drift':
        record.drift += 1;
        break;
      case 'budget':
        record.budget = { chat: event.chat, used: event.used, limit: event.limit };
        break;
      case 'summarized':
        record.summarized += 1;
        break;
      case 'rollover':
        // Shown on the cycle whose message goes to the new chat.
        this.pendingRollover = { reason: event.reason, chat: event.chat, used: event.used, limit: event.limit };
        break;
      case 'attachments_off':
        record.attachmentsOff = true;
        break;
      case 'resume':
        break;
    }
  };

  private waiting(iteration: number): void {
    const open = this.open;
    if (!open || open.record.task !== this.task.index || open.record.iteration !== iteration) {
      if (open) this.close();
      this.start(iteration);
    }
    if (this.pendingRollover && this.open) {
      this.open.record.rollover = this.pendingRollover;
      this.pendingRollover = undefined;
    }
  }

  /** The open cycle; one is opened if an event comes before any (it should not). */
  private current(): CycleRecord {
    if (!this.open) this.start(0);
    return (this.open as Open).record;
  }

  private start(iteration: number): void {
    const record: CycleRecord = {
      type: 'cycle',
      cycle: this.cycles.length + 1,
      task: this.task.index,
      taskId: this.task.id,
      iteration,
      chat: this.chat,
      prompt: 'other',
      attempts: [],
      sendMs: 0,
      cycleMs: 0,
      blocks: 0,
      calls: 0,
      malformed: 0,
      cutOff: 0,
      unknownTools: 0,
      tools: {},
      toolFailures: 0,
      denied: 0,
      gated: 0,
      reasks: 0,
      retries: 0,
      drift: 0,
      timeouts: 0,
      filtered: false,
      emptyReplies: 0,
      errors: {},
      summarized: 0,
      attachments: 0,
      attachmentsOff: false,
      pending: 0,
      holds: true,
      clean: true,
    };
    this.open = { record, started: this.now(), gated: new Set(), lastBlank: false };
  }

  private close(): void {
    const open = this.open;
    if (!open) return;
    this.open = undefined;
    const record = open.record;
    record.cycleMs = Math.round(this.now() - open.started);
    record.prompt = record.attempts[0]?.prompt ?? 'other';
    // A re-ask is the cycle's own message, or a request to repeat an unreadable reply; resends of the same message are not.
    record.reasks = record.attempts.filter((attempt, i) => (i === 0 ? REASK_KINDS.has(attempt.prompt) : attempt.prompt === 'repeat')).length;
    // A blank reply taken for the final answer ends the task as if it were done: the bridge did not hold.
    record.holds = record.end === undefined ? true : !BROKEN.has(record.end) && !(record.end === 'done' && open.lastBlank);
    record.clean =
      record.holds &&
      record.attempts.length === 1 &&
      record.attempts[0]?.error === undefined &&
      record.reasks === 0 &&
      record.malformed === 0 &&
      record.cutOff === 0 &&
      record.emptyReplies === 0 &&
      record.unknownTools === 0 &&
      record.gated === 0 &&
      record.drift === 0 &&
      !record.filtered;
    this.cycles.push(record);
    this.write({ ...record });
    this.options.log?.(cycleLine(record));
  }
}

/** One line of progress per cycle. */
export function cycleLine(record: CycleRecord): string {
  const tools = Object.entries(record.tools)
    .map(([name, count]) => (count > 1 ? `${name}×${count}` : name))
    .join(' ');
  const flags = [
    record.malformed > 0 ? `malformed ${record.malformed}` : '',
    record.cutOff > 0 ? 'CUT OFF' : '',
    record.reasks > 0 ? `re-ask ${record.reasks}` : '',
    record.retries > 0 ? `retries ${record.retries}` : '',
    record.denied > 0 ? `denied ${record.denied}` : '',
    record.gated > 0 ? `gated ${record.gated}` : '',
    record.drift > 0 ? `drift ${record.drift}` : '',
    record.emptyReplies > 0 ? 'BLANK' : '',
    record.filtered ? 'FILTERED' : '',
    Object.keys(record.errors).length > 0 ? `errors ${Object.entries(record.errors).map(([k, n]) => `${k}×${n}`).join(',')}` : '',
    record.summarized > 0 ? `summarized ${record.summarized}` : '',
    record.attachments > 0 ? `attached ${record.attachments}` : '',
    record.rollover ? `ROLLOVER ${record.rollover.reason}` : '',
    record.end ? `end ${record.end}` : '',
  ].filter(Boolean);
  const time = record.replyMs === undefined ? '-' : `${(record.replyMs / 1000).toFixed(1)}s`;
  return `cycle ${String(record.cycle).padStart(2)}  task ${record.task}.${record.iteration} ${record.taskId}  chat ${record.chat}  ${record.prompt}  reply ${time}  blocks ${record.blocks}  ${tools || '-'}${flags.length > 0 ? `  [${flags.join('; ')}]` : ''}`;
}

function describe(error: unknown): string {
  if (error instanceof AdapterError) return `${error.kind}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * A ChatAdapter that passes everything through to another one and reports each send
 * to the meter. It changes nothing: same messages, same replies, same errors.
 */
export class MeteredAdapter implements ChatAdapter {
  readonly name: string;
  private readonly inner: ChatAdapter;
  private readonly meter: SpikeMeter;

  constructor(inner: ChatAdapter, meter: SpikeMeter) {
    this.inner = inner;
    this.meter = meter;
    this.name = inner.name;
  }

  open(): Promise<void> {
    return this.inner.open();
  }

  async newChat(): Promise<void> {
    await this.inner.newChat();
    this.meter.newChat();
  }

  async send(message: string, options?: SendOptions): Promise<ChatReply> {
    const started = performance.now();
    try {
      const reply = await this.inner.send(message, options);
      this.meter.attempt(message, options, performance.now() - started, { reply });
      return reply;
    } catch (error) {
      this.meter.attempt(message, options, performance.now() - started, { error });
      throw error;
    }
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

export interface SpikeTotals {
  cycles: number;
  /** Cycles held in a row from the first one. */
  heldInARow: number;
  held: number;
  clean: number;
  replyMs: { mean: number; median: number; p95: number; max: number } | undefined;
  blocks: number;
  calls: number;
  malformed: number;
  cutOff: number;
  unknownTools: number;
  reasks: number;
  retries: number;
  drift: number;
  timeouts: number;
  filtered: number;
  emptyReplies: number;
  errors: Record<string, number>;
  denied: number;
  gated: number;
  tools: Record<string, number>;
  toolFailures: number;
  summarized: number;
  attachments: number;
  attachmentsOff: boolean;
  rollovers: Record<string, number>;
  chats: number;
  maxBudgetUsed: number | undefined;
  tasks: number;
  taskStatuses: Record<string, number>;
  checksPassed: number;
}

export function totals(cycles: readonly CycleRecord[], tasks: readonly TaskRecord[]): SpikeTotals {
  const sum = (pick: (cycle: CycleRecord) => number): number => cycles.reduce((total, cycle) => total + pick(cycle), 0);
  const add = (into: Record<string, number>, from: Record<string, number>): void => {
    for (const [key, count] of Object.entries(from)) into[key] = (into[key] ?? 0) + count;
  };
  const errors: Record<string, number> = {};
  const tools: Record<string, number> = {};
  const rollovers: Record<string, number> = {};
  const taskStatuses: Record<string, number> = {};
  for (const cycle of cycles) {
    add(errors, cycle.errors);
    add(tools, cycle.tools);
    if (cycle.rollover) rollovers[cycle.rollover.reason] = (rollovers[cycle.rollover.reason] ?? 0) + 1;
  }
  for (const task of tasks) taskStatuses[task.status] = (taskStatuses[task.status] ?? 0) + 1;
  const firstBroken = cycles.findIndex((cycle) => !cycle.holds);
  const times = cycles.flatMap((cycle) => (cycle.replyMs === undefined ? [] : [cycle.replyMs])).sort((a, b) => a - b);
  const budgets = cycles.flatMap((cycle) => (cycle.budget ? [cycle.budget.used] : []));
  return {
    cycles: cycles.length,
    heldInARow: firstBroken < 0 ? cycles.length : firstBroken,
    held: cycles.filter((cycle) => cycle.holds).length,
    clean: cycles.filter((cycle) => cycle.clean).length,
    replyMs:
      times.length === 0
        ? undefined
        : {
            mean: Math.round(times.reduce((a, b) => a + b, 0) / times.length),
            median: percentile(times, 0.5),
            p95: percentile(times, 0.95),
            max: times.at(-1) ?? 0,
          },
    blocks: sum((cycle) => cycle.blocks),
    calls: sum((cycle) => cycle.calls),
    malformed: sum((cycle) => cycle.malformed),
    cutOff: sum((cycle) => cycle.cutOff),
    unknownTools: sum((cycle) => cycle.unknownTools),
    reasks: sum((cycle) => cycle.reasks),
    retries: sum((cycle) => cycle.retries),
    drift: sum((cycle) => cycle.drift),
    timeouts: sum((cycle) => cycle.timeouts),
    filtered: cycles.filter((cycle) => cycle.filtered).length,
    emptyReplies: sum((cycle) => cycle.emptyReplies),
    errors,
    denied: sum((cycle) => cycle.denied),
    gated: sum((cycle) => cycle.gated),
    tools,
    toolFailures: sum((cycle) => cycle.toolFailures),
    summarized: sum((cycle) => cycle.summarized),
    attachments: sum((cycle) => cycle.attachments),
    attachmentsOff: cycles.some((cycle) => cycle.attachmentsOff),
    rollovers,
    chats: Math.max(1, ...cycles.map((cycle) => cycle.chat)),
    maxBudgetUsed: budgets.length === 0 ? undefined : Math.max(...budgets),
    tasks: tasks.length,
    taskStatuses,
    checksPassed: tasks.filter((task) => task.check === 'pass').length,
  };
}

/** Nearest-rank percentile of sorted numbers. */
function percentile(sorted: readonly number[], p: number): number {
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1] ?? 0;
}
