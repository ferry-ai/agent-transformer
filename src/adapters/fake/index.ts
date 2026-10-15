import { readFile } from 'node:fs/promises';
import { AdapterError, type AdapterErrorKind, type ChatAdapter, type ChatReply, type SendOptions } from '../../core/adapter.js';

/**
 * One scripted answer: the reply text, a full reply, an error to throw, or a function
 * that builds the answer from the message it receives.
 */
export type FakeStep =
  | string
  | (Partial<ChatReply> & { text: string })
  | AdapterError
  | ((message: string) => FakeStep);

export interface SentMessage {
  message: string;
  attachments: string[];
}

/**
 * A chat backend that plays back a script: no browser, no network. The tests drive
 * the agent with it, and "--replay" lets the CLI run without DeepSeek.
 */
export class FakeAdapter implements ChatAdapter {
  readonly name = 'fake';
  readonly sent: SentMessage[] = [];
  newChats = 0;
  opened = false;
  closed = false;
  private readonly steps: FakeStep[];

  constructor(steps: FakeStep[]) {
    this.steps = [...steps];
  }

  /**
   * Reads a script from JSON: a list of reply texts, or of objects like
   * {"text": "..."} or {"error": "busy", "message": "..."}.
   */
  static async fromFile(file: string): Promise<FakeAdapter> {
    const data: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!Array.isArray(data)) throw new Error(`${file}: expected a JSON list of replies.`);
    return new FakeAdapter(
      data.map((item, i): FakeStep => {
        if (typeof item === 'string') return item;
        if (typeof item === 'object' && item !== null && typeof item.error === 'string') {
          return new AdapterError(item.error as AdapterErrorKind, String(item.message ?? item.error));
        }
        if (typeof item === 'object' && item !== null && typeof item.text === 'string') return item as ChatReply;
        throw new Error(`${file}, reply ${i + 1}: expected a string, {"text": ...} or {"error": ...}.`);
      }),
    );
  }

  /** Scripted answers not used yet. */
  get remaining(): number {
    return this.steps.length;
  }

  async open(): Promise<void> {
    if (this.closed) throw new AdapterError('closed', 'The fake chat was closed.');
    this.opened = true;
  }

  async newChat(): Promise<void> {
    this.check();
    this.newChats += 1;
  }

  async send(message: string, options: SendOptions = {}): Promise<ChatReply> {
    this.check();
    this.sent.push({ message, attachments: options.attachments ?? [] });
    let step = this.steps.shift();
    while (typeof step === 'function') step = step(message);
    if (step === undefined) throw new AdapterError('provider', 'The fake chat has no scripted reply left.');
    if (step instanceof AdapterError) throw step;
    if (typeof step === 'string') return { text: step, source: 'network', durationMs: 0 };
    return { source: 'network', durationMs: 0, ...step };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private check(): void {
    if (this.closed) throw new AdapterError('closed', 'The fake chat was closed.');
    if (!this.opened) throw new AdapterError('closed', 'The fake chat is not open yet.');
  }
}
