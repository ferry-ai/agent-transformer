/**
 * What the clipboard adapter puts around each prompt, and the checks on what comes
 * back. Pure functions: the adapter does the talking.
 *
 * A prompt goes to the chat between two marker lines and asks the model to end its
 * reply with a third one:
 *
 *   [[agent-transformer prompt 3 begin]]
 *   ...the message...
 *   (After your whole reply, outside any code block, write this line on its own: [[end of reply 3]])
 *   [[agent-transformer prompt 3 end]]
 *
 * The prompt markers show where the prompt starts and ends, and give it away when it is
 * copied back by mistake. The end line shows that the reply was copied whole, and which
 * prompt it answers.
 */

export function promptBegin(turn: number): string {
  return `[[agent-transformer prompt ${turn} begin]]`;
}

export function promptEnd(turn: number): string {
  return `[[agent-transformer prompt ${turn} end]]`;
}

/** The line the model is asked to end its reply with. */
export function replyEnd(turn: number): string {
  return `[[end of reply ${turn}]]`;
}

/** What the user can type after a pasted reply that lacks its end line. */
export const TYPED_END = '[[end]]';

/** The text that goes to the clipboard: the message between its markers, and how to end the reply. */
export function framePrompt(message: string, turn: number): string {
  return [
    promptBegin(turn),
    message.trimEnd(),
    '',
    `(After your whole reply, outside any code block, write this line on its own: ${replyEnd(turn)})`,
    promptEnd(turn),
  ].join('\n');
}

export type Marker =
  | { kind: 'prompt'; turn: number; edge: 'begin' | 'end' }
  /** An end line: from the model with its number, or typed by the user without one. */
  | { kind: 'end'; turn?: number };

/**
 * The marker on this line, if it is one. Lenient: a chat or its copy button may wrap the
 * line in Markdown (`code`, **bold**, a > quote), escape the brackets, or change the case,
 * and a model may end the line with a full stop.
 */
export function markerOf(line: string): Marker | undefined {
  const bare = line
    .trim()
    .replace(/^(?:>\s*)+/, '')
    .replace(/\\([[\]])/g, '$1')
    .replace(/^[*_`~\s]+|[*_`~\s.]+$/g, '')
    .toLowerCase();
  const prompt = /^\[\[\s*agent-transformer prompt (\d+) (begin|end)\s*\]\]$/.exec(bare);
  if (prompt) return { kind: 'prompt', turn: Number(prompt[1]), edge: prompt[2] === 'begin' ? 'begin' : 'end' };
  const end = /^\[\[\s*end(?: of reply(?: (\d+))?)?\s*\]\]$/.exec(bare);
  if (end) return end[1] === undefined ? { kind: 'end' } : { kind: 'end', turn: Number(end[1]) };
  return undefined;
}

export type Checked =
  | { ok: true; text: string; note?: string }
  /**
   * Not passed on. `text` is what /accept would pass on when the check may be wrong;
   * without it there is nothing worth passing on (an empty clipboard, the prompt itself).
   */
  | { ok: false; problem: string; text?: string };

/** Unix line endings, no byte order mark. */
export function normalize(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/**
 * Checks what came back from the chat for prompt `turn`: the prompt copied back, the
 * reply to another prompt, a reply cut off (no end line, a code block left open).
 * On success, the text is the reply without its end line.
 */
export function checkReply(raw: string, turn: number, prompt: string, from: 'clipboard' | 'paste' = 'clipboard'): Checked {
  const text = normalize(raw);
  if (text.trim() === '') return { ok: false, problem: from === 'clipboard' ? 'The clipboard holds no text.' : 'Nothing was pasted.' };
  if (text.trim() === normalize(prompt).trim()) {
    return {
      ok: false,
      problem: from === 'clipboard' ? 'The clipboard still holds the prompt: copy the reply first.' : 'This is the prompt, not the reply.',
    };
  }
  const lines = text.split('\n');
  const markers = lines.map(markerOf);
  if (markers.some((marker) => marker?.kind === 'prompt')) {
    return {
      ok: false,
      problem: 'This is a prompt (it has the agent-transformer prompt markers), not the reply.',
      text: text.trim(),
    };
  }

  let last = -1;
  markers.forEach((marker, i) => {
    if (marker?.kind === 'end') last = i;
  });
  if (last < 0) {
    const reply = text.trim();
    if (hasOpenFence(reply)) return { ok: false, problem: 'A code block is not closed: the reply looks cut off.', text: reply };
    return {
      ok: false,
      problem: `The reply does not end with ${replyEnd(turn)}: it may be cut off, or copied only in part.`,
      text: reply,
    };
  }

  const reply = lines.slice(0, last).join('\n').trim();
  if (reply === '') return { ok: false, problem: 'The reply is empty: only its end line was copied.' };
  const marker = markers[last];
  if (marker?.kind === 'end' && marker.turn !== undefined && marker.turn !== turn) {
    return {
      ok: false,
      problem: `This is the reply to prompt ${marker.turn}, not to prompt ${turn}: copy the latest reply.`,
      text: reply,
    };
  }
  if (hasOpenFence(reply)) return { ok: false, problem: 'A code block is not closed: the reply looks cut off.', text: reply };
  const after = lines.slice(last + 1).filter((line) => line.trim() !== '').length;
  return after > 0
    ? { ok: true, text: reply, note: `Left out ${after} line${after === 1 ? '' : 's'} after the end line.` }
    : { ok: true, text: reply };
}

/** Info strings of tool blocks, as in agent/protocol.ts. */
const TOOL_INFO = /^(tool|tool_call|tool-call|toolcall|tool_use)$/i;

/**
 * Whether a fenced code block is left open, as when a reply is cut off. Fences are read
 * as agent/protocol.ts reads them, with the same tolerance: inside a tool block, a
 * ```python line opens a nested block whose bare ``` does not close the tool block.
 */
export function hasOpenFence(text: string): boolean {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^\s*(`{3,}|~{3,})(.*)$/.exec(lines[i] ?? '');
    if (!open) continue;
    const [, marker = '', rest = ''] = open;
    if (marker.startsWith('`') && rest.includes('`')) continue; // ```inline``` on one line
    const tolerant = TOOL_INFO.test(rest.trim().split(/\s+/)[0] ?? '');
    let nested = 0;
    let closed = false;
    for (i += 1; i < lines.length; i += 1) {
      const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(lines[i] ?? '');
      if (!fence) continue;
      const [, run = '', after = ''] = fence;
      const sameKind = run[0] === marker[0];
      if (after.trim() === '' && sameKind && run.length >= marker.length) {
        if (nested === 0) {
          closed = true;
          break;
        }
        nested -= 1;
      } else if (tolerant && sameKind && after.trim() !== '' && !after.includes('`')) {
        nested += 1;
      }
    }
    if (!closed) return true;
  }
  return false;
}
