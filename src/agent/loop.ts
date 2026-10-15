import { AdapterError, type AdapterErrorKind, type ChatAdapter, type ChatReply } from '../core/adapter.js';
import type { TurnRecord } from '../core/transcript.js';
import type { Toolbox } from '../tools/toolbox.js';
import type { ToolOutput } from '../tools/types.js';
import { firstMessage, followUpMessage, REPEAT_REQUEST, resultsFooter, type PromptContext } from './prompt.js';
import { formatResults, parseToolCalls, type CallError, type CallResult, type ToolCall } from './protocol.js';

export interface RetryPolicy {
  /** Retries after the first failure. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/** Where the agent logs its turns and tool calls: a Transcript, or anything shaped like it. */
export interface Recorder {
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
  /** Stop after this many replies in a row whose tool blocks were all malformed. */
  maxMalformedReplies?: number;
  transcript?: Recorder;
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
  | { type: 'retry'; error: AdapterError; attempt: number; delayMs: number };

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

/**
 * The agent loop: send, read the tool calls, run them, send the results, until the
 * model answers without tool calls or a limit is reached. It only knows ChatAdapter,
 * so the same loop runs on DeepSeek, on a fake script, or on any future backend.
 */
export class Agent {
  private readonly options: AgentOptions;
  private readonly maxIterations: number;
  private readonly maxDurationMs: number;
  private readonly retry: RetryPolicy;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Whether the current conversation already got the instructions. */
  private primed = false;

  constructor(options: AgentOptions) {
    this.options = options;
    this.maxIterations = options.maxIterations ?? 30;
    this.maxDurationMs = options.maxDurationMs ?? 30 * 60_000;
    this.retry = options.retry ?? DEFAULT_RETRY;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleep;
  }

  /** Call after the adapter starts a new chat: the next task brings the instructions again. */
  reset(): void {
    this.primed = false;
  }

  async run(task: string, signal?: AbortSignal): Promise<AgentResult> {
    const { toolbox, transcript } = this.options;
    const context: PromptContext = { tools: toolbox.list(), root: this.options.root, maxIterations: this.maxIterations };
    const deadline = this.now() + this.maxDurationMs;
    const result: AgentResult = { status: 'done', answer: '', iterations: 0, toolCalls: 0, pending: 0 };
    const finish = async (status: AgentStatus, error?: unknown): Promise<AgentResult> => {
      result.status = status;
      if (error !== undefined) result.error = error;
      await transcript?.event('task_end', {
        status,
        iterations: result.iterations,
        toolCalls: result.toolCalls,
        pending: result.pending,
      });
      return result;
    };

    await transcript?.event('task', { task });
    let message = this.primed ? followUpMessage(context, task) : firstMessage(context, task);
    let malformedReplies = 0;

    for (;;) {
      if (signal?.aborted) return finish('aborted');
      if (result.iterations >= this.maxIterations) return finish('max_iterations');
      if (this.now() >= deadline) return finish('timeout');

      let reply: ChatReply;
      try {
        reply = await this.exchange(message, result.iterations + 1, deadline, signal);
      } catch (error) {
        return finish(signal?.aborted ? 'aborted' : 'failed', error);
      }
      this.primed = true;
      result.iterations += 1;
      result.answer = reply.text;
      if (reply.filtered) return finish('filtered');

      const blocks = parseToolCalls(reply.text, { isTool: (name) => toolbox.has(name) });
      const calls = blocks.filter((block) => block.kind === 'call').length;
      this.emit({ type: 'reply', iteration: result.iterations, reply, calls });
      if (blocks.length === 0) return finish('done');

      // The model will not see these results: better not to run the calls at all.
      if (result.iterations >= this.maxIterations || this.now() >= deadline || signal?.aborted) {
        result.pending = calls;
        return finish(signal?.aborted ? 'aborted' : result.iterations >= this.maxIterations ? 'max_iterations' : 'timeout');
      }

      const results: CallResult[] = [];
      let blocked: string | undefined;
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
        if (signal?.aborted) blocked ??= 'Not run: the user stopped the agent.';
        if (blocked !== undefined) {
          results.push({ index: call.index, tool: call.tool, ok: false, text: blocked });
          continue;
        }
        this.emit({ type: 'call', call });
        const output = await toolbox.call(call, signal);
        result.toolCalls += 1;
        this.emit({ type: 'result', call, output });
        await transcript?.event('tool_call', {
          index: call.index,
          tool: call.tool,
          args: call.args,
          body: call.body,
          ok: output.ok,
          output: output.text,
        });
        results.push({ index: call.index, tool: call.tool, ok: output.ok, text: output.text });
      }
      if (signal?.aborted) return finish('aborted');

      malformedReplies = calls === 0 ? malformedReplies + 1 : 0;
      if (malformedReplies >= (this.options.maxMalformedReplies ?? 3)) {
        return finish('failed', new Error(`The model wrote only malformed tool calls ${malformedReplies} times in a row.`));
      }
      const malformed = blocks.some((block) => block.kind === 'error');
      message = formatResults(results, resultsFooter(result.iterations, this.maxIterations, malformed));
    }
  }

  /** Sends one message, retrying 'busy' with exponential backoff while time is left. */
  private async exchange(message: string, iteration: number, deadline: number, signal?: AbortSignal): Promise<ChatReply> {
    const { adapter, transcript } = this.options;
    let prompt = message;
    for (let attempt = 1; ; attempt += 1) {
      this.emit({ type: 'waiting', iteration });
      try {
        const reply = await adapter.send(prompt);
        await transcript?.turn({ prompt, attachments: [], reply });
        return reply;
      } catch (error) {
        await transcript?.turn({ prompt, attachments: [], error });
        if (!(error instanceof AdapterError) || !RETRYABLE.includes(error.kind) || attempt > this.retry.attempts) {
          throw error;
        }
        const delayMs = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** (attempt - 1));
        if (signal?.aborted || this.now() + delayMs >= deadline) throw error;
        this.emit({ type: 'retry', error, attempt, delayMs });
        await this.sleep(delayMs, signal);
        if (signal?.aborted) throw error;
        // An unreadable reply was still received by the model: ask for it again, not the same question.
        if (error.kind === 'empty') prompt = REPEAT_REQUEST;
      }
    }
  }

  private emit(event: AgentEvent): void {
    this.options.onEvent?.(event);
  }
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
