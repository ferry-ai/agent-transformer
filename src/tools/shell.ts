import { spawn } from 'node:child_process';

export interface CommandOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** stdout and stderr interleaved, in the order they arrived. */
  output: string;
  timedOut: boolean;
  durationMs: number;
}

/** Longest output kept in memory; the toolbox cuts it further before it reaches the chat. */
const MAX_OUTPUT = 1_000_000;

/**
 * Runs a command line through the system shell, with no input, and kills the whole
 * process tree on timeout or abort.
 */
export function runCommand(command: string, options: CommandOptions): Promise<CommandResult> {
  const started = Date.now();
  const windows = process.platform === 'win32';
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so a timeout kills what the command started too.
      detached: !windows,
      windowsHide: true,
    });
    let output = '';
    let dropped = 0;
    let timedOut = false;
    let closed = false;
    const collect = (chunk: Buffer): void => {
      if (output.length < MAX_OUTPUT) output += chunk.toString('utf8');
      else dropped += chunk.length;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const kill = (): void => {
      // Not "exitCode": the shell may be gone while what it started still holds the pipes.
      if (child.pid === undefined || closed) return;
      if (windows) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    options.signal?.addEventListener('abort', kill, { once: true });
    if (options.signal?.aborted) kill();

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (exitCode, signal) => {
      closed = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', kill);
      if (dropped > 0) output += `\n[… ${dropped} more bytes of output dropped …]`;
      resolve({ exitCode, signal, output, timedOut, durationMs: Date.now() - started });
    });
  });
}
