import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { ToolCall } from '../agent/protocol.js';
import { nativeTools } from './native.js';
import { foldName, PathPolicy } from './paths.js';
import { Toolbox } from './toolbox.js';
import type { ApprovalRequest } from './types.js';

const posix = process.platform !== 'win32';
let base = '';
let root = '';
let outside = '';
let dataDir = '';
const asked: ApprovalRequest[] = [];
let allow = false;
let box: Toolbox;

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'agent-paths-'));
  root = join(base, 'workspace');
  outside = join(base, 'outside');
  dataDir = join(root, 'agent-data');
  await mkdir(join(root, '.git', 'hooks'), { recursive: true });
  await mkdir(join(dataDir, 'profiles'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(root, '.git', 'config'), '[core]\n');
  await writeFile(join(dataDir, 'mcp.json'), '{"token": "secret"}');
  await writeFile(join(root, '.env'), 'API_KEY=secret\n');
  await writeFile(join(root, 'notes.txt'), 'notes\n');
  await writeFile(join(outside, 'secret.txt'), 'secret');
  box = new Toolbox(nativeTools({ root, dataDir }), {
    approve: async (request) => {
      asked.push(request);
      return { approved: allow };
    },
  });
});

after(async () => {
  await rm(base, { recursive: true, force: true });
});

function call(tool: string, args: Record<string, unknown>, body?: string) {
  const parsed: ToolCall = { index: 1, tool, args };
  if (body !== undefined) parsed.body = body;
  return box.call(parsed);
}

async function refused(tool: string, path: string, pattern: RegExp, body = 'x'): Promise<void> {
  const before = asked.length;
  const args = tool === 'list_dir' ? { path } : { path };
  const result = await call(tool, args, tool === 'write_file' || tool === 'edit_file' ? body : undefined);
  assert.equal(result.ok, false, `${tool} ${path}: ${result.text}`);
  assert.match(result.text, pattern, `${tool} ${path}`);
  assert.equal(asked.length, before, `${tool} ${path} should be refused without asking`);
}

test('names fold like case-insensitive, normalizing file systems', () => {
  assert.equal(foldName('.GIT'), '.git');
  assert.equal(foldName('.git.'), '.git');
  assert.equal(foldName('.git  '), '.git');
  assert.equal(foldName('.g‌it'), '.git');
  assert.equal(foldName('.git::$INDEX_ALLOCATION'), '.git');
  assert.equal(foldName('.gıt'), '.git'); // dotless i: NTFS upper-cases it to I
  assert.equal(foldName('ID_RSA.Key'), 'id_rsa.key'); // Kelvin sign: APFS folds it to k
  assert.equal(foldName('Café'), 'café');
});

test('.git is refused for every tool and every spelling', async () => {
  const spellings = [
    '.git/config',
    '.git/hooks/pre-commit',
    './.git/config',
    'src/../.git/config',
    join(root, '.git', 'config'),
    '.GIT/config',
    '.Git/hooks/post-checkout',
    '.git./config',
    '.git /config',
    '.g‌it/config',
    'git~1/config',
    '.git::$INDEX_ALLOCATION/config',
    '.gıt/config',
    'sub/.git/config',
    'sub\\.git\\hooks\\pre-commit',
    '.git',
  ];
  for (const path of spellings) {
    await refused('write_file', path, /\.git, which is off limits|control or invisible/);
    await refused('read_file', path, /\.git, which is off limits/);
  }
  await refused('edit_file', '.git/config', /off limits/, '<<<<<<< SEARCH\n[core]\n=======\n[core]\n\tfsmonitor = x\n>>>>>>> REPLACE');
  await refused('list_dir', '.git/hooks', /off limits/);
  assert.equal(await readFile(join(root, '.git', 'config'), 'utf8'), '[core]\n');
  assert.ok(!existsSync(join(root, '.git', 'hooks', 'pre-commit')));
});

test('a symbolic link into .git is refused too', { skip: !posix }, async () => {
  await symlink('.git', join(root, 'gitlink'), 'dir');
  await symlink(join('.git', 'config'), join(root, 'config-link'));
  await refused('write_file', 'gitlink/hooks/pre-commit', /off limits/);
  await refused('read_file', 'config-link', /off limits/);
  await refused('write_file', 'config-link', /off limits/);
  await rm(join(root, 'gitlink'));
  await rm(join(root, 'config-link'));
});

test('the data dir is refused even inside the workspace, under any name', async () => {
  await refused('read_file', 'agent-data/mcp.json', /data folder/);
  await refused('write_file', 'agent-data/profiles/Default/Cookies', /data folder/);
  await refused('write_file', 'AGENT-DATA/new.txt', /data folder/);
  await refused('list_dir', 'agent-data', /data folder/);
  await refused('read_file', 'sub/../agent-data/mcp.json', /data folder/);
  if (posix) {
    await symlink('agent-data', join(root, 'data-link'), 'dir');
    await refused('read_file', 'data-link/mcp.json', /data folder/);
    await rm(join(root, 'data-link'));
  }
  const listing = await call('list_dir', { path: '.', depth: 3 });
  assert.ok(listing.text.split('\n').includes('agent-data/'));
  assert.ok(!listing.text.includes('mcp.json'), listing.text);
});

test('likely secrets are read only after the user says yes, with the reason shown', async () => {
  for (const name of ['.env.local', 'config/prod.pem', 'server.key', 'id_rsa', 'id_ed25519.pub', '.npmrc', '.pypirc', '.netrc', 'credentials.json', 'ENV/.ENV']) {
    await mkdir(join(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), 'secret\n');
  }
  for (const name of ['.env', '.env.local', 'config/prod.pem', 'server.key', 'id_rsa', 'id_ed25519.pub', '.npmrc', '.pypirc', '.netrc', 'credentials.json', 'ENV/.ENV']) {
    asked.length = 0;
    allow = false;
    const denied = await call('read_file', { path: name });
    assert.equal(denied.ok, false, name);
    assert.match(denied.text, /did not allow/);
    assert.equal(asked.length, 1, name);
    assert.match(asked[0]?.warnings?.[0] ?? '', /may hold secrets: what the agent reads is sent to the chat provider/);
    allow = true;
    assert.equal((await call('read_file', { path: name })).ok, true, name);
  }
  allow = false;
  asked.length = 0;
  assert.equal((await call('read_file', { path: 'notes.txt' })).ok, true);
  assert.equal(asked.length, 0);
});

test('a link with an innocent name pointing to a secret still asks', { skip: !posix }, async () => {
  await symlink('.env', join(root, 'innocent.txt'));
  asked.length = 0;
  allow = false;
  assert.equal((await call('read_file', { path: 'innocent.txt' })).ok, false);
  assert.match(asked[0]?.warnings?.[0] ?? '', /\.env may hold secrets/);
  await rm(join(root, 'innocent.txt'));
});

test('editing a secret asks before reading it: a SEARCH match would leak it', async () => {
  asked.length = 0;
  allow = false;
  const result = await call('edit_file', { path: '.env' }, '<<<<<<< SEARCH\nAPI_KEY=s\n=======\nAPI_KEY=s\n>>>>>>> REPLACE');
  assert.match(result.text, /did not allow/);
  assert.doesNotMatch(result.text, /SEARCH text/);
  assert.match(asked[0]?.warnings?.[0] ?? '', /editing reads it/);
});

test('files that run code by themselves are written only after the user says yes', async () => {
  const files = [
    '.envrc',
    'sub/.envrc',
    '.husky/pre-commit',
    '.vscode/tasks.json',
    'pkg/.VSCode/settings.json',
    '.github/workflows/ci.yml',
    '.npmrc',
    '.yarnrc.yml',
    '.pnpmfile.cjs',
    '.pre-commit-config.yaml',
    '.devcontainer/devcontainer.json',
    'bare/HEAD',
  ];
  // In a fresh folder: the rules apply at any depth, and nothing there exists yet.
  for (const path of files.map((file) => `auto/${file}`)) {
    asked.length = 0;
    allow = false;
    const denied = await call('write_file', { path }, 'echo pwned\n');
    assert.equal(denied.ok, false, path);
    assert.equal(asked.length, 1, path);
    assert.ok((asked[0]?.warnings?.length ?? 0) > 0, path);
    assert.equal(asked[0]?.detail, 'echo pwned\n', `${path}: the prompt shows the content`);
    assert.ok(!existsSync(join(root, path)), `${path} must not exist after a no`);
  }
  allow = true;
  assert.equal((await call('write_file', { path: '.envrc' }, 'export A=1\n')).ok, true);
  allow = false;
  asked.length = 0;
  assert.equal((await call('write_file', { path: '.github/README.md' }, 'ok\n')).ok, true);
  assert.equal((await call('write_file', { path: 'src/vscode.txt' }, 'ok\n')).ok, true);
  assert.equal(asked.length, 0);
});

test('writing through a hard link asks first', { skip: !posix }, async () => {
  await writeFile(join(outside, 'shared.txt'), 'original\n');
  await link(join(outside, 'shared.txt'), join(root, 'hardlink.txt'));
  asked.length = 0;
  allow = false;
  assert.equal((await call('write_file', { path: 'hardlink.txt' }, 'changed\n')).ok, false);
  assert.match(asked[0]?.warnings?.[0] ?? '', /2 hard links/);
  assert.equal((await call('edit_file', { path: 'hardlink.txt' }, '<<<<<<< SEARCH\noriginal\n=======\nchanged\n>>>>>>> REPLACE')).ok, false);
  assert.equal(await readFile(join(outside, 'shared.txt'), 'utf8'), 'original\n');
  // Reading is fine: the content is what the workspace holds.
  assert.equal((await call('read_file', { path: 'hardlink.txt' })).ok, true);
  await rm(join(root, 'hardlink.txt'));
});

test('a dangling symbolic link cannot create files outside the workspace', { skip: !posix }, async () => {
  await symlink(join('..', 'outside', 'created.txt'), join(root, 'dangling'));
  await symlink(join('..', 'outside', 'newdir'), join(root, 'dangling-dir'));
  await refused('write_file', 'dangling', /target is missing/);
  await refused('write_file', 'dangling-dir/x.txt', /target is missing/);
  assert.ok(!existsSync(join(outside, 'created.txt')));
  assert.ok(!existsSync(join(outside, 'newdir')));
  await rm(join(root, 'dangling'));
  await rm(join(root, 'dangling-dir'));
});

test('paths outside the workspace are refused in every form', async () => {
  for (const path of ['../outside/secret.txt', join(outside, 'secret.txt'), 'src/../../outside/secret.txt', '/etc/passwd']) {
    await refused('read_file', path, /outside the workspace/);
    await refused('write_file', path, /outside the workspace/);
  }
  if (posix) {
    await symlink(outside, join(root, 'out-link'), 'dir');
    await refused('read_file', 'out-link/secret.txt', /outside the workspace/);
    await rm(join(root, 'out-link'));
  }
  // A name that only starts with "..": inside.
  assert.equal((await call('write_file', { path: '..notes' }, 'ok\n')).ok, true);
});

test('control characters in a path are refused for writes and escaped in messages', async () => {
  for (const path of ['evil\x1b[2J.txt', 'a\nb.txt', 'name‮TXT.exe', 'zero​width.txt']) {
    await refused('write_file', path, /control or invisible characters/);
  }
  const result = await call('write_file', { path: 'evil\x1b[2J.txt' }, 'x');
  assert.doesNotMatch(result.text, /\x1b/);
  assert.match(result.text, /evil\\x1b\[2J\.txt/);
});

test('a FIFO is refused instead of blocking the agent', { skip: !posix || !hasMkfifo() }, async () => {
  execFileSync('mkfifo', [join(root, 'pipe')]);
  const read = await call('read_file', { path: 'pipe' });
  assert.match(read.text, /not a regular file/);
  const write = await call('write_file', { path: 'pipe' }, 'x');
  assert.match(write.text, /not a regular file/);
  await rm(join(root, 'pipe'));
});

test('a folder swapped for a link after the check is caught when the file is opened', { skip: !posix }, async () => {
  await mkdir(join(root, 'swap'));
  await writeFile(join(root, 'swap', 'file.txt'), 'inside\n');
  await writeFile(join(outside, 'file.txt'), 'outside\n');
  const policy = new PathPolicy({ root, dataDir });
  const checked = await policy.check('swap/file.txt', 'write');
  // What a process left running by a command could do between the check and the open.
  await rename(join(root, 'swap'), join(root, 'swap-old'));
  await symlink(outside, join(root, 'swap'), 'dir');
  await assert.rejects(policy.open(checked, 'write'), /changed while it was being opened/);
  assert.equal(await readFile(join(outside, 'file.txt'), 'utf8'), 'outside\n');
  await rm(join(root, 'swap'));
  await rm(join(root, 'swap-old'), { recursive: true });
});

test('Windows rules: device names and alternate data streams', async () => {
  const policy = new PathPolicy({ root, platform: 'win32' });
  for (const path of ['CON', 'nul.txt', 'sub/COM1.log', 'lpt¹', 'notes.txt:hidden']) {
    await assert.rejects(policy.check(path, 'write'), /device name|":" is not allowed/, path);
  }
  assert.ok(await policy.check('console.txt', 'write'));
});

function hasMkfifo(): boolean {
  try {
    execFileSync('mkfifo', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
