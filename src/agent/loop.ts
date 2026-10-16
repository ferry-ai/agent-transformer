import { resolve } from 'node:path';
import { AdapterError, type AdapterErrorKind, type ChatAdapter, type ChatReply } from '../core/adapter.js';
import type { TurnRecord } from '../core/transcript.js';
import { Toolbox } from '../tools/toolbox.js';
import type { ToolOutput } from '../tools/types.js';
import {
  AttachmentFolder,
  contextSettings,
  fitResult,
  fitResults,
  render,
  resultCost,
  summarize,
  type ContextOptions,
  type ContextSettings,
  type Outgoing,
  type PreparedResult,
  type RenderedMessage,
} from './context.js';
import {
  envelopeMessage,
  firstMessage,
  followUpMessage,
  NO_LAST_RESULTS,
  offProtocolMessage,
  REPEAT_REQUEST,
  resultsFooter,
  TASK_TOOL_NOTE,
  type EnvelopeReason,
  type PromptContext,
} from './prompt.js';
import { looksLikeUnfencedCall, parseToolCalls, type CallError, type CallResult, type ToolCall } from './protocol.js';
import {
  cap,
  newTaskState,
  noteCall,
  notePending,
  recordRollover,
  resumedState,
  saveTaskState,
  STATE_LIMITS,
  TASK_TOOL,
  taskTool,
  workspacePath,
  type RolloverReason,
  type TaskState,
} from './state.js';

export interface RetryPolicy {
  /** Retries after the first failure. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/** Where the agent logs its turns and tool calls: a Transcript, or anything shaped like it. */
export interface Recorder {
  /** The session folder: task-state.json and the attachments go there. */
  readonly dir?: string;
  turn(record: TurnRecord): Promise<void>;
  event(name: string, details?: Record<string, unknown>): Promise<void>;
}

export interface AgentOptions {
  adapter: ChatAdapter;
  toolbox: Toolbox;
  /** The workspace folder, as shown to the model. */
  root: string;
  /** Replies the model gets for one task. */
  maxIterations?: number;
  /** Wall-clock budget for one task, checked between turns. */
  maxDurationMs?: number;
  /** For 'busy' (and unreadable replies): wait, then try again. */
  retry?: RetryPolicy;
  /** Stop after this many replies in a row with no valid tool call (malformed blocks, unknown tools). */
  maxMalformedReplies?: number;
  transcript?: Recorder;
  /**
   * The context budget, long results, rollover, task state and the read-before-edit
   * gate (see docs/context-state.md). On by default; false turns all of it off.
   */
  context?: ContextOptions | false;
  onEvent?: (event: AgentEvent) => void;
  /** Clock and timer, replaceable in tests. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export type AgentEvent =
  | { type: 'waiting'; iteration: number }
  | { type: 'reply'; iteration: number; reply: ChatReply; calls: number }
  | { type: 'call'; call: ToolCall }
  | { type: 'result'; call: ToolCall; output: ToolOutput }
  | { type: 'malformed'; error: CallError }
  | { type: 'retry'; error: AdapterError; attempt: number; delayMs: number }
  /** After each exchange: how full the conversation is. */
  | { type: 'budget'; chat: number; used: number; limit: number }
  /** A long result was cut down in the message; its full text went as an attachment, or was left out. */
  | { type: 'summarized'; index: number; tool: string; chars: number; kept: number; attachment?: string; full?: boolean }
  /** A new chat took over the task; chat is the agent's conversation number. */
  | { type: 'rollover'; reason: RolloverReason; chat: number; used: number; limit: number }
  /** A reply with no valid tool call: count replies in a row. */
  | { type: 'drift'; count: number; detail: string }
  /** edit_file refused before running: the file was not read in this conversation. */
  | { type: 'gated'; call: ToolCall; reason: string }
  /** Sending attachments failed: long results go as summaries only from now on. */
  | { type: 'attachments_off'; message: string }
  | { type: 'resume'; state: TaskState };

export type AgentStatus =
  | 'done' // the model answered without tool calls
  | 'max_iterations'
  | 'timeout'
  | 'filtered' // the provider replaced the answer
  | 'aborted' // the user stopped it
  | 'failed'; // an adapter error that retries did not fix, or a model that cannot follow the protocol

export interface AgentResult {
  status: AgentStatus;
  /** The last reply of the model: the final answer when status is 'done'. */
  answer: string;
  iterations: number;
  toolCalls: number;
  /** Tool calls of the last reply left unrun because a limit was reached. */
  pending: number;
  error?: unknown;
}

const DEFAULT_RETRY: RetryPolicy = { attempts: 4, baseDelayMs: 5_000, maxDelayMs: 60_000 };
/** Errors worth a retry. The others need the user (limit, send_failed, closed) or are not transient. */
const RETRYABLE: readonly AdapterErrorKind[] = ['busy', 'empty'];
/** Tools whose successful call means the model has the file's current text in this chat. */
const SEES_FILE = new Set(['read_file', 'write_file', 'edit_file']);
/** Paths compared as the file system does, roughly: the gate only needs to recognize a file. */
const FOLD_CASE = process.platform === 'win32' || process.platform === 'darwin';

interface Conversation {
  /** Counted from 1 over the agent's life: a new chat, a rollover or reset() opens the next one. */
  number: number;
  /** Characters it holds: messages, attachments and replies. */
  used: number;
  exchanges: number;
  /** Files read or written in it, folded: what edit_file may change. */
  seen: Set<string>;
}

type Start = { kind: 'new'; task: string } | { kind: 'resume'; stopped: TaskState['status'] };

/**
 * The agent loop: send, read the tool calls, run them, send the results, until the
 * model answers without tool calls or a limit is reached. It only knows ChatAdapter,
 * so the same loop runs on DeepSeek, on a fake script, or on any future backend.
 *
 * It also owns the task state and the size of the conversation: long results are
 * summarized (and attached), and when the conversation is full or the model drifts
 * off the protocol, a new chat takes over with an envelope of the state.
 */
export class Agent {
  private readonly options: AgentOptions;
  private readonly maxIterations: number;
  private readonly maxDurationMs: number;
  private readonly retry: RetryPolicy;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly context: ContextSettings | undefined;
  /** The agent's own tools (update_task): they touch the task state only, never the workspace. */
  private readonly local: Toolbox | undefined;
  private readonly attachments: AttachmentFolder | undefined;
  /** Whether long results go as attachments; off for good once sending them failed. */
  private attach: boolean;
  /** Whether the current conversation already got the instructions. */
  private primed = false;
  private chat: Conversation = conversation(1);
  private current: TaskState | undefined;
  private saveFailed = false;

  constructor(options: AgentOptions) {
    this.options = options;
    this.maxIterations = options.maxIterations ?? 30;
    this.maxDurationMs = options.maxDurationMs ?? 30 * 60_000;
    this.retry = options.retry ?? DEFAULT_RETRY;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleep;
    this.context = options.context === false ? undefined : contextSettings(options.context, options.transcript?.dir);
    const dir = this.context?.dir;
    this.attachments = dir === undefined ? undefined : new AttachmentFolder(dir);
    this.attach = this.context?.largeResults === 'attach' && this.attachments !== undefined;
    this.local =
      this.context?.taskTool === true && !options.toolbox.has(TASK_TOOL) ? new Toolbox([taskTool(() => this.current)]) : undefined;
  }

  /** The state of the running task, or of the last one. */
  get state(): TaskState | undefined {
    return this.current;
  }

  /** The conversation in use: its number and how full it is. */
  get conversation(): { number: number; usedChars: number; exchanges: number } {
    return { number: this.chat.number, usedChars: this.chat.used, exchanges: this.chat.exchanges };
  }

  /** Call after the adapter starts a new chat: the next task brings the instructions again. */
  reset(): void {
    this.primed = false;
    this.chat = conversation(this.chat.number + 1);
  }

  async run(task: string, signal?: AbortSignal): Promise<AgentResult> {
    return this.execute(newTaskState(task, this.options.root, this.now()), { kind: 'new', task }, signal);
  }

  /**
   * Continues a saved task (see loadTaskState) in a new chat, with the envelope of its
   * state. The limits start over for this run. Refused when the task ran in another workspace.
   */
  async resume(saved: TaskState, signal?: AbortSignal, from?: string): Promise<AgentResult> {
    const fold = (path: string): string => (FOLD_CASE ? resolve(path).toLowerCase() : resolve(path));
    if (fold(saved.root) !== fold(this.options.root)) {
      throw new Error(`That task ran in ${saved.root}, not in ${resolve(this.options.root)}: resume it with --workspace ${saved.root}.`);
    }
    return this.execute(resumedState(saved, this.now(), from), { kind: 'resume', stopped: saved.status }, signal);
  }

  private async execute(state: TaskState, start: Start, signal?: AbortSignal): Promise<AgentResult> {
    const { toolbox, transcript } = this.options;
    const settings = this.context;
    const isTool = (name: string): boolean => toolbox.has(name) || this.local?.has(name) === true;
    const prompt: PromptContext = {
      tools: [...toolbox.list(), ...(this.local?.list() ?? [])],
      root: this.options.root,
      maxIterations: this.maxIterations,
      notes: this.local ? [TASK_TOOL_NOTE] : [],
    };
    const maxMalformed = this.options.maxMalformedReplies ?? 3;
    const deadline = this.now() + this.maxDurationMs;
    const result: AgentResult = { status: 'done', answer: '', iterations: 0, toolCalls: 0, pending: 0 };
    this.current = state;
    const finish = async (status: AgentStatus, error?: unknown): Promise<AgentResult> => {
      result.status = status;
      if (error !== undefined) result.error = error;
      state.status = status;
      await this.save(state);
      await transcript?.event('task_end', {
        status,
        iterations: result.iterations,
        toolCalls: result.toolCalls,
        pending: result.pending,
      });
      return result;
    };
    const stopped = (): AgentStatus => (signal?.aborted ? 'aborted' : 'failed');
    /** A new chat for the task, and what to send there first. */
    const rollover = async (reason: RolloverReason, last: Outgoing): Promise<Outgoing> => {
      const used = this.chat.used;
      await this.newConversation(reason, state);
      // Nothing done yet: the new chat simply starts the task.
      if (start.kind === 'new' && result.iterations === 0) return { tail: firstMessage(prompt, start.task) };
      return await this.envelope(prompt, state, reason, result.iterations, last, { previousChars: used });
    };

    let message: Outgoing;
    if (start.kind === 'resume') {
      await transcript?.event('resume', { task: state.goal, from: state.resumedFrom, runs: state.runs, iterations: state.iterations });
      this.emit({ type: 'resume', state });
      try {
        // The earlier chat is gone or holds another task: the envelope starts a clean one.
        if (this.primed || this.chat.exchanges > 0) await this.newConversation(undefined, state);
      } catch (error) {
        return finish(stopped(), error);
      }
      message = await this.envelope(prompt, state, 'resume', 0, undefined, { stopped: start.stopped });
    } else {
      await transcript?.event('task', { task: start.task });
      message = { tail: this.primed ? followUpMessage(prompt, start.task) : firstMessage(prompt, start.task) };
    }
    await this.save(state);
    let drift = 0;

    for (;;) {
      if (signal?.aborted) return finish('aborted');
      if (result.iterations >= this.maxIterations) return finish('max_iterations');
      if (this.now() >= deadline) return finish('timeout');

      // The budget: a conversation that already holds exchanges hands over before it overflows.
      if (settings && this.chat.exchanges > 0) {
        const next = this.render(message);
        if (this.chat.used + next.text.length + next.attachedChars + settings.replyReserveChars > settings.budgetChars) {
          try {
            message = await rollover('budget', message);
          } catch (error) {
            return finish(stopped(), error);
          }
        }
      }

      let reply: ChatReply;
      try {
        reply = await this.exchange(message, result.iterations + 1, deadline, signal);
      } catch (error) {
        // The provider says the conversation is full: once per conversation, a new one takes over.
        if (settings && error instanceof AdapterError && error.kind === 'limit' && this.chat.exchanges > 0 && !signal?.aborted) {
          try {
            message = await rollover('limit', message);
          } catch (again) {
            return finish(stopped(), again);
          }
          continue;
        }
        return finish(stopped(), error);
      }
      this.primed = true;
      result.iterations += 1;
      state.iterations += 1;
      result.answer = reply.text;
      state.answer = cap(reply.text, STATE_LIMITS.answer);
      if (reply.filtered) return finish('filtered');

      const blocks = parseToolCalls(reply.text, { isTool });
      const calls = blocks.filter((block) => block.kind === 'call').length;
      this.emit({ type: 'reply', iteration: result.iterations, reply, calls });

      if (blocks.length === 0) {
        // No block: the final answer, unless the reply tries to call a tool outside the protocol.
        const attempt = settings ? looksLikeUnfencedCall(reply.text, isTool) : undefined;
        if (attempt === undefined) return finish('done');
        drift += 1;
        await this.drifted(drift, attempt);
        if (drift >= maxMalformed) return finish('failed', new Error(`The model wrote only malformed tool calls ${drift} times in a row.`));
        message = { tail: offProtocolMessage(attempt, result.iterations, this.maxIterations) };
        if (settings && drift % settings.rolloverAfterDrift === 0) {
          try {
            message = await rollover('drift', message);
          } catch (error) {
            return finish(stopped(), error);
          }
        }
        await this.save(state);
        continue;
      }

      // The model will not see these results: better not to run the calls at all.
      if (result.iterations >= this.maxIterations || this.now() >= deadline || signal?.aborted) {
        result.pending = calls;
        const status = signal?.aborted ? 'aborted' : result.iterations >= this.maxIterations ? 'max_iterations' : 'timeout';
        if (settings) {
          for (const block of blocks) {
            if (block.kind === 'call') notePending(state, state.iterations, block.call, `the task stopped (${status}) before it ran.`);
          }
        }
        return finish(status);
      }

      const results: CallResult[] = [];
      let blocked: string | undefined;
      let valid = 0;
      for (const block of blocks) {
        if (block.kind === 'error') {
          this.emit({ type: 'malformed', error: block.error });
          await transcript?.event('malformed_call', { ...block.error });
          results.push({ index: block.error.index, tool: block.error.tool ?? '?', ok: false, text: block.error.message });
          // Later calls may depend on this one: hold them until it is fixed.
          blocked ??= `Not run: block ${block.error.index} is malformed. Send this call again after fixing it.`;
          continue;
        }
        const { call } = block;
        if (isTool(call.tool)) valid += 1;
        if (signal?.aborted) blocked ??= 'Not run: the user stopped the agent.';
        if (blocked !== undefined) {
          results.push({ index: call.index, tool: call.tool, ok: false, text: blocked });
          continue;
        }
        this.emit({ type: 'call', call });
        const refused = this.gate(call);
        if (refused !== undefined) {
          const output: ToolOutput = { ok: false, text: refused };
          this.emit({ type: 'gated', call, reason: refused });
          this.emit({ type: 'result', call, output });
          await transcript?.event('tool_call', { index: call.index, tool: call.tool, args: call.args, body: call.body, ok: false, output: refused, gated: true });
          results.push({ index: call.index, tool: call.tool, ok: false, text: refused });
          continue;
        }
        // The agent's own tools never reach the workspace; everything else goes through the toolbox as always.
        const output = await (this.local?.has(call.tool) ? this.local : toolbox).call(call, signal);
        result.toolCalls += 1;
        state.toolCalls += 1;
        this.emit({ type: 'result', call, output });
        await transcript?.event('tool_call', {
          index: call.index,
          tool: call.tool,
          args: call.args,
          body: call.body,
          ok: output.ok,
          output: output.text,
        });
        this.noteCall(state, call, output);
        results.push({ index: call.index, tool: call.tool, ok: output.ok, text: output.text });
      }
      if (signal?.aborted) return finish('aborted');

      // Drift: with the context features on, unknown tools count as invalid calls too.
      const invalid = settings ? valid === 0 : calls === 0;
      drift = invalid ? drift + 1 : 0;
      if (invalid && settings) await this.drifted(drift, 'no valid tool call');
      if (drift >= maxMalformed) {
        return finish('failed', new Error(`The model wrote only malformed tool calls ${drift} times in a row.`));
      }
      const malformed = blocks.some((block) => block.kind === 'error');
      message = {
        results: settings ? await this.prepare(results) : results,
        tail: resultsFooter(result.iterations, this.maxIterations, malformed),
      };
      if (settings && invalid && drift % settings.rolloverAfterDrift === 0) {
        try {
          message = await rollover('drift', message);
        } catch (error) {
          return finish(stopped(), error);
        }
      }
      await this.save(state);
    }
  }

  /** Sends one message, retrying 'busy' with exponential backoff while time is left. */
  private async exchange(message: Outgoing, iteration: number, deadline: number, signal?: AbortSignal): Promise<ChatReply> {
    const { adapter, transcript } = this.options;
    let sent: RenderedMessage = this.render(message);
    for (let attempt = 1; ; attempt += 1) {
      this.emit({ type: 'waiting', iteration });
      try {
        const reply = await adapter.send(sent.text, sent.attachments.length > 0 ? { attachments: sent.attachments } : undefined);
        this.chat.used += sent.text.length + sent.attachedChars + reply.text.length;
        this.chat.exchanges += 1;
        await transcript?.turn({
          prompt: sent.text,
          attachments: sent.attachments,
          reply,
          ...(this.context ? { chat: this.chat.number, contextChars: this.chat.used } : {}),
        });
        if (this.context) this.emit({ type: 'budget', chat: this.chat.number, used: this.chat.used, limit: this.context.budgetChars });
        return reply;
      } catch (error) {
        await transcript?.turn({
          prompt: sent.text,
          attachments: sent.attachments,
          error,
          ...(this.context ? { chat: this.chat.number } : {}),
        });
        // The upload did not go through: the same results again, as summaries only, from now on.
        // An adapter that cannot upload may also throw something other than an AdapterError.
        const uploadFailed = !(error instanceof AdapterError) || error.kind === 'send_failed';
        if (uploadFailed && sent.attachments.length > 0 && this.attach) {
          const reason = error instanceof Error ? error.message : String(error);
          this.attach = false;
          this.emit({ type: 'attachments_off', message: reason });
          await transcript?.event('attachments_off', { message: reason });
          sent = this.render(message);
          attempt -= 1; // not a retry: a different message
          continue;
        }
        if (!(error instanceof AdapterError) || !RETRYABLE.includes(error.kind) || attempt > this.retry.attempts) {
          throw error;
        }
        const delayMs = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** (attempt - 1));
        if (signal?.aborted || this.now() + delayMs >= deadline) throw error;
        this.emit({ type: 'retry', error, attempt, delayMs });
        await this.sleep(delayMs, signal);
        if (signal?.aborted) throw error;
        // An unreadable reply was still received by the model: ask for it again, not the same question.
        if (error.kind === 'empty') {
          this.chat.used += sent.text.length + sent.attachedChars;
          sent = { text: REPEAT_REQUEST, attachments: [], attachedChars: 0 };
        }
      }
    }
  }

  /** Opens a new chat for the task. With a reason it is a rollover, reported as one. */
  private async newConversation(reason: RolloverReason | undefined, state: TaskState): Promise<void> {
    const previous = this.chat;
    await this.options.adapter.newChat();
    this.chat = conversation(previous.number + 1);
    this.primed = false;
    if (reason === undefined) return;
    recordRollover(state, { reason, at: new Date(this.now()).toISOString(), chat: state.chats + 1, chars: previous.used });
    const limit = this.context?.budgetChars ?? 0;
    this.emit({ type: 'rollover', reason, chat: this.chat.number, used: previous.used, limit });
    await this.options.transcript?.event('rollover', { reason, chat: this.chat.number, taskChat: state.chats, usedChars: previous.used, limit });
  }

  /** The first message of a chat that continues the task: instructions, task, state, then the last results. */
  private async envelope(
    prompt: PromptContext,
    state: TaskState,
    reason: EnvelopeReason,
    iterations: number,
    last?: Outgoing,
    about: { previousChars?: number; stopped?: TaskState['status'] } = {},
  ): Promise<Outgoing> {
    const settings = this.context;
    // The goal is capped here too: a long one would leave the new chat no room.
    const goalChars = settings ? Math.max(1_000, Math.floor(settings.budgetChars / 10)) : undefined;
    const message = envelopeMessage(prompt, state, {
      reason,
      repliesLeft: this.maxIterations - iterations,
      ...about,
      ...(goalChars === undefined ? {} : { goalChars }),
    });
    const head = `${message}\n\n# Last results`;
    if (last === undefined) return { head, tail: NO_LAST_RESULTS };
    const envelope: Outgoing = { head, tail: last.tail };
    if (last.results === undefined) return envelope;
    if (!settings) {
      envelope.results = last.results;
      return envelope;
    }
    // The whole envelope fits in half of what the budget leaves for messages, so the new
    // chat has room for the replies that follow and does not roll over again at once.
    const room = Math.floor((settings.budgetChars - settings.replyReserveChars) / 2) - head.length - last.tail.length - 100;
    envelope.results = fitResults(last.results, room);
    for (const [i, result] of envelope.results.entries()) {
      if (result !== last.results[i]) await this.summarized(result);
    }
    return envelope;
  }

  /**
   * Long results become summaries; their full text is saved for an attachment when a
   * session folder exists. One message attaches at most a quarter of the budget, so a
   * batch of long results cannot fill a conversation on its own: the rest stay summaries.
   */
  private async prepare(results: CallResult[]): Promise<PreparedResult[]> {
    const settings = this.context;
    if (!settings) return results;
    const prepared: PreparedResult[] = [];
    // All the results of one message, attachments included, fit in a third of the budget,
    // so a chat always holds more than one reply and an envelope can carry them.
    let left = Math.floor((settings.budgetChars - settings.replyReserveChars) / 3);
    let attachRoom = Math.floor(settings.budgetChars / 4);
    for (const result of results) {
      const limit = result.tool === 'read_file' ? settings.inlineReadChars : settings.inlineResultChars;
      let item: PreparedResult = result;
      if (result.text.length > limit) {
        const summary: NonNullable<PreparedResult['summary']> = summarize(result.text, limit);
        item = { ...result, summary };
        const fits = resultCost(item) + result.text.length <= left;
        if (this.attach && this.attachments && result.text.length <= attachRoom && fits) {
          attachRoom -= result.text.length;
          try {
            summary.attachment = await this.attachments.save(result.tool, result.text);
          } catch (error) {
            await this.options.transcript?.event('attachment_failed', { message: error instanceof Error ? error.message : String(error) });
          }
        }
      }
      item = fitResult(item, left);
      left = Math.max(0, left - resultCost(item));
      prepared.push(item);
      if (item.summary !== undefined) await this.summarized(item);
    }
    return prepared;
  }

  /** Reports a result cut down in its message: why, how much, and where its full text went. */
  private async summarized(result: PreparedResult): Promise<void> {
    const { summary } = result;
    if (summary === undefined) return;
    const event = { index: result.index, tool: result.tool, chars: result.text.length, kept: summary.text.length };
    const extra = { ...(summary.attachment === undefined ? {} : { attachment: summary.attachment }), ...(summary.full ? { full: true } : {}) };
    this.emit({ type: 'summarized', ...event, ...extra });
    await this.options.transcript?.event('result_summarized', { ...event, ...extra });
  }

  /** The read-before-edit gate: edit_file needs the file's text in this conversation. */
  private gate(call: ToolCall): string | undefined {
    if (!this.context?.readBeforeEdit || call.tool !== 'edit_file' || !this.options.toolbox.has('edit_file')) return undefined;
    if (typeof call.args.path !== 'string') return undefined; // the toolbox reports the missing argument
    const path = workspacePath(call.args.path, this.options.root);
    if (this.chat.seen.has(foldPath(path))) return undefined;
    return (
      `Not run: ${path} was not read in this conversation, and edit_file needs its exact current text. ` +
      'Call read_file on it first, then send the edit again.'
    );
  }

  private noteCall(state: TaskState, call: ToolCall, output: ToolOutput): void {
    if (!this.context) return;
    noteCall(state, state.iterations, call, output, this.options.root);
    if (output.ok && SEES_FILE.has(call.tool) && typeof call.args.path === 'string') {
      this.chat.seen.add(foldPath(workspacePath(call.args.path, this.options.root)));
    }
  }

  private async drifted(count: number, detail: string): Promise<void> {
    this.emit({ type: 'drift', count, detail });
    await this.options.transcript?.event('drift', { count, detail });
  }

  private render(message: Outgoing): RenderedMessage {
    return render(message, this.attach);
  }

  /** Saves the state in the session folder. A failure is logged once and never stops the task. */
  private async save(state: TaskState): Promise<void> {
    const dir = this.context?.dir;
    if (dir === undefined) return;
    state.updatedAt = new Date(this.now()).toISOString();
    try {
      await saveTaskState(dir, state);
    } catch (error) {
      if (this.saveFailed) return;
      this.saveFailed = true;
      await this.options.transcript?.event('state_save_failed', { message: error instanceof Error ? error.message : String(error) });
    }
  }

  private emit(event: AgentEvent): void {
    this.options.onEvent?.(event);
  }
}

function conversation(number: number): Conversation {
  return { number, used: 0, exchanges: 0, seen: new Set() };
}

function foldPath(path: string): string {
  return FOLD_CASE ? path.toLowerCase() : path;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });
}
