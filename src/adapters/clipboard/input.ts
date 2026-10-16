import type { Interface } from 'node:readline';

/** One thing the user did at the terminal while the adapter waited. */
export type InputEvent =
  | { kind: 'line'; text: string }
  /** The input is closed (end of stdin, or Ctrl+C pressed twice): nobody will answer. */
  | { kind: 'closed' }
  /** Ctrl+C: stop waiting. */
  | { kind: 'interrupt' };

/**
 * The terminal as the clipboard adapter reads it. The agent CLI already reads stdin
 * with readline (tasks, approvals): the adapter borrows that same interface between
 * two of its questions instead of opening a second one on the same terminal.
 */
export interface UserInput {
  /** Starts listening. Until close(), no line is lost, even in a long paste. */
  listen(): InputSession;
}

export interface InputSession {
  /** The next line; `prompt` is shown first when none is waiting. */
  next(prompt: string): Promise<InputEvent>;
  /**
   * Waits until nothing more arrives for a moment and returns what did: the rest of a
   * paste. Swallowed here, it cannot reach a later prompt, such as an approval.
   */
  drain(): Promise<string[]>;
  /** Stops listening. Lines typed later go back to whoever asks next. */
  close(): void;
}

export interface ReadlineInputOptions {
  /** Silence that ends a paste (default 300 ms). */
  quietMs?: number;
  /** Longest wait in drain() (default 5 s). */
  maxDrainMs?: number;
}

/**
 * A UserInput on the agent CLI's readline. While a session is open, every line goes to
 * the 'line' listener (the CLI has no question pending), so a pasted block arrives
 * whole, and Ctrl+C becomes an 'interrupt'. The CLI's own prompt is put back after.
 */
export function readlineInput(rl: Interface, options: ReadlineInputOptions = {}): UserInput {
  const quietMs = options.quietMs ?? 300;
  const maxDrainMs = options.maxDrainMs ?? 5_000;
  let closed = false;
  rl.once('close', () => {
    closed = true;
  });

  return {
    listen(): InputSession {
      const queue: InputEvent[] = [];
      let waiter: ((event: InputEvent) => void) | undefined;
      let lastLineAt = Date.now();
      let open = true;
      const savedPrompt = rl.getPrompt();
      const push = (event: InputEvent): void => {
        const wake = waiter;
        waiter = undefined;
        if (wake) wake(event);
        else queue.push(event);
      };
      const onLine = (line: string): void => {
        lastLineAt = Date.now();
        push({ kind: 'line', text: line });
      };
      const onClose = (): void => push({ kind: 'closed' });
      const onInterrupt = (): void => push({ kind: 'interrupt' });
      rl.on('line', onLine);
      rl.on('close', onClose);
      rl.on('SIGINT', onInterrupt);

      return {
        next(prompt: string): Promise<InputEvent> {
          const queued = queue.shift();
          if (queued) return Promise.resolve(queued);
          if (closed || !open) return Promise.resolve({ kind: 'closed' });
          rl.setPrompt(prompt);
          rl.prompt();
          return new Promise((resolve) => {
            waiter = resolve;
          });
        },
        async drain(): Promise<string[]> {
          const started = Date.now();
          for (;;) {
            const quietFor = Date.now() - lastLineAt;
            if (closed || quietFor >= quietMs || Date.now() - started >= maxDrainMs) break;
            await new Promise((done) => setTimeout(done, quietMs - quietFor));
          }
          return queue.splice(0).flatMap((event) => (event.kind === 'line' ? [event.text] : []));
        },
        close(): void {
          if (!open) return;
          open = false;
          rl.off('line', onLine);
          rl.off('close', onClose);
          rl.off('SIGINT', onInterrupt);
          if (!closed) rl.setPrompt(savedPrompt);
          push({ kind: 'closed' });
        },
      };
    },
  };
}
