import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Checkpoints: before every call that may change the workspace, a snapshot goes into
 * a shadow git repository in the data dir (git --git-dir=<data-dir>/checkpoints/<id>
 * --work-tree=<workspace>), and /undo puts the last one back.
 *
 * The user's own repository is never touched: no .git, index, stash, branch or config
 * of theirs is read or written. The shadow git runs with a clean environment (no
 * inherited GIT_* variables), no system or global config, no hooks and no fsmonitor,
 * so nothing the user (or the model) configured elsewhere runs. Its info/attributes
 * turns off every conversion, so files come back byte for byte, and .gitignore is
 * respected: ignored files are neither saved nor removed.
 */

export interface CheckpointOptions {
  workspace: string;
  dataDir: string;
  /** A snapshot that would add more is skipped with a warning. */
  maxFiles?: number;
  maxBytes?: number;
  /** The git program. */
  git?: string;
}

export interface Checkpoint {
  commit: string;
  at: Date;
  label: string;
}

export interface UndoPlan {
  checkpoint: Checkpoint;
  /** Changed or deleted since: they get their old content back. */
  restore: string[];
  /** Created since: they are removed. */
  remove: string[];
}

const REF = 'refs/agent/checkpoints';
/** The state just before the last /undo, for recovery by hand. */
const BEFORE_UNDO = 'refs/agent/before-undo';
const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
const GITLINK = '160000';
const IDENTITY = { name: 'agent-transformer', email: 'checkpoints@agent-transformer.invalid' };

/** No conversions of any kind, whatever the workspace's .gitattributes says (info/attributes wins). */
const ATTRIBUTES = '* -text !eol -filter -ident !working-tree-encoding -diff -merge -export-subst\n';

export class Checkpoints {
  readonly gitDir: string;
  private readonly workspace: string;
  private readonly git: string;
  private readonly env: Record<string, string>;
  private readonly config: string[];
  private readonly maxFiles: number;
  private readonly maxBytes: number;

  private constructor(options: Required<Omit<CheckpointOptions, 'dataDir'>>, gitDir: string, emptyConfig: string, hooks: string) {
    this.workspace = options.workspace;
    this.git = options.git;
    this.gitDir = gitDir;
    this.maxFiles = options.maxFiles;
    this.maxBytes = options.maxBytes;
    this.env = {
      PATH: process.env.PATH ?? '',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: emptyConfig,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: IDENTITY.name,
      GIT_AUTHOR_EMAIL: IDENTITY.email,
      GIT_COMMITTER_NAME: IDENTITY.name,
      GIT_COMMITTER_EMAIL: IDENTITY.email,
      LC_ALL: 'C',
    };
    for (const name of ['SYSTEMROOT', 'TEMP', 'TMP']) {
      const value = process.env[name];
      if (value !== undefined) this.env[name] = value;
    }
    this.config = [
      `core.hooksPath=${hooks}`,
      // Nor the user's global ignore and attributes files.
      `core.excludesFile=${emptyConfig}`,
      `core.attributesFile=${emptyConfig}`,
      'core.fsmonitor=false',
      'core.untrackedCache=false',
      'core.autocrlf=false',
      'core.safecrlf=false',
      'core.protectHFS=true',
      'core.protectNTFS=true',
      'core.quotePath=false',
      'core.longpaths=true',
      'gc.auto=0',
      'maintenance.auto=false',
      'commit.gpgSign=false',
      // Command-line config is protected: it may vouch for the shadow repository, the workspace's config is never read.
      'safe.directory=*',
    ].flatMap((setting) => ['-c', setting]);
  }

  /** Opens (or creates) the shadow repository of a workspace; undefined with the reason when git is missing. */
  static async open(options: CheckpointOptions): Promise<Checkpoints | { unavailable: string }> {
    const git = options.git ?? 'git';
    const version = await run(git, ['--version'], { env: { PATH: process.env.PATH ?? '' } });
    if (version.code !== 0) return { unavailable: `git was not found (${version.stderr.trim() || 'no output'})` };
    const workspace = await realpath(options.workspace);
    const id = createHash('sha256').update(workspace).digest('hex').slice(0, 16);
    const home = join(options.dataDir, 'checkpoints');
    const gitDir = join(home, id);
    const empty = join(home, 'empty');
    await mkdir(empty, { recursive: true, mode: 0o700 });
    const emptyConfig = join(home, 'empty.gitconfig');
    await writeFile(emptyConfig, '', { mode: 0o600 });
    const checkpoints = new Checkpoints(
      { workspace, git, maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES, maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES },
      gitDir,
      emptyConfig,
      empty,
    );
    await checkpoints.init(options.dataDir, empty);
    return checkpoints;
  }

  /** Saves the workspace as it is now. Returns why it was skipped, if it was. */
  async snapshot(label: string): Promise<{ commit?: string; skipped?: string }> {
    const tree = await this.stage(true);
    if ('skipped' in tree) return tree;
    const latest = await this.latest();
    if (latest !== undefined && (await this.treeOf(latest.commit)) === tree.tree) return { commit: latest.commit };
    const args = ['commit-tree', tree.tree, '-m', label.slice(0, 200) || 'checkpoint'];
    if (latest !== undefined) args.push('-p', latest.commit);
    const commit = (await this.gitOk(args)).trim();
    await this.gitOk(['update-ref', REF, commit, ...(latest === undefined ? [] : [latest.commit])]);
    return { commit };
  }

  /** Newest first. */
  async list(limit = 20): Promise<Checkpoint[]> {
    if ((await this.latest()) === undefined) return [];
    const out = await this.gitOk(['log', `-n${limit}`, '--format=%H%x1f%ct%x1f%s', REF]);
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [commit = '', time = '0', label = ''] = line.split('\x1f');
        return { commit, at: new Date(Number(time) * 1000), label };
      });
  }

  /**
   * What /undo would do: the newest checkpoint that differs from the workspace now
   * (newer ones equal to it are skipped), and the files it would restore and remove.
   */
  async planUndo(): Promise<UndoPlan | undefined> {
    const now = await this.stage(false);
    if ('skipped' in now) throw new Error(now.skipped);
    for (const checkpoint of await this.list(1_000)) {
      const changes = await this.changes(await this.treeOf(checkpoint.commit), now.tree);
      if (changes.restore.length + changes.remove.length > 0) return { checkpoint, ...changes };
    }
    return undefined;
  }

  /** Puts a planned checkpoint back and drops it (and the newer ones) from the list. */
  async undo(plan: UndoPlan): Promise<{ restored: number; removed: number; skipped: string[] }> {
    const now = await this.stage(false);
    if ('skipped' in now) throw new Error(now.skipped);
    const target = await this.treeOf(plan.checkpoint.commit);
    // Planned on a workspace that has changed since: plan again rather than guess.
    const changes = await this.changes(target, now.tree);
    if (changes.remove.join('\0') !== plan.remove.join('\0') || changes.restore.join('\0') !== plan.restore.join('\0')) {
      throw new Error('The workspace changed after /undo was planned. Nothing was done: run /undo again.');
    }
    const kept = (await this.gitOk(['commit-tree', now.tree, '-p', plan.checkpoint.commit, '-m', 'before /undo'])).trim();
    await this.gitOk(['update-ref', BEFORE_UNDO, kept]);

    const skipped: string[] = [];
    let removed = 0;
    for (const path of changes.remove) {
      if (await this.removeFile(path)) removed += 1;
      else skipped.push(path);
    }
    // Before the restore: a file of the checkpoint may come back where a folder was created since.
    await this.removeEmptyFolders(changes.remove, target);
    await this.gitOk(['read-tree', target]);
    if (changes.restore.length > 0) {
      await this.gitOk(['checkout-index', '--force', '-z', '--stdin'], `${changes.restore.join('\0')}\0`);
    }
    const parent = (await this.git_(['rev-parse', '--verify', '--quiet', `${plan.checkpoint.commit}^`])).stdout.trim();
    if (parent === '') await this.gitOk(['update-ref', '-d', REF]);
    else await this.gitOk(['update-ref', REF, parent]);
    return { restored: changes.restore.length, removed, skipped };
  }

  private async init(dataDir: string, template: string): Promise<void> {
    if ((await this.git_(['rev-parse', '--git-dir'])).code !== 0) {
      await mkdir(this.gitDir, { recursive: true, mode: 0o700 });
      await this.gitOk(['init', '--quiet', `--template=${template}`, '--shared=0600']);
    }
    await mkdir(join(this.gitDir, 'info'), { recursive: true, mode: 0o700 });
    await writeFile(join(this.gitDir, 'info', 'attributes'), ATTRIBUTES, { mode: 0o600 });
    // The data dir is never saved, even when it lies inside the workspace.
    const rel = relative(this.workspace, await realpath(dataDir).catch(() => resolve(dataDir)));
    const inside = rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
    const exclude = inside ? `/${rel.split(sep).join('/')}/\n` : '';
    await writeFile(join(this.gitDir, 'info', 'exclude'), exclude, { mode: 0o600 });
    await writeFile(join(this.gitDir, 'description'), `Checkpoints of ${this.workspace}\n`, { mode: 0o600 });
  }

  /** Puts the workspace in the shadow index and returns its tree, or why it was too big. */
  private async stage(capped: boolean): Promise<{ tree: string } | { skipped: string }> {
    if (capped) {
      const listed = await this.gitOk(['ls-files', '-z', '--others', '--modified', '--exclude-standard']);
      let files = 0;
      let bytes = 0;
      for (const path of listed.split('\0')) {
        if (path === '') continue;
        files += 1;
        bytes += await lstat(join(this.workspace, path)).then(
          (info) => (info.isFile() ? info.size : 0),
          () => 0,
        );
        if (files > this.maxFiles || bytes > this.maxBytes) {
          return {
            skipped:
              `checkpoint skipped: more than ${this.maxFiles} files or ${Math.round(this.maxBytes / 1024 / 1024)} MB changed ` +
              '(add large folders to .gitignore)',
          };
        }
      }
    }
    // --ignore-errors: an unreadable file is left out, not a reason to lose the whole snapshot.
    const added = await this.git_(['add', '--all', '--ignore-errors', '--', '.']);
    if (added.code !== 0 && !/error: unable to index|warning:/i.test(added.stderr)) {
      throw new Error(`git add failed: ${added.stderr.trim()}`);
    }
    return { tree: (await this.gitOk(['write-tree'])).trim() };
  }

  private async latest(): Promise<Checkpoint | undefined> {
    const commit = (await this.git_(['rev-parse', '--verify', '--quiet', REF])).stdout.trim();
    return commit === '' ? undefined : { commit, at: new Date(), label: '' };
  }

  private async treeOf(commit: string): Promise<string> {
    return (await this.gitOk(['rev-parse', `${commit}^{tree}`])).trim();
  }

  /** From the "now" tree back to the "then" tree: what to restore and what to remove. Submodules are left alone. */
  private async changes(then: string, now: string): Promise<{ restore: string[]; remove: string[] }> {
    const raw = await this.gitOk(['diff-tree', '-r', '--no-renames', '-z', then, now]);
    const restore: string[] = [];
    const remove: string[] = [];
    const fields = raw.split('\0');
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const [oldMode = '', newMode = '', , , status = ''] = (fields[i] ?? '').replace(/^:/, '').split(' ');
      const path = fields[i + 1] ?? '';
      if (path === '' || oldMode === GITLINK || newMode === GITLINK) continue;
      if (status === 'A') remove.push(path);
      else restore.push(path);
    }
    return { restore, remove };
  }

  /** Removes a file created since the checkpoint, unless its folder is not where it should be (a link swapped in). */
  private async removeFile(path: string): Promise<boolean> {
    const target = join(this.workspace, path);
    const rel = relative(this.workspace, target);
    if (rel === '' || isAbsolute(rel) || rel.startsWith(`..${sep}`)) return false;
    const folder = await realpath(dirname(target)).catch(() => undefined);
    if (folder !== dirname(target)) return false;
    try {
      const info = await lstat(target);
      if (info.isDirectory()) return false;
      await unlink(target);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
  }

  /** Folders that held only files created since, and are not in the checkpoint. */
  private async removeEmptyFolders(removed: string[], target: string): Promise<void> {
    const listed = await this.gitOk(['ls-tree', '-r', '-d', '-z', '--name-only', target]);
    const keep = new Set(listed.split('\0').filter(Boolean));
    const folders = new Set<string>();
    for (const path of removed) {
      for (let dir = dirname(path); dir !== '.' && dir !== '' && !keep.has(dir.split(sep).join('/')); dir = dirname(dir)) folders.add(dir);
    }
    for (const dir of [...folders].sort((a, b) => b.length - a.length)) {
      const full = join(this.workspace, dir);
      if ((await readdir(full).catch(() => ['?'])).length === 0) await rmdir(full).catch(() => undefined);
    }
  }

  private git_(args: string[], input?: string): Promise<RunResult> {
    const options: RunOptions = { env: this.env, cwd: this.workspace };
    if (input !== undefined) options.input = input;
    return run(this.git, ['--git-dir', this.gitDir, '--work-tree', this.workspace, ...this.config, ...args], options);
  }

  private async gitOk(args: string[], input?: string): Promise<string> {
    const result = await this.git_(args, input);
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
    return result.stdout;
  }
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  env: Record<string, string>;
  cwd?: string;
  input?: string;
}

function run(file: string, args: string[], options: RunOptions): Promise<RunResult> {
  return new Promise((done) => {
    const child = execFile(
      file,
      args,
      { env: options.env, cwd: options.cwd, maxBuffer: 256 * 1024 * 1024, windowsHide: true, timeout: 300_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
        done({ code, stdout: String(stdout), stderr: String(stderr) || (error && code === null ? error.message : '') });
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}
