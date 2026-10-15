/**
 * Terminal helpers shared by the chat and the agent. Colors only on a real terminal.
 * The color helpers sanitize what they wrap, so styled text never carries an escape
 * sequence of its own; plain text from the model, commands or servers goes through
 * safe() (see tools/sanitize.ts). Do not nest them: the inner colors would be escaped.
 */
import { safe, safeLine } from './tools/sanitize.js';

export { safe, safeLine };

export const tty = process.stdout.isTTY === true;
const paint = (open: number, close: number) => (text: string): string =>
  tty ? `\x1b[${open}m${safe(text)}\x1b[${close}m` : safe(text);
export const dim = paint(2, 22);
export const red = paint(31, 39);
export const green = paint(32, 39);
export const yellow = paint(33, 39);

/** A one-line elapsed-time counter; returns the function that clears it. */
export function ticker(label: string): () => void {
  if (!tty) return () => undefined;
  const started = Date.now();
  const draw = (): void => {
    process.stdout.write(`\r${dim(`${label}… ${Math.round((Date.now() - started) / 1000)}s`)}`);
  };
  draw();
  const timer = setInterval(draw, 1000);
  return () => {
    clearInterval(timer);
    process.stdout.write('\r\x1b[2K');
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
