/** Terminal helpers shared by the chat and the agent. Colors only on a real terminal. */

export const tty = process.stdout.isTTY === true;
export const dim = (text: string): string => (tty ? `\x1b[2m${text}\x1b[22m` : text);
export const red = (text: string): string => (tty ? `\x1b[31m${text}\x1b[39m` : text);
export const green = (text: string): string => (tty ? `\x1b[32m${text}\x1b[39m` : text);
export const yellow = (text: string): string => (tty ? `\x1b[33m${text}\x1b[39m` : text);

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
