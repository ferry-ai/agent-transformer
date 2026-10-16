import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { formatResults, type CallResult } from './protocol.js';
import { shortResult } from './state.js';

/**
 * How much the agent puts in one web conversation. The chat holds everything sent and
 * received, and a model that has read too much follows its instructions worse, so
 * the agent keeps a budget per conversation (in characters, a stand-in for tokens),
 * cuts long tool results down to a summary (the full text goes as an attachment from
 * the session folder), and opens a new chat when the budget runs out.
 */
export interface ContextOptions {
  /** Characters one conversation may hold, messages, attachments and replies together. Default 200_000. */
  budgetChars?: number;
  /** Room left for the next reply when checking the budget. Default 8_000. */
  replyReserveChars?: number;
  /** A tool result longer than this is summarized in the message. Default 6_000. */
  inlineResultChars?: number;
  /** The same for read_file, whose text the model needs as it is to edit it. Default 16_000. */
  inlineReadChars?: number;
  /**
   * What happens to the full text of a summarized result: 'attach' sends it as a file
   * from the session folder, 'summary' leaves it out. 'attach' needs a session folder
   * and falls back to 'summary' without one. Default 'attach'.
   */
  largeResults?: 'attach' | 'summary';
  /** Replies in a row with no valid tool call (drift) before a new chat takes over. Default 2. */
  rolloverAfterDrift?: number;
  /** Refuse edit_file on a file not read (or written) in the current conversation. Default true. */
  readBeforeEdit?: boolean;
  /** Offer the update_task tool, which keeps the model's checklist and decisions in the task state. Default true. */
  taskTool?: boolean;
  /** Where task-state.json and the attachments go. Default: the transcript's session folder. */
  dir?: string;
}

export interface ContextSettings extends Required<Omit<ContextOptions, 'dir'>> {
  dir?: string;
}

export const CONTEXT_DEFAULTS: Required<Omit<ContextOptions, 'dir'>> = {
  budgetChars: 200_000,
  replyReserveChars: 8_000,
  inlineResultChars: 6_000,
  inlineReadChars: 16_000,
  largeResults: 'attach',
  rolloverAfterDrift: 2,
  readBeforeEdit: true,
  taskTool: true,
};

export function contextSettings(options: ContextOptions = {}, sessionDir?: string): ContextSettings {
  const settings: ContextSettings = { ...CONTEXT_DEFAULTS };
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) Object.assign(settings, { [key]: value });
  }
  if (settings.dir === undefined && sessionDir !== undefined) settings.dir = sessionDir;
  for (const key of ['budgetChars', 'inlineResultChars', 'inlineReadChars', 'rolloverAfterDrift'] as const) {
    if (!(settings[key] > 0)) throw new Error(`context.${key} must be a positive number.`);
  }
  if (settings.replyReserveChars < 0) throw new Error('context.replyReserveChars cannot be negative.');
  return settings;
}

/** A tool result on its way to the chat: the full text, and its summary when it is too long. */
export interface PreparedResult extends CallResult {
  summary?: {
    text: string;
    /** Characters left out of the message. */
    cut: number;
    lines: number;
    /** The full text, saved in the session folder. */
    attachment?: string;
    /** Cut further because its message had no room left for more of it. */
    full?: boolean;
  };
}

/**
 * The next message, kept in parts until it is sent: whether the long results go as
 * attachments is decided then, and a rollover can wrap the same results in an envelope.
 */
export interface Outgoing {
  /** Text before the results: the rollover envelope. */
  head?: string;
  results?: PreparedResult[];
  /** The footer after the results, or the whole message when there are none. */
  tail: string;
}

export interface RenderedMessage {
  text: string;
  attachments: string[];
  /** Characters in the attached files: they count against the budget too. */
  attachedChars: number;
}

export function render(message: Outgoing, attach: boolean): RenderedMessage {
  const parts: string[] = [];
  if (message.head !== undefined) parts.push(message.head);
  const attachments: string[] = [];
  let attachedChars = 0;
  if (message.results !== undefined && message.results.length > 0) {
    const shown = message.results.map((result): CallResult => {
      const { summary } = result;
      if (summary === undefined) return result;
      if (attach && summary.attachment !== undefined) {
        attachments.push(summary.attachment);
        attachedChars += result.text.length;
        return { ...result, text: `${summary.text}\n${attachedNote(summary.attachment, summary.lines, result.text.length)}` };
      }
      const note = summary.full === true ? fullNote(summary.cut) : leftOutNote(summary.cut, result.tool);
      return { ...result, text: `${summary.text}\n${note}` };
    });
    parts.push(formatResults(shown, message.tail));
  } else {
    parts.push(message.tail);
  }
  return { text: parts.join('\n\n'), attachments, attachedChars };
}

function attachedNote(file: string, lines: number, chars: number): string {
  const name = file.split(/[\\/]/).pop() ?? file;
  return `[The full result (${lines} lines, ${chars} characters) is attached as ${name}. Only its start, its end and the lines that mention errors are shown here.]`;
}

function leftOutNote(cut: number, tool: string): string {
  const how =
    tool === 'read_file'
      ? 'Read the rest with read_file, offset and limit.'
      : 'To see more, ask for less at a time: filter a command output (grep, head, tail), or read a file in slices.';
  return `[${cut} characters were left out to keep this chat short. ${how}]`;
}

function fullNote(cut: number): string {
  return (
    `[${cut} characters were left out because this message was full. ` +
    'To see them, send this call again on its own, or ask for less at a time.]'
  );
}

/** What a result cut down to fit a full message keeps of its text. */
export const SQUEEZED_CHARS = 500;

/** The characters a result takes in a message: its text as rendered, plus its attachment. */
export function resultCost(result: PreparedResult): number {
  const rendered = render({ results: [result], tail: '' }, true);
  return rendered.text.length + rendered.attachedChars;
}

/**
 * Fits one result in the room left in its message: as it is if it fits, else without
 * its attachment, else cut to SQUEEZED_CHARS, else to its first and last lines. That
 * last form is kept whatever the room: the model must still see that the call ran.
 */
export function fitResult(result: PreparedResult, room: number): PreparedResult {
  if (resultCost(result) <= room) return result;
  if (result.summary?.attachment !== undefined) {
    const { attachment: _attachment, ...summary } = result.summary;
    const plain: PreparedResult = { ...result, summary };
    if (resultCost(plain) <= room) return plain;
  }
  if (result.text.length > SQUEEZED_CHARS) {
    const squeezed: PreparedResult = { ...result, summary: { ...summarize(result.text, SQUEEZED_CHARS), full: true } };
    if (resultCost(squeezed) <= room) return squeezed;
  }
  const short = shortResult(result.text);
  const lines = result.text.replace(/\n$/, '').split('\n').length;
  return { ...result, summary: { text: short, cut: Math.max(0, result.text.length - short.length), lines, full: true } };
}

/** Fits the results of one message in room characters, in order: the first ones keep the most. */
export function fitResults(results: PreparedResult[], room: number): PreparedResult[] {
  let left = Math.max(0, room);
  return results.map((result) => {
    const fitted = fitResult(result, left);
    left = Math.max(0, left - resultCost(fitted));
    return fitted;
  });
}

const ERROR_LINE = /\b(error|errors|fail|failed|failure|failing|exception|panic|traceback|assert\w*|fatal|warning)\b/i;

/**
 * The start and the end of a long text, plus the lines of the middle that mention
 * errors: test runners and compilers put the useful part at either end or flag it.
 */
export function summarize(text: string, max: number): { text: string; cut: number; lines: number } {
  const lines = text.replace(/\n$/, '').split('\n').length;
  if (text.length <= max) return { text, cut: 0, lines };
  const headSize = Math.floor(max * 0.4);
  const tailSize = Math.floor(max * 0.4);
  const flaggedSize = max - headSize - tailSize;
  let headEnd = headSize;
  const lastBreak = text.lastIndexOf('\n', headSize);
  if (lastBreak > headSize / 2) headEnd = lastBreak;
  let tailStart = text.length - tailSize;
  const nextBreak = text.indexOf('\n', tailStart);
  if (nextBreak >= 0 && nextBreak < tailStart + tailSize / 2) tailStart = nextBreak + 1;
  const middle = text.slice(headEnd, tailStart);
  const flagged: string[] = [];
  let flaggedChars = 0;
  for (const line of middle.split('\n')) {
    if (!ERROR_LINE.test(line)) continue;
    const shown = line.length > 200 ? `${line.slice(0, 200)}…` : line;
    if (flaggedChars + shown.length + 1 > flaggedSize) break;
    flagged.push(shown);
    flaggedChars += shown.length + 1;
  }
  const middleLines = middle.split('\n').length - 1;
  const marker = `[… ${middleLines} lines, ${middle.length} characters left out …]`;
  const parts = [text.slice(0, headEnd).replace(/\n$/, ''), marker];
  if (flagged.length > 0) parts.push('[lines from the part left out that mention errors:]', ...flagged, '[end of those lines]');
  parts.push(text.slice(tailStart));
  return { text: parts.join('\n'), cut: Math.max(0, middle.length - flaggedChars), lines };
}

/** Where the full text of long results is saved: <session>/attachments, never the workspace. */
export class AttachmentFolder {
  readonly dir: string;
  private count = 0;

  constructor(sessionDir: string) {
    this.dir = join(sessionDir, 'attachments');
  }

  async save(tool: string, text: string): Promise<string> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const name = tool.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'tool';
    for (;;) {
      this.count += 1;
      const file = join(this.dir, `result-${String(this.count).padStart(4, '0')}-${name}.txt`);
      try {
        await writeFile(file, text, { mode: 0o600, flag: 'wx' });
        return file;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
  }
}
