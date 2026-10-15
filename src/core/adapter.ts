/**
 * A chat backend the agent talks to. Today a web chat driven through a browser;
 * the rest of the agent only ever sees this interface.
 */
export interface ChatAdapter {
  readonly name: string;
  /** Opens the backend and waits until it can receive messages. */
  open(): Promise<void>;
  /** Starts a fresh conversation. */
  newChat(): Promise<void>;
  /** Sends one message and resolves when the reply is complete. */
  send(message: string, options?: SendOptions): Promise<ChatReply>;
  close(): Promise<void>;
}

export interface SendOptions {
  /** Local files to upload with the message. */
  attachments?: string[];
}

export interface ChatReply {
  /** The final answer, as Markdown. */
  text: string;
  /** Reasoning shown separately from the answer, when the backend has it. */
  thinking?: string;
  /** Where the text was read from: the network stream (exact) or the rendered page. */
  source: 'network' | 'dom';
  /** The provider replaced the answer with a canned one (content filter). */
  filtered?: boolean;
  durationMs: number;
  /** Raw material for recalibrating parsers and selectors, kept only in debug mode. */
  raw?: { stream?: string; html?: string };
}

export type AdapterErrorKind =
  | 'busy' // the provider is overloaded or rate limiting
  | 'limit' // usage or conversation-length limit reached
  | 'provider' // the provider reported another error
  | 'send_failed' // the message never left the input box
  | 'timeout' // no complete reply in time
  | 'empty' // a reply arrived but could not be read
  | 'closed'; // the browser was closed

export class AdapterError extends Error {
  readonly kind: AdapterErrorKind;

  constructor(kind: AdapterErrorKind, message: string) {
    super(message);
    this.name = 'AdapterError';
    this.kind = kind;
  }
}
