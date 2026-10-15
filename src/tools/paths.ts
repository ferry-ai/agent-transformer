import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, readlink, realpath, stat, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sanitize } from './sanitize.js';
import { ToolError } from './types.js';

/**
 * The path policy: the one place that decides what the file tools may touch. The
 * model is untrusted, so every path it gives is checked here, in code:
 *
 * - it must stay inside the workspace, symbolic links resolved (a dangling one too);
 * - anything with a ".git" segment is refused: hooks and settings such as
 *   core.fsmonitor run code at the next git command;
 * - the data dir is refused even when it lies inside the workspace: it holds the
 *   browser profile with its cookies, the session logs and mcp.json with its tokens;
 * - reading a likely secret asks first, since whatever the agent reads goes to the
 *   chat provider; writing a file that runs code by itself (.envrc, git hooks,
 *   editor tasks, CI workflows) or a file with other hard links asks first too.
 *
 * Names are compared folded: case, Unicode normalization, the characters HFS+
 * ignores, and the trailing dots, spaces and ":stream" suffixes Windows drops. That is
 * stricter than needed on Linux, but a workspace there can still sit on a
 * case-insensitive disk (a WSL /mnt/c folder, a USB stick).
 */

export type PathAccess = 'read' | 'write' | 'edit' | 'list';

export interface PathPolicyOptions {
  /** The workspace. */
  root: string;
  /** Where the agent keeps profiles, sessions, checkpoints and mcp.json: never reachable. */
  dataDir?: string;
  /** Whose file name rules apply (reserved device names, alternate data streams). Default: this machine's. */
  platform?: NodeJS.Platform;
}

export interface CheckedPath {
  /** Where the operation goes: symbolic links resolved for the part that exists. */
  real: string;
  /** The path relative to the workspace, with "/" separators, for messages. */
  display: string;
  /** Why the user must be asked first; empty when nothing needs asking. */
  reasons: string[];
  /** What is there now, when something is. */
  info?: BigIntStats;
}

/** Larger files are refused by read_file and edit_file instead of filling the memory. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
// Opening a FIFO for reading would block until someone writes to it.
const NONBLOCK = constants.O_NONBLOCK ?? 0;

const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/;

/** The secrets asked about before reading, by file name. */
const SECRET_NAMES: readonly ((name: string) => boolean)[] = [
  (name) => name.startsWith('.env'),
  (name) => name.endsWith('.pem') || name.endsWith('.key') || name.endsWith('.p12') || name.endsWith('.pfx'),
  (name) => ['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa'].some((key) => name.startsWith(key)),
  (name) => ['.npmrc', '.pypirc', '.netrc', '_netrc', '.pgpass', '.git-credentials'].includes(name),
  (name) => name.startsWith('credentials'),
];

/** Files that run code by themselves, by file name, and why. */
const AUTORUN_NAMES: Record<string, string> = {
  '.envrc': 'direnv runs it when you enter the folder',
  '.npmrc': 'npm reads it, and it can redirect installs or run scripts',
  '.yarnrc': 'yarn reads it, and it can run code or redirect installs',
  '.yarnrc.yml': 'yarn reads it, and its yarnPath runs code',
  '.pnpmfile.cjs': 'pnpm runs it on every install',
  '.pre-commit-config.yaml': 'pre-commit runs its hooks at every git commit',
  head: 'a HEAD file can turn its folder into a git repository whose config runs code',
};

/** Folders whose files run code by themselves, and why. */
const AUTORUN_DIRS: Record<string, string> = {
  '.husky': 'Husky runs these files as git hooks',
  '.vscode': 'VS Code can run its tasks and change its settings when the folder opens',
  '.devcontainer': 'it sets up the container your editor starts',
};

/**
 * A file name as a case-insensitive, normalizing file system may see it. Upper then
 * lower case, so that "ı" folds to "i" (as NTFS compares) and "K" (Kelvin) to "k" (as APFS does).
 */
export function foldName(name: string): string {
  return name
    .normalize('NFC')
    .replace(IGNORABLE, '')
    .replace(/:.*$/s, '')
    .replace(/[. ]+$/, '')
    .toUpperCase()
    .toLowerCase();
}

/** ".git" as git itself guards it: folded, and the NTFS short name "git~1". */
function isDotGit(folded: string): boolean {
  return folded === '.git' || /^git~\d+$/.test(folded);
}

export class PathPolicy {
  readonly root: string;
  private readonly dataDir?: string;
  private readonly windows: boolean;
  private ready?: Promise<{ realRoot: string; realDataDir?: string; dataDirInfo?: BigIntStats }>;

  constructor(options: PathPolicyOptions) {
    this.root = resolve(options.root);
    this.dataDir = options.dataDir === undefined ? undefined : resolve(options.dataDir);
    this.windows = (options.platform ?? process.platform) === 'win32';
  }

  /**
   * Checks a path from the model for an access. Throws a ToolError when it is refused;
   * otherwise says where it really goes and what to ask the user first.
   */
  async check(input: string, access: PathAccess): Promise<CheckedPath> {
    const { realRoot } = await this.prepare();
    const shown = sanitize(input, { multiline: false }).text;
    if (input.trim() === '') throw new ToolError('The path is empty.');
    if (input.includes('\0')) throw new ToolError(`${shown}: a path cannot contain NUL.`);
    if (access !== 'read' && access !== 'list' && sanitize(input, { multiline: false }).hidden > 0) {
      throw new ToolError(`${shown}: the path contains control or invisible characters. Use a plain file name.`);
    }

    const target = resolve(this.root, input);
    const lexical = within(this.root, target) ?? within(realRoot, target);
    const real = await this.realOf(target, shown);
    const inside = within(realRoot, real);
    if (lexical === undefined || inside === undefined) {
      throw new ToolError(`${shown} is outside the workspace (${this.root}). Use paths inside it.`);
    }
    this.refuseNames(lexical, shown);
    this.refuseNames(inside, shown);
    if (await this.inDataDir(real)) throw new ToolError(dataDirRefusal(shown));

    const info = await lstat(real, { bigint: true }).catch(() => undefined);
    const display = lexical.split(/[\\/]+/).filter(Boolean).join('/') || '.';
    const reasons: string[] = [];
    if (access === 'read' || access === 'edit') {
      const secret = [lexical, inside].map(lastName).find((name) => SECRET_NAMES.some((test) => test(foldName(name))));
      if (secret !== undefined) {
        reasons.push(`${secret} may hold secrets: ${access === 'edit' ? 'editing reads it, and ' : ''}what the agent reads is sent to the chat provider.`);
      }
    }
    if (access === 'write' || access === 'edit') {
      for (const why of new Set([...autorun(lexical), ...autorun(inside)])) reasons.push(`${display}: ${why}.`);
      if (info?.isFile() && info.nlink > 1n) reasons.push(hardLinkReason(display, info.nlink));
    }
    const checked: CheckedPath = { real, display, reasons };
    if (info !== undefined) checked.info = info;
    return checked;
  }

  /** Whether a folder found while listing is one the tools must not open (.git, the data dir). */
  async offLimits(path: string): Promise<boolean> {
    const { realRoot } = await this.prepare();
    const rel = within(realRoot, path);
    if (rel === undefined) return true;
    if (segments(rel).some((segment) => isDotGit(foldName(segment)))) return true;
    return this.inDataDir(path);
  }

  /** Creates the missing folders of a path that passed check(). */
  async makeParents(checked: CheckedPath): Promise<void> {
    await mkdir(dirname(checked.real), { recursive: true });
  }

  /**
   * Opens a checked path without following a symbolic link at its end, then makes
   * sure the open file is the one that was checked: a process left running by a
   * command (in the sandbox too) may have swapped a folder for a link in between.
   */
  async open(checked: CheckedPath, mode: 'read' | 'write' | 'edit'): Promise<FileHandle> {
    const access = mode === 'read' ? constants.O_RDONLY : mode === 'edit' ? constants.O_RDWR : constants.O_WRONLY | constants.O_CREAT;
    let handle: FileHandle;
    try {
      handle = await open(checked.real, access | NOFOLLOW | NONBLOCK, 0o666);
    } catch (error) {
      const code = errno(error);
      if (code === 'ELOOP') throw new ToolError(`${checked.display} is a symbolic link: it is not followed.`);
      if (code === 'ENXIO') throw new ToolError(`${checked.display} is not a regular file.`);
      throw error;
    }
    try {
      const info = await handle.stat({ bigint: true });
      if (info.isDirectory()) throw new ToolError(`${checked.display} is a folder: use list_dir.`);
      if (!info.isFile()) throw new ToolError(`${checked.display} is not a regular file.`);
      if (!(await this.stillTheSame(handle, checked, info))) {
        throw new ToolError(`${checked.display} changed while it was being opened. Nothing was done; try again.`);
      }
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private prepare(): Promise<{ realRoot: string; realDataDir?: string; dataDirInfo?: BigIntStats }> {
    this.ready ??= (async () => {
      const realRoot = await realpath(this.root);
      if (this.dataDir === undefined) return { realRoot };
      const realDataDir = await realpath(this.dataDir).catch(() => this.dataDir);
      const dataDirInfo = await stat(this.dataDir, { bigint: true }).catch(() => undefined);
      return dataDirInfo === undefined ? { realRoot, realDataDir } : { realRoot, realDataDir, dataDirInfo };
    })();
    return this.ready;
  }

  /**
   * Where a path really points: the deepest part that exists, links resolved, plus
   * the rest. A link whose target is missing is refused, or writing it would create
   * the target wherever it points.
   */
  private async realOf(target: string, shown: string): Promise<string> {
    const rest: string[] = [];
    let existing = target;
    for (;;) {
      try {
        const real = await realpath(existing);
        return rest.length === 0 ? real : join(real, ...rest.reverse());
      } catch (error) {
        const code = errno(error);
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          throw new ToolError(`${shown} cannot be checked (${code ?? 'unknown error'}), so it is refused.`);
        }
        if (await lstat(existing).then(() => true, () => false)) {
          throw new ToolError(`${shown} goes through a symbolic link whose target is missing: it is refused.`);
        }
        const parent = dirname(existing);
        if (parent === existing) return target;
        rest.push(basename(existing));
        existing = parent;
      }
    }
  }

  private refuseNames(rel: string, shown: string): void {
    for (const segment of segments(rel)) {
      const folded = foldName(segment);
      if (isDotGit(folded)) {
        throw new ToolError(
          `${shown} is inside .git, which is off limits: its hooks and config (core.fsmonitor) run code at the next git command.`,
        );
      }
      if (this.windows && segment.includes(':')) throw new ToolError(`${shown}: ":" is not allowed in a file name.`);
      if (this.windows && WINDOWS_DEVICE.test(folded)) throw new ToolError(`${shown}: ${segment} is a Windows device name.`);
    }
  }

  /** By identity (device and inode of every folder on the way) and by folded name. */
  private async inDataDir(real: string): Promise<boolean> {
    const { realRoot, realDataDir, dataDirInfo } = await this.prepare();
    if (realDataDir === undefined) return false;
    if (foldedWithin(realDataDir, real)) return true;
    if (dataDirInfo === undefined) return false;
    for (let dir = real; ; dir = dirname(dir)) {
      const info = await stat(dir, { bigint: true }).catch(() => undefined);
      if (info && info.dev === dataDirInfo.dev && info.ino === dataDirInfo.ino) return true;
      if (dir === realRoot || dirname(dir) === dir || within(realRoot, dir) === undefined) return false;
    }
  }

  private async stillTheSame(handle: FileHandle, checked: CheckedPath, info: BigIntStats): Promise<boolean> {
    if (process.platform === 'linux') {
      // The kernel's own answer to "which file is this?".
      const opened = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => undefined);
      if (opened !== undefined) return opened === checked.real;
    }
    // Elsewhere: the checked path must still lead to the open file.
    const again = await realpath(checked.real).catch(() => undefined);
    const now = again === undefined ? undefined : await stat(again, { bigint: true }).catch(() => undefined);
    return again === checked.real && now !== undefined && now.dev === info.dev && now.ino === info.ino;
  }
}

export function hardLinkReason(display: string, links: bigint | number): string {
  return `${display} has ${links} hard links: writing it changes the same file under its other names, which may be outside the workspace.`;
}

function dataDirRefusal(shown: string): string {
  return `${shown} is inside the agent's data folder (browser profile, session logs, MCP tokens), which is off limits.`;
}

function autorun(rel: string): string[] {
  const parts = segments(rel).map(foldName);
  const reasons: string[] = [];
  const name = parts.at(-1);
  if (name !== undefined && AUTORUN_NAMES[name] !== undefined) reasons.push(AUTORUN_NAMES[name]);
  for (const [i, part] of parts.entries()) {
    const dir = AUTORUN_DIRS[part];
    if (dir !== undefined && i < parts.length - 1) reasons.push(dir);
    if (part === '.github' && parts[i + 1] === 'workflows' && i + 1 < parts.length - 1) {
      reasons.push('GitHub runs these workflows with the repository secrets');
    }
  }
  return reasons;
}

/** The relative path of target under base, '' for base itself; undefined when it is outside. */
function within(base: string, target: string): string | undefined {
  const rel = relative(base, target);
  if (rel === '') return '';
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return undefined;
  return rel;
}

function foldedWithin(base: string, target: string): boolean {
  const a = segments(resolve(base)).map(foldName);
  const b = segments(resolve(target)).map(foldName);
  return a.length <= b.length && a.every((part, i) => part === b[i]);
}

/** Both separators everywhere: "a\\.git\\hooks" is refused on Linux too. */
function segments(path: string): string[] {
  return path.split(/[\\/]+/).filter((segment) => segment !== '');
}

function lastName(rel: string): string {
  return segments(rel).at(-1) ?? '';
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}
