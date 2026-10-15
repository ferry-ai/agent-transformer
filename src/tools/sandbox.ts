import { execFile, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { hostname } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { HostRunner, runProcess, type CommandResult, type CommandRunner } from './shell.js';
import { ToolError } from './types.js';

/**
 * The sandbox for run_command: one container per session, created at the first
 * command and removed at exit. It sees the workspace and nothing else of the host:
 *
 *   - only the workspace is mounted, at /workspace, with .git read-only (git hooks
 *     and config written there would run on the host at the next git command) and
 *     the data dir hidden when it lies inside; no home, no Docker socket, no SSH agent;
 *   - no host environment: HOME, TMPDIR and LANG, plus what --pass-env names;
 *   - no network unless --sandbox-network; all capabilities dropped,
 *     no-new-privileges, a read-only root with tmpfs for /tmp and HOME, limits on
 *     processes, memory and CPU;
 *   - on Linux it runs as the host user (Podman: --userns=keep-id), so the files it
 *     writes keep their owner.
 *
 * The image is never pulled without asking. Containers are labelled with the
 * session and its owner (host and pid), so the next start removes those a crashed
 * session left behind.
 */

export type SandboxChoice = 'auto' | 'docker' | 'podman' | 'none';
export type Runtime = 'docker' | 'podman';

/** Node with git, curl, python3 and a C toolchain: what coding tasks usually need. */
export const DEFAULT_SANDBOX_IMAGE = 'docker.io/library/node:24-bookworm';
export const CONTAINER_WORKSPACE = '/workspace';
const CONTAINER_HOME = '/home/sandbox';
export const SESSION_LABEL = 'agent-transformer.session';
export const OWNER_LABEL = 'agent-transformer.owner';
export const LIMITS = { memory: '2g', cpus: '2', pids: 512 } as const;

export interface ExecResult {
  /** Exit code; null when the program could not run or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the runtime's CLI and waits for it. Replaceable in tests. */
export type Exec = (file: string, args: string[], options?: { timeoutMs?: number }) => Promise<ExecResult>;
/** Runs one command through the runtime's CLI, collecting its output like runCommand. Replaceable in tests. */
export type Spawn = (file: string, args: string[], options: { timeoutMs: number; signal?: AbortSignal }) => Promise<CommandResult>;
/** The same as Exec, synchronously, for the exit handler. */
export type ExecSync = (file: string, args: string[]) => void;

export const execRuntime: Exec = (file, args, options = {}) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: options.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) || (error && code === null ? error.message : '') });
    });
  });

const spawnRuntime: Spawn = (file, args, options) => runProcess(file, args, { ...options, env: process.env });

const execRuntimeSync: ExecSync = (file, args) => {
  spawnSync(file, args, { stdio: 'ignore', timeout: 20_000, windowsHide: true });
};

export interface ContainerSettings {
  runtime: Runtime;
  /** The runtime's CLI. */
  binary: string;
  image: string;
  /** The real path of the workspace on the host. */
  workspace: string;
  network: boolean;
  /** The real path of the data dir: hidden in the container when it lies inside the workspace. */
  dataDir?: string;
  /** Variables given to the container by name: their values never appear on a command line. */
  passEnv: readonly string[];
  session: string;
  /** "host:pid" of the agent that owns the container. */
  owner: string;
  /** "uid:gid" to run as. Undefined: the image's user (rootless Docker, Docker Desktop). */
  user?: string;
  /** Podman: map the host user to the same uid in the container. */
  keepId?: boolean;
  /** The workspace has a .git (folder, or file of a worktree): mounted read-only. */
  gitDir: boolean;
}

export function containerName(session: string): string {
  return `agent-transformer-${session}`;
}

/** The data dir relative to the workspace, "/"-separated, when it lies inside it. */
function hiddenDataDir(settings: ContainerSettings): string | undefined {
  if (settings.dataDir === undefined) return undefined;
  const rel = relative(settings.workspace, settings.dataDir);
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return undefined;
  return rel.split(sep).join('/');
}

/** The "run" command line that creates the session's container. */
export function runArgs(settings: ContainerSettings): string[] {
  const args = [
    'run',
    '--detach',
    '--rm',
    '--name',
    containerName(settings.session),
    '--label',
    `${SESSION_LABEL}=${settings.session}`,
    '--label',
    `${OWNER_LABEL}=${settings.owner}`,
    '--pull=never',
    '--init',
    '--hostname',
    'sandbox',
  ];
  if (!settings.network) args.push('--network', 'none');
  args.push(
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=1g,mode=1777',
    '--tmpfs',
    `${CONTAINER_HOME}:rw,nosuid,nodev,size=512m,mode=1777`,
    '--pids-limit',
    String(LIMITS.pids),
    '--memory',
    LIMITS.memory,
    '--memory-swap',
    LIMITS.memory,
    '--cpus',
    LIMITS.cpus,
    '--mount',
    `type=bind,source=${settings.workspace},target=${CONTAINER_WORKSPACE}`,
  );
  if (settings.gitDir) {
    args.push('--mount', `type=bind,source=${join(settings.workspace, '.git')},target=${CONTAINER_WORKSPACE}/.git,readonly`);
  }
  const hidden = hiddenDataDir(settings);
  if (hidden !== undefined) {
    // An empty tmpfs nobody may open, over the profile, the logs and the tokens.
    args.push('--mount', `type=tmpfs,target=${CONTAINER_WORKSPACE}/${hidden},tmpfs-size=4096,tmpfs-mode=0`);
  }
  args.push('--workdir', CONTAINER_WORKSPACE, '--env', `HOME=${CONTAINER_HOME}`, '--env', 'TMPDIR=/tmp', '--env', 'LANG=C.UTF-8');
  for (const name of settings.passEnv) args.push('--env', name);
  if (settings.keepId) args.push('--userns=keep-id');
  if (settings.user !== undefined) args.push('--user', settings.user);
  // Any POSIX shell will do: "sleep infinity" is not in every image.
  args.push(settings.image, 'sh', '-c', 'while :; do sleep 86400; done');
  return args;
}

const pidFile = (run: string): string => `/tmp/.agent-run-${run}`;

/**
 * Runs the command in a session of its own and writes its pid (the group id) where
 * the kill below finds it. "setsid -w" keeps docker exec waiting for the command.
 */
const WRAPPER =
  'f="$1"; c="$2"; ' +
  `if [ "$3" = setsid ]; then exec setsid -w sh -c 'echo $$ > "$0"; exec sh -c "$1"' "$f" "$c"; fi; ` +
  'echo $$ > "$f"; exec sh -c "$c"';

/**
 * Kills the run's process group inside the container; exit code 3 when there is no pid
 * to kill. "kill -KILL -PID", not "kill -- -PID": dash's kill does not take "--".
 */
const KILL =
  'p=$(cat "$1" 2>/dev/null); case "$p" in ""|*[!0-9]*) exit 3;; esac; [ "$p" -gt 1 ] || exit 3; ' +
  'kill -KILL "-$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null; rm -f "$1"';

/** The "exec" command line of one command. The command is one argument: no shell on the host reads it. */
export function execArgs(name: string, run: string, command: string, treeKill: boolean): string[] {
  return ['exec', '--workdir', CONTAINER_WORKSPACE, name, 'sh', '-c', WRAPPER, 'sh', pidFile(run), command, treeKill ? 'setsid' : 'plain'];
}

export function killArgs(name: string, run: string): string[] {
  return ['exec', name, 'sh', '-c', KILL, 'sh', pidFile(run)];
}

export interface ContainerDeps {
  exec: Exec;
  spawn: Spawn;
  execSync: ExecSync;
  /** Something the user must know that is not part of a command's output. */
  notify: (message: string) => void;
}

/** Runs every command of the session in its container. */
export class ContainerRunner implements CommandRunner {
  readonly where: string;
  readonly warnings: readonly string[] = [];
  readonly cwd = CONTAINER_WORKSPACE;
  readonly note: string;
  readonly name: string;
  private readonly settings: ContainerSettings;
  private readonly deps: ContainerDeps;
  private starting?: Promise<void>;
  private started = false;
  private treeKill = false;
  private runs = 0;
  private warnedGit: boolean;

  constructor(settings: ContainerSettings, deps: ContainerDeps) {
    this.settings = settings;
    this.deps = deps;
    this.name = containerName(settings.session);
    this.where = `[sandbox: ${settings.runtime}, network ${settings.network ? 'ON' : 'off'}]`;
    this.note =
      `Commands run in a ${settings.runtime} container${settings.network ? '' : ' without network access'}, ` +
      `with the workspace mounted at ${CONTAINER_WORKSPACE} (the working directory). Only the workspace persists; ` +
      '.git is read-only there.';
    this.warnedGit = settings.gitDir;
  }

  async run(command: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<CommandResult> {
    await this.start();
    this.runs += 1;
    const run = `${this.settings.session}-${this.runs}`;
    const local = new AbortController();
    let timedOut = false;
    let stopping: Promise<void> | undefined;
    // Killing the local client is not enough: the command would go on inside the container.
    const stop = (): void => {
      stopping ??= this.killInside(run).finally(() => local.abort());
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) stop();
    try {
      const result = await this.deps.spawn(this.settings.binary, execArgs(this.name, run, command, this.treeKill), {
        timeoutMs: options.timeoutMs + 60_000,
        signal: local.signal,
      });
      await stopping;
      if ((result.exitCode === 125 || result.exitCode === 126) && /no such container|is not running/i.test(result.output)) {
        this.started = false;
        this.starting = undefined;
        result.output += '\n[The sandbox container had stopped: a new one starts with the next command.]';
      }
      this.checkGit();
      return { ...result, timedOut: timedOut || result.timedOut };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', stop);
    }
  }

  async close(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.deps.exec(this.settings.binary, ['rm', '--force', this.name], { timeoutMs: 30_000 });
  }

  closeSync(): void {
    if (!this.started) return;
    this.started = false;
    this.deps.execSync(this.settings.binary, ['rm', '--force', this.name]);
  }

  private start(): Promise<void> {
    this.starting ??= (async () => {
      const created = await this.deps.exec(this.settings.binary, runArgs(this.settings), { timeoutMs: 120_000 });
      if (created.code !== 0) {
        throw new ToolError(`The sandbox container did not start, so the command did not run: ${tail(created.stderr || created.stdout)}`);
      }
      this.started = true;
      const probe = await this.deps.exec(
        this.settings.binary,
        ['exec', this.name, 'sh', '-c', 'command -v setsid >/dev/null 2>&1 && setsid -w true'],
        { timeoutMs: 30_000 },
      );
      this.treeKill = probe.code === 0;
      if (!this.treeKill) {
        this.deps.notify('The sandbox image has no "setsid -w": stopping a command will restart its container.');
      }
    })().catch((error: unknown) => {
      this.starting = undefined;
      throw error;
    });
    return this.starting;
  }

  private async killInside(run: string): Promise<void> {
    const killed = await this.deps.exec(this.settings.binary, killArgs(this.name, run), { timeoutMs: 20_000 });
    if (this.treeKill && killed.code === 0) return;
    // Not sure that everything the command started is dead: a restart kills every process in the container.
    this.deps.notify('Restarting the sandbox container to stop the command: what ran in the background there is gone.');
    await this.deps.exec(this.settings.binary, ['restart', '--time', '0', this.name], { timeoutMs: 60_000 });
  }

  /** The sandbox cannot write the read-only .git, but it can create one where there was none. */
  private checkGit(): void {
    if (this.warnedGit) return;
    const root = this.settings.workspace;
    const bare = ['HEAD', 'objects', 'refs'].every((name) => existsSync(join(root, name)));
    if (!existsSync(join(root, '.git')) && !bare) return;
    this.warnedGit = true;
    this.deps.notify(
      `A command in the sandbox created a git repository in the workspace (${bare ? 'HEAD, objects, refs' : '.git'}). ` +
        'Its config and hooks were written by the model and can run code on your machine at the next git command ' +
        '(even from a shell prompt): check them, or remove them, before using git there.',
    );
  }
}

export interface RuntimeInfo {
  runtime: Runtime;
  binary: string;
  rootless: boolean;
}

/** The first runtime that answers "info": installed and with a daemon (or Podman) ready. */
export async function detectRuntime(
  choice: Exclude<SandboxChoice, 'none'>,
  exec: Exec,
): Promise<{ info?: RuntimeInfo; problems: string[] }> {
  const problems: string[] = [];
  const candidates: Runtime[] = choice === 'auto' ? ['docker', 'podman'] : [choice];
  for (const runtime of candidates) {
    const format = runtime === 'docker' ? '{{json .SecurityOptions}}' : '{{.Host.Security.Rootless}}';
    const result = await exec(runtime, ['info', '--format', format], { timeoutMs: 20_000 });
    if (result.code === 0) {
      const rootless = runtime === 'docker' ? result.stdout.includes('rootless') : result.stdout.trim() === 'true';
      return { info: { runtime, binary: runtime, rootless }, problems };
    }
    problems.push(result.code === null && /ENOENT/.test(result.stderr) ? `${runtime} is not installed` : `${runtime} is not running (${tail(result.stderr, 1)})`);
  }
  return { problems };
}

/** Removes the containers of sessions on this host whose agent is gone. Returns their ids. */
export async function removeStaleContainers(
  binary: string,
  exec: Exec,
  isAlive: (pid: number) => boolean = pidAlive,
  host: string = hostname(),
): Promise<string[]> {
  const listed = await exec(binary, ['ps', '--all', '--quiet', '--filter', `label=${SESSION_LABEL}`]);
  const ids = listed.code === 0 ? listed.stdout.split(/\s+/).filter(Boolean) : [];
  if (ids.length === 0) return [];
  const inspected = await exec(binary, ['inspect', '--format', `{{.Id}} {{index .Config.Labels "${OWNER_LABEL}"}}`, ...ids]);
  const stale: string[] = [];
  for (const line of inspected.stdout.split('\n')) {
    const [id, owner = ''] = line.trim().split(/\s+/);
    const at = owner.lastIndexOf(':');
    const pid = Number(owner.slice(at + 1));
    // Another host may share the daemon: only its own agent knows whether its session is over.
    if (id && at > 0 && owner.slice(0, at) === host && Number.isInteger(pid) && pid > 0 && !isAlive(pid)) stale.push(id);
  }
  if (stale.length > 0) await exec(binary, ['rm', '--force', ...stale], { timeoutMs: 60_000 });
  return stale;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface SandboxOptions {
  choice: SandboxChoice;
  image: string;
  network: boolean;
  workspace: string;
  dataDir: string;
  passEnv: readonly string[];
  /** Asks the user a yes/no question; must answer no without a terminal. */
  confirm: (question: string) => Promise<boolean>;
  notify: (message: string) => void;
  exec?: Exec;
  spawn?: Spawn;
  execSync?: ExecSync;
  /** Defaults: this machine's. */
  platform?: NodeJS.Platform;
  uid?: number;
  gid?: number;
}

/**
 * Picks where commands run. "none": the host. "docker" or "podman": that runtime, or
 * an error when it is not available. "auto": a container when Docker or Podman is
 * available, otherwise the host with a warning. A missing image is pulled only after
 * the user says yes; otherwise it is an error, never a quiet switch to the host.
 */
export async function createCommandRunner(options: SandboxOptions): Promise<CommandRunner> {
  const exec = options.exec ?? execRuntime;
  if (options.choice === 'none') return new HostRunner({ root: options.workspace, passEnv: options.passEnv });

  const { info, problems } = await detectRuntime(options.choice, exec);
  if (info === undefined) {
    if (options.choice !== 'auto') throw new Error(`--sandbox ${options.choice}: ${problems.join('; ')}.`);
    options.notify(
      `⚠ Not sandboxed: no container runtime is available (${problems.join('; ')}). Commands will run on your machine ` +
        'with your permissions, and every approval prompt will say so. Install Docker or Podman for a sandbox, ' +
        'or pass --sandbox none to choose this on purpose.',
    );
    return new HostRunner({ root: options.workspace, passEnv: options.passEnv, fallback: 'no Docker or Podman was found.' });
  }

  const workspace = await realpath(options.workspace);
  const dataDir = await realpath(options.dataDir).catch(() => options.dataDir);
  for (const path of [workspace, dataDir]) {
    if (/[,"\r\n]/.test(path)) {
      throw new Error(`The sandbox cannot mount ${JSON.stringify(path)}: commas, quotes and newlines break mount options. Rename the folder, or run with --sandbox none.`);
    }
  }

  const removed = await removeStaleContainers(info.binary, exec);
  if (removed.length > 0) {
    options.notify(`Removed ${removed.length} sandbox container${removed.length === 1 ? '' : 's'} left by a session that did not exit cleanly.`);
  }

  const present = await exec(info.binary, ['image', 'inspect', '--format', '{{.Id}}', options.image], { timeoutMs: 30_000 });
  if (present.code !== 0) {
    const pull = `${info.binary} pull ${options.image}`;
    const yes = await options.confirm(`The sandbox image ${options.image} is not on this machine. Download it now ("${pull}")?`);
    if (!yes) {
      throw new Error(
        `The sandbox image ${options.image} is missing. Download it with "${pull}", choose another with --sandbox-image, ` +
          'or run with --sandbox none.',
      );
    }
    options.notify(`Downloading ${options.image}…`);
    const pulled = await exec(info.binary, ['pull', options.image], { timeoutMs: 30 * 60_000 });
    if (pulled.code !== 0) throw new Error(`"${pull}" failed: ${tail(pulled.stderr || pulled.stdout)}`);
  }

  const platform = options.platform ?? process.platform;
  const uid = options.uid ?? process.getuid?.();
  const gid = options.gid ?? process.getgid?.();
  const settings: ContainerSettings = {
    runtime: info.runtime,
    binary: info.binary,
    image: options.image,
    workspace,
    network: options.network,
    dataDir,
    passEnv: options.passEnv,
    session: randomBytes(6).toString('hex'),
    owner: `${hostname()}:${process.pid}`,
    gitDir: existsSync(join(workspace, '.git')),
  };
  // Linux only: Docker Desktop (macOS, Windows) maps file owners itself. Rootless Docker's root is the host user.
  if (platform === 'linux' && uid !== undefined && gid !== undefined) {
    if (info.runtime === 'podman') {
      if (uid !== 0) settings.keepId = true;
      settings.user = `${uid}:${gid}`;
    } else if (!info.rootless) settings.user = `${uid}:${gid}`;
  }
  return new ContainerRunner(settings, {
    exec,
    spawn: options.spawn ?? spawnRuntime,
    execSync: options.execSync ?? execRuntimeSync,
    notify: options.notify,
  });
}

function tail(text: string, lines = 3): string {
  return text.trim().split('\n').slice(-lines).join(' ').slice(0, 500) || 'no details';
}
