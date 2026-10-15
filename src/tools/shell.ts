import { spawn } from 'node:child_process';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface CommandOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** The whole environment of the command. Default: commandEnvironment(), never process.env. */
  env?: Record<string, string>;
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

/** Language, encoding and time zone: harmless, and commands print differently without them. */
const LOCALE = /^(LANG|LANGUAGE|LC_[A-Z_]+|TZ)$/;
/** What cmd.exe needs to find and start programs. */
const WINDOWS_BASICS = ['PATHEXT', 'COMSPEC', 'WINDIR'];

/**
 * The environment of a command run on the host. Not process.env: its tokens and cloud
 * credentials would be one "env" away from the chat. Only the basics the MCP SDK gives
 * its local servers (PATH, HOME, USER, SHELL, TERM...), the locale, and the variables
 * the user names with --pass-env.
 */
export function commandEnvironment(passEnv: readonly string[] = []): Record<string, string> {
  const env: Record<string, string> = getDefaultEnvironment();
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && LOCALE.test(name)) env[name] = value;
  }
  if (process.platform === 'win32') {
    for (const name of WINDOWS_BASICS) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
  }
  for (const name of passEnv) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** A name --pass-env accepts. */
export function isEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

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
      env: options.env ?? commandEnvironment(),
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
