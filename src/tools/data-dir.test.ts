import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Transcript } from '../core/transcript.js';
import { preparePrivateDataDir } from './data-dir.js';

const posix = process.platform !== 'win32';
const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

test('a new data dir and its folders are created 0700', { skip: !posix }, async () => {
  const base = await mkdtemp(join(tmpdir(), 'agent-datadir-'));
  try {
    const dataDir = join(base, 'agent-transformer');
    assert.deepEqual(await preparePrivateDataDir(dataDir, { isDefault: true }), []);
    assert.equal(await mode(dataDir), 0o700);
    for (const folder of ['profiles', 'sessions', 'checkpoints']) assert.equal(await mode(join(dataDir, folder)), 0o700, folder);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('existing folders with loose modes are tightened; a chosen data dir only warns', { skip: !posix }, async () => {
  const base = await mkdtemp(join(tmpdir(), 'agent-datadir-'));
  try {
    const dataDir = join(base, 'data');
    await mkdir(join(dataDir, 'profiles', 'deepseek'), { recursive: true });
    await mkdir(join(dataDir, 'sessions'));
    await chmod(dataDir, 0o755);
    await chmod(join(dataDir, 'profiles'), 0o755);
    await chmod(join(dataDir, 'sessions'), 0o777);
    await writeFile(join(dataDir, 'mcp.json'), '{}', { mode: 0o644 });
    await chmod(join(dataDir, 'mcp.json'), 0o644);

    const warnings = await preparePrivateDataDir(dataDir, { isDefault: false });
    assert.equal(await mode(join(dataDir, 'profiles')), 0o700);
    assert.equal(await mode(join(dataDir, 'sessions')), 0o700);
    assert.equal(await mode(dataDir), 0o755, 'a folder the user chose is not changed');
    assert.equal(warnings.length, 2);
    assert.match(warnings[0] ?? '', /Others on this machine can open the data folder/);
    assert.match(warnings[1] ?? '', /mcp\.json, which may hold tokens/);

    await preparePrivateDataDir(dataDir, { isDefault: true });
    assert.equal(await mode(dataDir), 0o700, 'the default data dir is ours to tighten');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('session logs are 0600 in a 0700 folder, whatever the umask', { skip: !posix }, async () => {
  const base = await mkdtemp(join(tmpdir(), 'agent-datadir-'));
  const umask = process.umask(0o022);
  try {
    const transcript = await Transcript.create(base, 'fake');
    await transcript.turn({
      prompt: 'p',
      attachments: [],
      reply: { text: 't', source: 'network', durationMs: 1, raw: { stream: 's', html: '<p>' } },
    });
    assert.equal(await mode(transcript.dir), 0o700);
    assert.equal(await mode(join(base, 'sessions')), 0o700);
    for (const file of await readdir(transcript.dir)) assert.equal(await mode(join(transcript.dir, file)), 0o600, file);
  } finally {
    process.umask(umask);
    await rm(base, { recursive: true, force: true });
  }
});
