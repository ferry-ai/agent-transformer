import { spawn } from 'node:child_process';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { processGroups, type ProcessGroups } from './processes.js';

export interface CommandOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** The whole environment of the command. Default: commandEnvironment(), never process.env. */
  env?: Record<string, string>;
  /** Where the command's process group is tracked until nothing in it is left. Default: processGroups. */
  groups?: ProcessGroups;
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
 * process tree on timeout or abort. What it leaves running stays tracked, and is
 * killed when the agent exits (processes.ts).
 */
export function runCommand(command: string, options: CommandOptions): Promise<CommandResult> {
  return collect(command, [], { cwd: options.cwd, env: options.env ?? commandEnvironment(), shell: true }, options);
}

export interface ProcessOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Required: a program of ours (the container runtime's CLI) may need more than commandEnvironment(). */
  env: NodeJS.ProcessEnv;
  cwd?: string;
  groups?: ProcessGroups;
}

/** Runs a program with its arguments, no shell in between: the container runtime's CLI. */
export function runProcess(file: string, args: string[], options: ProcessOptions): Promise<CommandResult> {
  return collect(file, args, { cwd: options.cwd, env: options.env, shell: false }, options);
}

function collect(
  file: string,
  args: string[],
  how: { cwd?: string; env: NodeJS.ProcessEnv; shell: boolean },
  options: { timeoutMs: number; signal?: AbortSignal; groups?: ProcessGroups },
): Promise<CommandResult> {
  const started = Date.now();
  const windows = process.platform === 'win32';
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: how.cwd,
      env: how.env,
      shell: how.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so a timeout kills what the command started too.
      detached: !windows,
      windowsHide: true,
    });
    const groups = options.groups ?? processGroups;
    if (child.pid !== undefined) groups.add(child.pid);
    let output = '';
    let dropped = 0;
    let timedOut = false;
    let closed = false;
    const collectChunk = (chunk: Buffer): void => {
      if (output.length < MAX_OUTPUT) output += chunk.toString('utf8');
      else dropped += chunk.length;
    };
    child.stdout.on('data', collectChunk);
    child.stderr.on('data', collectChunk);

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
      if (child.pid !== undefined) groups.release(child.pid);
      options.signal?.removeEventListener('abort', kill);
      if (dropped > 0) output += `\n[… ${dropped} more bytes of output dropped …]`;
      resolve({ exitCode, signal, output, timedOut, durationMs: Date.now() - started });
    });
  });
}

/**
 * Where run_command runs commands: on the host, or in a sandbox container
 * (sandbox.ts). Every approval prompt shows "where" and "warnings".
 */
export interface CommandRunner {
  /** "[sandbox: docker, network off]" or "[HOST, not sandboxed]". */
  readonly where: string;
  /** Shown in every approval prompt, such as why the command is not sandboxed. */
  readonly warnings: readonly string[];
  /** The folder commands start in, as they see it. */
  readonly cwd: string;
  /** One sentence for the model on where its commands run. */
  readonly note: string;
  run(command: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<CommandResult>;
  /** Removes what the runner created (a container). */
  close(): Promise<void>;
  /** The same, synchronously, for an exit handler. */
  closeSync(): void;
}

export interface HostRunnerOptions {
  root: string;
  passEnv?: readonly string[];
  /** Why there is no sandbox, when one was wanted: repeated in every approval prompt. */
  fallback?: string;
  groups?: ProcessGroups;
}

/** Commands on the user's machine, with an allowlisted environment. Not a sandbox. */
export class HostRunner implements CommandRunner {
  readonly where = '[HOST, not sandboxed]';
  readonly warnings: readonly string[];
  readonly cwd: string;
  readonly note: string;
  private readonly options: HostRunnerOptions;

  constructor(options: HostRunnerOptions) {
    this.options = options;
    this.cwd = options.root;
    this.warnings = options.fallback === undefined ? [] : [`Not sandboxed: ${options.fallback} The command runs on your machine with your permissions.`];
    this.note = `Commands run on the user's machine, in ${options.root}.`;
  }

  run(command: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<CommandResult> {
    const run: CommandOptions = { cwd: this.cwd, env: commandEnvironment(this.options.passEnv), timeoutMs: options.timeoutMs };
    if (options.signal) run.signal = options.signal;
    if (this.options.groups) run.groups = this.options.groups;
    return runCommand(command, run);
  }

  async close(): Promise<void> {}

  closeSync(): void {}
}
