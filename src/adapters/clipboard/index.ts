import { resolve } from 'node:path';
import { AdapterError, type ChatAdapter, type ChatReply, type SendOptions } from '../../core/adapter.js';
import { dim, errorMessage, safe, safeLine, yellow } from '../../term.js';
import type { Clipboard, ClipboardChoice } from './clipboard.js';
import type { InputEvent, InputSession, UserInput } from './input.js';
import { checkReply, framePrompt, markerOf, replyEnd, TYPED_END, type Marker } from './reply.js';

export { systemClipboard, type Clipboard, type ClipboardChoice } from './clipboard.js';
export { readlineInput, type InputEvent, type InputSession, type UserInput } from './input.js';

export interface ClipboardAdapterOptions {
  /** The system clipboard, or why there is none: then prompts are copied from the terminal and replies pasted into it. */
  clipboard: ClipboardChoice;
  /** The terminal. The agent CLI sets it later with setInput(), once its readline exists. */
  input?: UserInput;
  /** Where instructions and prompts go (default: console.log). */
  print?: (text: string) => void;
  now?: () => number;
}

/**
 * Assisted copy-paste: the compliant way to use a web chat. It automates no website:
 * each prompt goes to the clipboard and to the terminal, the user pastes it into any
 * chat, sends it, copies the whole reply and presses Enter, and the adapter reads the
 * clipboard. Where there is no clipboard, the reply is pasted into the terminal.
 *
 * What comes back is checked before the agent sees it (see reply.ts): the prompt
 * copied back, the reply to an older prompt and a reply cut off are refused, and the
 * user is asked again.
 */
export class ClipboardAdapter implements ChatAdapter {
  readonly name = 'clipboard';
  private readonly clipboard: Clipboard | undefined;
  private readonly unavailable: string | undefined;
  private readonly print: (text: string) => void;
  private readonly now: () => number;
  private input: UserInput | undefined;
  private session: InputSession | undefined;
  private turn = 0;
  /** The next prompt opens a conversation. */
  private fresh = true;
  /** The full how-to was shown with a prompt. */
  private explained = false;
  private opened = false;
  private closed = false;

  constructor(options: ClipboardAdapterOptions) {
    if ('clipboard' in options.clipboard) this.clipboard = options.clipboard.clipboard;
    else this.unavailable = options.clipboard.unavailable;
    this.input = options.input;
    this.print = options.print ?? ((text) => console.log(text));
    this.now = options.now ?? Date.now;
  }

  /** Where the user's lines come from: the agent CLI's own readline. */
  setInput(input: UserInput): void {
    this.input = input;
  }

  async open(): Promise<void> {
    if (this.closed) throw new AdapterError('closed', 'Clipboard mode was closed.');
    if (this.opened) return;
    this.opened = true;
    this.print(
      dim(
        [
          'Clipboard mode: nothing is automated. Open any chat in your browser. For each reply the agent needs:',
          this.clipboard
            ? '  1. the prompt is copied to the clipboard (and shown here): paste it into the chat and send it;'
            : '  1. the prompt is shown here: copy it, paste it into the chat and send it;',
          this.clipboard
            ? '  2. when the reply is complete, copy all of it (the copy button under it) and press Enter here.'
            : '  2. when the reply is complete, copy all of it and paste it here.',
          `A pasted reply ends at its last line, [[end of reply N]]; if it has none, type ${TYPED_END} after it.`,
          'Ctrl+C stops the task.',
        ].join('\n'),
      ),
    );
    if (this.unavailable !== undefined) {
      this.print(yellow(`⚠ No clipboard: ${this.unavailable} Prompts and replies go through the terminal.`));
    }
  }

  async newChat(): Promise<void> {
    this.check();
    this.fresh = true;
    this.print(dim('Start a new conversation in the chat: the next prompt goes there.'));
  }

  async send(message: string, options: SendOptions = {}): Promise<ChatReply> {
    this.check();
    if (!this.input) throw new Error('Clipboard mode needs the terminal input: call setInput() first.');
    const started = this.now();
    this.turn += 1;
    const turn = this.turn;
    const prompt = framePrompt(message, turn);
    // Shown first: the copy can take a second or more (PowerShell starts each time).
    this.print(['', dim(`Prompt ${turn}:`), safe(prompt), ''].join('\n'));
    const copied = await this.copy(prompt);
    this.instruct(turn, copied, (options.attachments ?? []).map((file) => resolve(file)));

    const session = this.input.listen();
    this.session = session;
    try {
      const text = await this.waitForReply(session, turn, prompt);
      const extra = (await session.drain()).filter((line) => line.trim() !== '').length;
      if (extra > 0) this.print(dim(`Ignored ${extra} more line${extra === 1 ? '' : 's'} pasted after the reply.`));
      this.fresh = false;
      return { text, source: 'dom', durationMs: this.now() - started };
    } finally {
      session.close();
      this.session = undefined;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.session?.close();
  }

  private check(): void {
    if (this.closed) throw new AdapterError('closed', 'Clipboard mode was closed.');
    if (!this.opened) throw new AdapterError('closed', 'Clipboard mode is not open yet.');
  }

  /** Copies the prompt; on failure says so, and the prompt is copied from the terminal instead. */
  private async copy(prompt: string): Promise<boolean> {
    if (!this.clipboard) return false;
    try {
      await this.clipboard.write(prompt);
      return true;
    } catch (error) {
      this.print(yellow(`⚠ Could not copy the prompt to the clipboard: ${errorMessage(error)}`));
      this.print(yellow('  Copy it from the terminal instead, between its begin and end lines.'));
      return false;
    }
  }

  /** What to do with the prompt just shown: where to paste it, the files to attach, how to bring the reply back. */
  private instruct(turn: number, copied: boolean, attachments: string[]): void {
    const where = this.fresh ? 'a new conversation in the chat' : 'the chat';
    const lines = [
      copied
        ? `Prompt ${turn} is on the clipboard: paste it into ${where} and send it.`
        : `Copy prompt ${turn}, from its begin line to its end line, into ${where} and send it.`,
    ];
    if (attachments.length > 0) {
      lines.push(
        yellow(`Attach ${attachments.length === 1 ? 'this file' : `these ${attachments.length} files`} to the message by hand, with the chat's attach button (nothing uploads them):`),
        ...attachments.map((file) => `  ${safeLine(file)}`),
      );
    }
    if (!this.explained) {
      lines.push(
        this.clipboard
          ? 'When the reply is complete, copy all of it (the copy button under it) and press Enter. Or paste it here.'
          : 'When the reply is complete, copy all of it and paste it here.',
        dim(`A pasted reply ends at ${replyEnd(turn)}; if that line is missing, type ${TYPED_END} after it. /copy copies the prompt again.`),
      );
      this.explained = true;
    } else {
      lines.push(
        dim(
          this.clipboard
            ? `Then copy the whole reply and press Enter, or paste it here (${TYPED_END} if it lacks its end line).`
            : `Then paste the whole reply here (${TYPED_END} if it lacks its end line).`,
        ),
      );
    }
    this.print(lines.join('\n'));
  }

  /** Asks until a reply passes the checks, or the user accepts one that did not. */
  private async waitForReply(session: InputSession, turn: number, prompt: string): Promise<string> {
    /** What /accept passes on: the last reply refused by a check that may be wrong. */
    let candidate: string | undefined;
    for (;;) {
      const line = lineOf(await session.next(`reply ${turn}> `));
      const command = line.trim();
      let raw: string;
      let from: 'clipboard' | 'paste' = 'clipboard';
      if (command === '') {
        if (!this.clipboard) {
          this.print(dim(`There is no clipboard: paste the reply here, then ${TYPED_END} if it lacks its end line.`));
          continue;
        }
        try {
          raw = await this.clipboard.read();
        } catch (error) {
          this.print(yellow(`⚠ Could not read the clipboard: ${errorMessage(error)}`));
          this.print(dim(`Paste the reply here instead, then ${TYPED_END} if it lacks its end line.`));
          continue;
        }
      } else if (command === '/copy') {
        if (!this.clipboard) this.print(dim('There is no clipboard: copy the prompt from the terminal.'));
        else if (await this.copy(prompt)) this.print(dim('The prompt is on the clipboard again.'));
        continue;
      } else if (command === '/accept') {
        if (candidate === undefined) {
          this.print(dim('Nothing to accept: /accept takes a reply that was refused with a warning.'));
          continue;
        }
        return candidate;
      } else {
        raw = await this.readPaste(session, line);
        from = 'paste';
      }

      const checked = checkReply(raw, turn, prompt, from);
      if (checked.ok) {
        if (checked.note !== undefined) this.print(dim(checked.note));
        return checked.text;
      }
      candidate = checked.text;
      this.print(yellow(`⚠ ${checked.problem}`));
      if (from === 'paste') {
        // The rest of a refused paste is not a new paste: read as one, it would skip the checks.
        const extra = (await session.drain()).filter((rest) => rest.trim() !== '').length;
        if (extra > 0) this.print(dim(`Ignored ${extra} more line${extra === 1 ? '' : 's'} pasted after it.`));
      }
      const again = this.clipboard ? 'Copy the whole reply and press Enter, or paste it here.' : 'Paste the whole reply here.';
      this.print(dim(candidate === undefined ? again : `${again} Or type /accept to pass this one on as it is.`));
    }
  }

  /**
   * A reply pasted into the terminal: its lines up to an end line. A paste that opens with
   * a prompt's begin line (the prompt pasted by mistake) also ends at that prompt's end
   * line; elsewhere a prompt marker line is the reply's own text, which may quote one.
   */
  private async readPaste(session: InputSession, first: string): Promise<string> {
    const lines = [first];
    const opening = markerOf(first);
    const promptTurn = opening?.kind === 'prompt' && opening.edge === 'begin' ? opening.turn : undefined;
    const ends = (marker: Marker | undefined): boolean =>
      marker?.kind === 'end' || (promptTurn !== undefined && marker?.kind === 'prompt' && marker.edge === 'end' && marker.turn === promptTurn);
    let marker = opening;
    while (!ends(marker)) {
      const line = lineOf(await session.next('… '));
      lines.push(line);
      marker = markerOf(line);
    }
    return lines.join('\n');
  }
}

/** The text of a line event; the other events end the wait. */
function lineOf(event: InputEvent): string {
  if (event.kind === 'closed') throw new AdapterError('closed', 'The input was closed while waiting for the reply.');
  if (event.kind === 'interrupt') throw new AdapterError('send_failed', 'Stopped while waiting for the reply.');
  return event.text;
}
