/**
 * Text from the model, from commands and from MCP servers is untrusted. Printed raw,
 * an escape sequence can recolor the screen, move the cursor, rewrite a line already
 * shown or set the clipboard; a carriage return, a bidi control or a zero-width
 * character can hide part of a command the user is asked to approve. Everything that
 * reaches the terminal goes through sanitize(), which makes those characters visible.
 */

/**
 * C0 and C1 controls with DEL (ESC among them, so no escape sequence survives), line
 * and paragraph separators, format characters (bidi controls, zero-width characters,
 * tags), the other default-ignorable code points (variation selectors, fillers) and
 * lone surrogates. Newline and tab are kept in multi-line text.
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Cs}]/gu;

const NAMED: Record<string, string> = {
  '\0': '\\0',
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\v': '\\v',
  '\f': '\\f',
  '\r': '\\r',
};

export interface Sanitized {
  text: string;
  /** How many characters were replaced by a visible escape. */
  hidden: number;
}

export interface SanitizeOptions {
  /** Keep newlines and tabs (default). Off for one-line fields, where a newline could fake a line of the UI. */
  multiline?: boolean;
}

/** Replaces every hidden or control character with a visible escape: \x1b, \r, \u{202e}. */
export function sanitize(text: string, options: SanitizeOptions = {}): Sanitized {
  const multiline = options.multiline ?? true;
  let hidden = 0;
  const out = text.replace(HIDDEN, (char) => {
    if (multiline && (char === '\n' || char === '\t')) return char;
    hidden += 1;
    return escape(char);
  });
  return { text: out, hidden };
}

/** Text for the terminal: Windows line endings become plain newlines, the rest is sanitized. */
export function safe(text: string): string {
  return sanitize(text.replace(/\r\n/g, '\n')).text;
}

/** A one-line field (a name, a path, a summary): newlines and tabs are escaped too. */
export function safeLine(text: string): string {
  return sanitize(text, { multiline: false }).text;
}

/** Hidden characters anywhere in a value: strings, and the keys and items of objects and lists. */
export function countHidden(value: unknown): number {
  if (typeof value === 'string') return sanitize(value).hidden;
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + countHidden(item), 0);
  if (typeof value === 'object' && value !== null) {
    let sum = 0;
    for (const [key, item] of Object.entries(value)) sum += countHidden(key) + countHidden(item);
    return sum;
  }
  return 0;
}

function escape(char: string): string {
  const named = NAMED[char];
  if (named !== undefined) return named;
  const code = char.codePointAt(0) ?? 0;
  return code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u{${code.toString(16)}}`;
}
