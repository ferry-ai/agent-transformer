/**
 * Regressions from the attack pass on our own protections: each test is a way around
 * one of them that was tried, and must stay closed. Harmless content only, in
 * temporary folders.
 */
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { nativeTools } from './native.js';
import { createCommandRunner, DEFAULT_SANDBOX_IMAGE, type Exec } from './sandbox.js';
import { Toolbox } from './toolbox.js';
import type { ApprovalRequest } from './types.js';

const posix = process.platform !== 'win32';
let base = '';
let root = '';
let outside = '';
const asked: ApprovalRequest[] = [];
let box: Toolbox;

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'agent-bypass-'));
  root = join(base, 'workspace');
  outside = join(base, 'outside');
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(root, '.git', 'config'), '[core]\n');
  await writeFile(join(outside, 'host-file.txt'), 'host\n');
  box = new Toolbox(nativeTools({ root, dataDir: join(base, 'data') }), {
    approve: async (request) => {
      asked.push(request);
      return { approved: false };
    },
  });
});

after(async () => {
  await rm(base, { recursive: true, force: true });
});

test('an image name cannot smuggle an option into the container command line', async () => {
  const exec: Exec = async () => ({ code: 0, stdout: '[]', stderr: '' });
  const options = (image: string) => ({
    choice: 'docker' as const,
    image,
    network: false,
    workspace: root,
    dataDir: join(base, 'data'),
    passEnv: [],
    confirm: async () => false,
    notify: () => undefined,
    exec,
  });
  for (const image of ['--privileged', '-v=/:/host', '', 'node:24 --network=host', 'img\nname']) {
    await assert.rejects(createCommandRunner(options(image)), /is not an image name/, JSON.stringify(image));
  }
  for (const image of [DEFAULT_SANDBOX_IMAGE, 'ghcr.io/me/sandbox@sha256:0123abcd', 'localhost:5000/tools:1.2']) {
    assert.ok(await createCommandRunner(options(image)), image);
  }
});

test('case and invisible-character variants of secrets and auto-run files still ask', async () => {
  await writeFile(join(root, '.En​v'), 'secret\n');
  asked.length = 0;
  assert.equal((await box.call({ index: 1, tool: 'read_file', args: { path: '.En​v' } })).ok, false);
  assert.equal(asked.length, 1);
  for (const path of ['.VSCODE/tasks.json', '.Husky/pre-commit', '.GitHub/Workflows/ci.yml', '.EnvRC', 'pkg/.NPMRC']) {
    asked.length = 0;
    const result = await box.call({ index: 1, tool: 'write_file', args: { path }, body: 'x\n' });
    assert.equal(result.ok, false, path);
    assert.equal(asked.length, 1, `${path} should ask`);
  }
});

test('a link a sandboxed command leaves in the workspace does not reach the host', { skip: !posix }, async () => {
  // Inside the container these targets do not exist; on the host they do.
  await symlink(join(outside, 'host-file.txt'), join(root, 'absolute-link'));
  await symlink(join('..', 'outside'), join(root, 'relative-link'), 'dir');
  for (const path of ['absolute-link', 'relative-link/host-file.txt', 'relative-link/new.txt']) {
    for (const tool of ['read_file', 'write_file']) {
      const result = await box.call({ index: 1, tool, args: { path }, body: tool === 'write_file' ? 'x\n' : undefined });
      assert.match(result.text, /outside the workspace/, `${tool} ${path}`);
    }
  }
  assert.equal(await readFile(join(outside, 'host-file.txt'), 'utf8'), 'host\n');
});

test('a hard link to .git/config under an innocent name asks before a write', { skip: !posix }, async () => {
  await link(join(root, '.git', 'config'), join(root, 'notes.cfg'));
  asked.length = 0;
  const result = await box.call({ index: 1, tool: 'write_file', args: { path: 'notes.cfg' }, body: '[core]\n\tfsmonitor = x\n' });
  assert.equal(result.ok, false);
  assert.match(asked[0]?.warnings?.join(' ') ?? '', /2 hard links/);
  assert.equal(await readFile(join(root, '.git', 'config'), 'utf8'), '[core]\n');
});
