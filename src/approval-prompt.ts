import { sanitize } from './tools/sanitize.js';
import type { Approve, ApprovalRequest } from './tools/types.js';

export interface RenderOptions {
  /** Colors for our own parts of the prompt; never applied to text from the model. */
  color?: boolean;
}

/**
 * The approval prompt. Everything in it that comes from the model or a server is
 * sanitized, one-line fields with their newlines escaped too, and the multi-line
 * detail (the whole command, the full arguments) sits behind a "│ " gutter: none of
 * its lines can pass for a line of the prompt itself.
 */
export function renderApproval(request: ApprovalRequest, options: RenderOptions = {}): string {
  const style = (open: number, close: number) => (text: string) =>
    options.color ? `\x1b[${open}m${text}\x1b[${close}m` : text;
  const yellow = style(33, 39);
  const red = style(31, 39);
  const bold = style(1, 22);

  const tool = sanitize(request.tool, { multiline: false });
  const summary = sanitize(request.summary, { multiline: false });
  const where = request.where === undefined ? undefined : sanitize(request.where, { multiline: false });
  // Not split on \r: a carriage return inside a line must show as \r, not start a new line.
  const detail = request.detail === undefined ? undefined : sanitize(request.detail);
  const shownHidden = tool.hidden + summary.hidden + (where?.hidden ?? 0) + (detail?.hidden ?? 0);
  // The toolbox counts on the raw arguments, before JSON or other escaping: take the larger count.
  const hidden = Math.max(request.hidden, shownHidden);

  const body = detail?.text.split('\n') ?? [];
  const size = body.length > 1 ? ` (${body.length} lines)` : '';
  const lines = [`${yellow(`? ${tool.text}`)}${where ? ` ${bold(where.text)}` : ''} wants to ${summary.text}${size}`];
  for (const line of body) lines.push(`  │ ${line}`);
  for (const warning of request.warnings ?? []) lines.push(red(`  ⚠ ${sanitize(warning, { multiline: false }).text}`));
  if (hidden > 0) {
    lines.push(
      red(
        `  ⚠ The call contains ${hidden} invisible or control character${hidden === 1 ? '' : 's'}, ` +
          'shown above as \\x.. or \\u{..}: they can hide what really runs.',
      ),
    );
  }
  return lines.join('\n');
}

export interface ApproverOptions {
  /** Reads one answer; null when the input is closed. */
  ask: (prompt: string) => Promise<string | null>;
  print: (text: string) => void;
  /** Both stdin and stdout are terminals: a person can see the prompt and answer it. */
  interactive: boolean;
  color?: boolean;
}

/** Asks the user. Without a terminal, or once the input is closed, every request is denied. */
export function createApprover(options: ApproverOptions): Approve {
  return async (request) => {
    options.print(renderApproval(request, { color: options.color }));
    if (!options.interactive) {
      options.print('Denied: approvals need a terminal (stdin and stdout must be a TTY).');
      return { approved: false, note: 'There is no terminal to ask the user, so calls that need approval are denied.' };
    }
    const answer = await options.ask('Allow? [y/N, or write a note for the model] ');
    const text = answer?.trim() ?? '';
    if (/^(y|yes|s|si|sì)$/i.test(text)) return { approved: true };
    if (text === '' || /^(n|no)$/i.test(text)) return { approved: false };
    return { approved: false, note: text };
  };
}
