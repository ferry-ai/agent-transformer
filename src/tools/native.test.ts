import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { ToolCall } from '../agent/protocol.js';
import { nativeTools } from './native.js';
import { Toolbox } from './toolbox.js';
import type { ApprovalRequest } from './types.js';

let root = '';
let outside = '';
const asked: ApprovalRequest[] = [];
let allow = true;
let box: Toolbox;

before(async () => {
  const base = await mkdtemp(join(tmpdir(), 'agent-native-'));
  root = join(base, 'workspace');
  outside = join(base, 'outside');
  await mkdir(join(root, 'src', 'deep'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(root, 'src', 'a.txt'), 'one\ntwo\nthree\n');
  await writeFile(join(root, 'src', 'deep', 'b.txt'), 'b');
  await writeFile(join(outside, 'secret.txt'), 'secret');
  box = new Toolbox(nativeTools({ root }), {
    approve: async (request) => {
      asked.push(request);
      return allow ? { approved: true } : { approved: false, note: 'use npm test instead' };
    },
  });
});

after(async () => {
  await rm(join(root, '..'), { recursive: true, force: true });
});

const call = (tool: string, args: Record<string, unknown>, body?: string) => {
  const parsed: ToolCall = { index: 1, tool, args };
  if (body !== undefined) parsed.body = body;
  return box.call(parsed);
};

test('read_file reads whole files and slices of long ones', async () => {
  assert.deepEqual(await call('read_file', { path: 'src/a.txt' }), { ok: true, text: 'one\ntwo\nthree\n' });
  const slice = await call('read_file', { path: 'src/a.txt', offset: '2', limit: 1 });
  assert.equal(slice.text, '[lines 2-2 of 3. Next: offset 3.]\ntwo');
  assert.deepEqual(await call('read_file', { path: 'nope.txt' }), { ok: false, text: 'nope.txt does not exist.' });
});

test('paths outside the workspace are refused, symbolic links included', async () => {
  const escaped = await call('read_file', { path: '../outside/secret.txt' });
  assert.equal(escaped.ok, false);
  assert.match(escaped.text, /outside the workspace/);
  assert.equal((await call('read_file', { path: join(outside, 'secret.txt') })).ok, false);

  await symlink(outside, join(root, 'link'), 'dir');
  const linked = await call('read_file', { path: 'link/secret.txt' });
  assert.match(linked.text, /outside the workspace/);
  assert.equal((await call('write_file', { path: 'link/new.txt' }, 'x')).ok, false);
  await rm(join(root, 'link'));
});

test('write_file takes the content from the body and creates folders', async () => {
  const result = await call('write_file', { path: 'new/dir/c.py' }, 'print("hi")\n');
  assert.deepEqual(result, { ok: true, text: 'Created new/dir/c.py (1 lines).' });
  assert.equal(await readFile(join(root, 'new', 'dir', 'c.py'), 'utf8'), 'print("hi")\n');
  const again = await call('write_file', { path: 'new/dir/c.py', content: '' });
  assert.equal(again.text, 'Overwrote new/dir/c.py (0 lines).');
});

test('edit_file applies SEARCH/REPLACE blocks only when each matches once', async () => {
  await writeFile(join(root, 'e.txt'), 'alpha\nbeta\ngamma\nbeta\n');
  const edits = '<<<<<<< SEARCH\nalpha\n=======\nALPHA\n>>>>>>> REPLACE\n<<<<<<< SEARCH\ngamma\nbeta\n=======\n>>>>>>> REPLACE\n';
  assert.deepEqual(await call('edit_file', { path: 'e.txt' }, edits), { ok: true, text: 'Edited e.txt: 2 changes.' });
  assert.equal(await readFile(join(root, 'e.txt'), 'utf8'), 'ALPHA\nbeta\n\n');

  await writeFile(join(root, 'e.txt'), 'x\nx\n');
  const twice = await call('edit_file', { path: 'e.txt' }, '<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE');
  assert.match(twice.text, /appears 2 times/);
  const missing = await call('edit_file', { path: 'e.txt' }, '<<<<<<< SEARCH\nz\n=======\ny\n>>>>>>> REPLACE');
  assert.match(missing.text, /not in e.txt/);
  assert.equal(await readFile(join(root, 'e.txt'), 'utf8'), 'x\nx\n');
  assert.match((await call('edit_file', { path: 'e.txt' }, 'just text')).text, /No SEARCH\/REPLACE block/);
});

test('edit_file keeps Windows line endings', async () => {
  await writeFile(join(root, 'crlf.txt'), 'a\r\nb\r\n');
  await call('edit_file', { path: 'crlf.txt' }, '<<<<<<< SEARCH\na\nb\n=======\nc\nd\n>>>>>>> REPLACE');
  assert.equal(await readFile(join(root, 'crlf.txt'), 'utf8'), 'c\r\nd\r\n');
});

test('list_dir lists folders recursively but skips node_modules', async () => {
  const flat = await call('list_dir', {});
  assert.ok(flat.text.split('\n').includes('src/'));
  const deep = await call('list_dir', { path: '.', depth: 3 });
  const lines = deep.text.split('\n');
  assert.ok(lines.includes('src/deep/b.txt'));
  assert.ok(lines.includes('node_modules/'));
  assert.ok(!lines.some((line) => line.startsWith('node_modules/pkg')));
  assert.match((await call('list_dir', { path: 'src/a.txt' })).text, /not a folder/);
});

test('run_command asks first, then reports output and exit code', async () => {
  asked.length = 0;
  allow = true;
  const result = await call('run_command', {}, 'echo out && echo err 1>&2 && exit 3');
  assert.equal(asked.length, 1);
  assert.match(asked[0]?.summary ?? '', /^run a command in /);
  assert.equal(asked[0]?.detail, 'echo out && echo err 1>&2 && exit 3');
  assert.equal(result.ok, false);
  assert.match(result.text, /^\[exit code 3\]/);
  assert.match(result.text, /out/);
  assert.match(result.text, /err/);
  assert.deepEqual(await call('run_command', { command: 'node -e "process.stdout.write(process.cwd())"' }), {
    ok: true,
    text: `[exit code 0]\n${await realpath(root)}`,
  });
});

test('a denied command does not run and the note reaches the model', async () => {
  allow = false;
  const result = await call('run_command', { command: 'echo nope > denied.txt' });
  allow = true;
  assert.deepEqual(result, { ok: false, text: 'The user did not allow this call. The user says: use npm test instead' });
  assert.equal((await call('read_file', { path: 'denied.txt' })).ok, false);
});

test('run_command stops at the timeout', async () => {
  const result = await call('run_command', { command: 'node -e "setTimeout(() => {}, 10000)"', timeout_sec: 1 });
  assert.equal(result.ok, false);
  assert.match(result.text, /timeout/);
});

test('without an approver, calls that need approval are denied', async () => {
  const strict = new Toolbox(nativeTools({ root }));
  const result = await strict.call({ index: 1, tool: 'run_command', args: { command: 'echo hi' } });
  assert.equal(result.ok, false);
});

test('commands get a clean environment: no tokens unless passed with --pass-env', async () => {
  process.env.AGENT_TEST_TOKEN = 'ghp_not_for_the_chat';
  process.env.LC_TIME = 'C';
  const printEnv = `"${process.execPath}" -e "process.stdout.write(JSON.stringify(process.env))"`;
  try {
    const plain = JSON.parse((await call('run_command', { command: printEnv })).text.replace(/^\[exit code 0\]\n/, ''));
    assert.equal(plain.AGENT_TEST_TOKEN, undefined);
    assert.equal(plain.LC_TIME, 'C');
    assert.ok(plain.PATH);
    const allowed = Object.keys(plain).filter((name) => !/^(LANG|LANGUAGE|LC_\w+|TZ)$/.test(name));
    for (const name of allowed) {
      assert.ok(['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER', 'PWD', 'SHLVL', '_', 'OLDPWD'].includes(name) || process.platform === 'win32', name);
    }

    const passing = new Toolbox(nativeTools({ root, passEnv: ['AGENT_TEST_TOKEN'] }), { approve: async () => ({ approved: true }) });
    const passed = await passing.call({ index: 1, tool: 'run_command', args: { command: printEnv } });
    assert.equal(JSON.parse(passed.text.replace(/^\[exit code 0\]\n/, '')).AGENT_TEST_TOKEN, 'ghp_not_for_the_chat');
  } finally {
    delete process.env.AGENT_TEST_TOKEN;
    delete process.env.LC_TIME;
  }
});
