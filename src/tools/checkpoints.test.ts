import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Checkpoints } from './checkpoints.js';
import { nativeTools } from './native.js';
import { Toolbox } from './toolbox.js';

const posix = process.platform !== 'win32';
const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

interface Setup {
  base: string;
  workspace: string;
  dataDir: string;
  /** git for the test's own repository: an isolated global config, no system config, a fixed author. */
  userGit: (...args: string[]) => string;
  cleanup: () => Promise<void>;
}

async function setup(): Promise<Setup> {
  const base = await mkdtemp(join(tmpdir(), 'agent-checkpoints-'));
  const workspace = join(base, 'workspace');
  const dataDir = join(base, 'data');
  await mkdir(workspace);
  await writeFile(join(base, 'user.gitconfig'), '');
  const env = {
    PATH: process.env.PATH ?? '',
    GIT_CONFIG_GLOBAL: join(base, 'user.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  const userGit = (...args: string[]): string => execFileSync('git', args, { cwd: workspace, env, stdio: 'pipe' }).toString();
  return { base, workspace, dataDir, userGit, cleanup: () => rm(base, { recursive: true, force: true }) };
}

async function open(s: Setup, options: { maxFiles?: number } = {}): Promise<Checkpoints> {
  const opened = await Checkpoints.open({ workspace: s.workspace, dataDir: s.dataDir, ...options });
  assert.ok(opened instanceof Checkpoints, 'unavailable' in opened ? opened.unavailable : '');
  return opened;
}

test('/undo restores changed and deleted files, removes created ones, leaves ignored ones', { skip: !hasGit }, async () => {
  const s = await setup();
  try {
    const w = (path: string) => join(s.workspace, path);
    await writeFile(w('.gitignore'), 'build/\n*.log\n');
    await writeFile(w('app.py'), 'print("v1")\n');
    await writeFile(w('crlf.txt'), 'a\r\nb\r\n');
    await writeFile(w('gone.txt'), 'keep me\n');
    await writeFile(w('run.sh'), '#!/bin/sh\necho hi\n');
    if (posix) await chmod(w('run.sh'), 0o755);
    const checkpoints = await open(s);
    assert.ok((await checkpoints.snapshot('before write_file app.py')).commit);

    await writeFile(w('app.py'), 'print("v2")\n');
    await writeFile(w('crlf.txt'), 'changed\n');
    await rm(w('gone.txt'));
    await mkdir(w('new/deep'), { recursive: true });
    await writeFile(w('new/deep/file.txt'), 'new\n');
    await writeFile(w('debug.log'), 'ignored\n');
    await mkdir(w('build'));
    await writeFile(w('build/out.js'), 'ignored\n');
    if (posix) await chmod(w('run.sh'), 0o644);

    const plan = await checkpoints.planUndo();
    assert.ok(plan);
    assert.equal(plan.checkpoint.label, 'before write_file app.py');
    assert.deepEqual(plan.remove, ['new/deep/file.txt']);
    assert.deepEqual(plan.restore.sort(), (posix ? ['app.py', 'crlf.txt', 'gone.txt', 'run.sh'] : ['app.py', 'crlf.txt', 'gone.txt']).sort());
    const result = await checkpoints.undo(plan);
    assert.equal(result.removed, 1);
    assert.deepEqual(result.skipped, []);

    assert.equal(await readFile(w('app.py'), 'utf8'), 'print("v1")\n');
    assert.deepEqual(await readFile(w('crlf.txt')), Buffer.from('a\r\nb\r\n'), 'byte for byte, CRLF kept');
    assert.equal(await readFile(w('gone.txt'), 'utf8'), 'keep me\n');
    assert.ok(!existsSync(w('new')), 'the folders created since are gone too');
    assert.equal(await readFile(w('debug.log'), 'utf8'), 'ignored\n');
    assert.equal(await readFile(w('build/out.js'), 'utf8'), 'ignored\n');
    if (posix) assert.equal((await stat(w('run.sh'))).mode & 0o777, 0o755);
    assert.deepEqual(await checkpoints.list(), [], 'the checkpoint is used up');
    assert.equal(await checkpoints.planUndo(), undefined);
  } finally {
    await s.cleanup();
  }
});

test('repeated /undo walks back one change at a time; unchanged checkpoints are skipped', { skip: !hasGit }, async () => {
  const s = await setup();
  try {
    const file = join(s.workspace, 'notes.txt');
    const checkpoints = await open(s);
    await writeFile(file, 'one\n');
    await checkpoints.snapshot('first');
    await writeFile(file, 'two\n');
    await checkpoints.snapshot('second');
    await checkpoints.snapshot('third, nothing changed');
    assert.deepEqual((await checkpoints.list()).map((c) => c.label), ['second', 'first']);
    await writeFile(file, 'three\n');
    await checkpoints.undo((await checkpoints.planUndo())!);
    assert.equal(await readFile(file, 'utf8'), 'two\n');
    await checkpoints.undo((await checkpoints.planUndo())!);
    assert.equal(await readFile(file, 'utf8'), 'one\n');
  } finally {
    await s.cleanup();
  }
});

test("the user's repository is never touched: .git, index, stash, branches, config", { skip: !hasGit }, async () => {
  const s = await setup();
  try {
    s.userGit('init', '--quiet', '-b', 'main');
    await writeFile(join(s.workspace, 'a.txt'), 'committed\n');
    s.userGit('add', 'a.txt');
    s.userGit('commit', '--quiet', '-m', 'first');
    s.userGit('branch', 'feature');
    await writeFile(join(s.workspace, 'a.txt'), 'stashed\n');
    s.userGit('stash', '--quiet');
    await writeFile(join(s.workspace, 'a.txt'), 'staged\n');
    s.userGit('add', 'a.txt');
    const before = {
      index: await readFile(join(s.workspace, '.git', 'index')),
      config: await readFile(join(s.workspace, '.git', 'config'), 'utf8'),
      status: s.userGit('status', '--porcelain'),
      stash: s.userGit('stash', 'list'),
      branches: s.userGit('branch', '--list'),
      head: s.userGit('rev-parse', 'HEAD'),
    };
    const checkpoints = await open(s);
    await checkpoints.snapshot('before');
    await writeFile(join(s.workspace, 'b.txt'), 'new\n');
    await checkpoints.undo((await checkpoints.planUndo())!);
    assert.deepEqual(await readFile(join(s.workspace, '.git', 'index')), before.index);
    assert.equal(await readFile(join(s.workspace, '.git', 'config'), 'utf8'), before.config);
    assert.equal(s.userGit('status', '--porcelain'), before.status);
    assert.equal(s.userGit('stash', 'list'), before.stash);
    assert.equal(s.userGit('branch', '--list'), before.branches);
    assert.equal(s.userGit('rev-parse', 'HEAD'), before.head);
    assert.ok(!checkpoints.gitDir.startsWith(s.workspace));
  } finally {
    await s.cleanup();
  }
});

test('hostile git settings around the agent never run: env, global config, hooks, fsmonitor, filters', { skip: !hasGit || !posix }, async () => {
  const s = await setup();
  const saved = { ...process.env };
  try {
    s.userGit('init', '--quiet');
    const marker = join(s.base, 'marker');
    const script = join(s.base, 'evil.sh');
    await writeFile(script, `#!/bin/sh\necho "$0 $*" >> "${marker}"\ncat\n`);
    await chmod(script, 0o755);
    const hooks = join(s.base, 'hooks');
    await mkdir(hooks);
    for (const hook of ['pre-commit', 'post-checkout', 'post-index-change', 'reference-transaction']) {
      await writeFile(join(hooks, hook), `#!/bin/sh\necho ${hook} >> "${marker}"\n`);
      await chmod(join(hooks, hook), 0o755);
    }
    const evilConfig = join(s.base, 'evil.gitconfig');
    await writeFile(evilConfig, `[core]\n\tfsmonitor = ${script}\n\thooksPath = ${hooks}\n[filter "evil"]\n\tclean = ${script}\n\tsmudge = ${script}\n\trequired = true\n`);
    await writeFile(join(s.workspace, '.gitattributes'), '* filter=evil\n');
    await writeFile(join(s.workspace, 'x.txt'), 'x\n');
    const userIndex = join(s.workspace, '.git', 'index');
    // What a hook environment or a hostile shell could have set.
    Object.assign(process.env, {
      GIT_CONFIG_GLOBAL: evilConfig,
      GIT_DIR: join(s.workspace, '.git'),
      GIT_INDEX_FILE: userIndex,
      GIT_WORK_TREE: s.base,
      GIT_CONFIG_PARAMETERS: `'core.fsmonitor'='${script}'`,
    });
    const checkpoints = await open(s);
    await checkpoints.snapshot('before');
    await writeFile(join(s.workspace, 'x.txt'), 'changed\n');
    await checkpoints.undo((await checkpoints.planUndo())!);
    assert.equal(await readFile(join(s.workspace, 'x.txt'), 'utf8'), 'x\n');
    assert.ok(!existsSync(marker), existsSync(marker) ? await readFile(marker, 'utf8') : '');
    assert.ok(!existsSync(userIndex), "the user's index was not created");
  } finally {
    process.env = saved;
    await s.cleanup();
  }
});

test('the data dir is never saved, even inside the workspace', { skip: !hasGit }, async () => {
  const s = await setup();
  try {
    const dataDir = join(s.workspace, '.agent');
    await mkdir(join(dataDir, 'sessions'), { recursive: true });
    const opened = await Checkpoints.open({ workspace: s.workspace, dataDir });
    assert.ok(opened instanceof Checkpoints);
    await opened.snapshot('before');
    await writeFile(join(dataDir, 'sessions', 'log.jsonl'), 'secret conversation\n');
    await writeFile(join(s.workspace, 'new.txt'), 'x');
    const plan = await opened.planUndo();
    assert.deepEqual(plan?.remove, ['new.txt']);
    await opened.undo(plan!);
    assert.equal(await readFile(join(dataDir, 'sessions', 'log.jsonl'), 'utf8'), 'secret conversation\n');
  } finally {
    await s.cleanup();
  }
});

test('/undo removes a link created since, never what it points to', { skip: !hasGit || !posix }, async () => {
  const s = await setup();
  try {
    const outside = join(s.base, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'precious.txt'), 'precious\n');
    const checkpoints = await open(s);
    await checkpoints.snapshot('before');
    await symlink(outside, join(s.workspace, 'link'), 'dir');
    const plan = await checkpoints.planUndo();
    assert.deepEqual(plan?.remove, ['link']);
    await checkpoints.undo(plan!);
    assert.ok(!existsSync(join(s.workspace, 'link')));
    assert.equal(await readFile(join(outside, 'precious.txt'), 'utf8'), 'precious\n');
  } finally {
    await s.cleanup();
  }
});

test('too large a change is skipped with a reason; no git means no checkpoints', { skip: !hasGit }, async () => {
  const s = await setup();
  try {
    for (const name of ['a', 'b', 'c']) await writeFile(join(s.workspace, name), name);
    const checkpoints = await open(s, { maxFiles: 2 });
    assert.match((await checkpoints.snapshot('big')).skipped ?? '', /checkpoint skipped: more than 2 files/);
    assert.deepEqual(await checkpoints.list(), []);
    const missing = await Checkpoints.open({ workspace: s.workspace, dataDir: s.dataDir, git: join(s.base, 'no-such-git') });
    assert.ok('unavailable' in missing && /git was not found/.test(missing.unavailable));
  } finally {
    await s.cleanup();
  }
});

test('the shadow repository is private: folders 0700, files 0600', { skip: !hasGit || !posix }, async () => {
  const s = await setup();
  try {
    await writeFile(join(s.workspace, 'a.txt'), 'a');
    const checkpoints = await open(s);
    await checkpoints.snapshot('before');
    assert.equal((await stat(checkpoints.gitDir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(checkpoints.gitDir, 'objects'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(checkpoints.gitDir, 'config'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(checkpoints.gitDir, 'index'))).mode & 0o077, 0);
  } finally {
    await s.cleanup();
  }
});

test('the toolbox checkpoints before writes and approved commands, not before reads or refused calls', { skip: !hasGit }, async () => {
  const s = await setup();
  try {
    const labels: string[] = [];
    let allow = true;
    const box = new Toolbox(nativeTools({ root: s.workspace }), {
      approve: async () => ({ approved: allow }),
      checkpoint: async (label) => {
        labels.push(label);
      },
    });
    await writeFile(join(s.workspace, 'a.txt'), 'a\n');
    await box.call({ index: 1, tool: 'read_file', args: { path: 'a.txt' } });
    await box.call({ index: 2, tool: 'write_file', args: { path: 'b.txt' }, body: 'b\n' });
    await box.call({ index: 3, tool: 'edit_file', args: { path: 'a.txt' }, body: '<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE' });
    await box.call({ index: 4, tool: 'run_command', args: { command: '\necho one\necho two' } });
    allow = false;
    await box.call({ index: 5, tool: 'run_command', args: { command: 'echo refused' } });
    assert.deepEqual(labels, ['write_file b.txt', 'edit_file a.txt', 'run_command echo one']);
  } finally {
    await s.cleanup();
  }
});
