import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { after, before, test } from 'node:test';
import { checkWorkspace } from './workspace.js';

let base = '';
let home = '';
let project = '';

before(async () => {
  // Its real path: the temp folder can be reached through a link (/var -> /private/var on macOS) or by
  // its 8.3 short name (C:\Users\RUNNER~1 on the Windows runner). checkWorkspace compares real paths,
  // and a folder that does not exist yet, like the data dir below, only gets resolve(), not realpath().
  base = await realpath(await mkdtemp(join(tmpdir(), 'agent-workspace-')));
  home = join(base, 'home');
  project = join(home, 'code', 'project');
  await mkdir(project, { recursive: true });
});

after(async () => {
  await rm(base, { recursive: true, force: true });
});

const check = (workspace: string, dataDir = join(home, '.local', 'share', 'agent-transformer')) =>
  checkWorkspace(workspace, { home, dataDir });

test('a project folder is fine', async () => {
  assert.deepEqual(await check(project), []);
});

test('the filesystem root, the home folder and its ancestors are refused', async () => {
  await assert.rejects(check(parse(base).root), /root of the file system/);
  await assert.rejects(check(home), /is your home folder/);
  await assert.rejects(check(base), /contains your home folder/);
  await assert.rejects(check(join(project, '..', '..')), /is your home folder/);
});

test('a link to the home folder is refused too', async () => {
  // A junction on Windows, where a symbolic link needs a privilege; a plain symbolic link elsewhere.
  await symlink(home, join(base, 'home-link'), 'junction');
  await assert.rejects(check(join(base, 'home-link')), /is your home folder/);
});

test('case variants count on Windows and macOS', async () => {
  const dataDir = join(base, 'data');
  const shouted = home.toUpperCase();
  await assert.rejects(checkWorkspace(home, { home: shouted, dataDir, platform: 'darwin' }), /is your home folder/);
  await assert.rejects(checkWorkspace(base, { home: shouted, dataDir, platform: 'win32' }), /contains your home folder/);
});

test('Linux compares exactly: there, the upper-case path is another folder', async (t) => {
  const shouted = home.toUpperCase();
  // Only true on a case-sensitive file system with POSIX paths. Where the upper-case path exists, it is
  // this same folder (Windows, macOS by default), and Node's path module ignores case on Windows.
  if (process.platform === 'win32' || existsSync(shouted)) {
    t.skip('needs a case-sensitive file system: here the upper-case path is the home folder itself');
    return;
  }
  assert.deepEqual(await checkWorkspace(home, { home: shouted, dataDir: join(base, 'data'), platform: 'linux' }), []);
});

test('the data dir: a workspace inside it is refused, a data dir inside the workspace warns', async () => {
  const dataDir = join(home, 'data');
  await mkdir(join(dataDir, 'sessions'), { recursive: true });
  await assert.rejects(check(join(dataDir, 'sessions'), dataDir), /inside the agent's data folder/);
  await assert.rejects(check(dataDir, dataDir), /inside the agent's data folder/);
  const warnings = await check(project, join(project, '.agent-data'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /data folder .* is inside the workspace/);
});

test('a file is not a workspace', async () => {
  await writeFile(join(project, 'file.txt'), '');
  await assert.rejects(check(join(project, 'file.txt')), /not a folder/);
  await assert.rejects(check(join(project, 'missing')), /not a folder/);
});
