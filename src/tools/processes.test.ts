import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ProcessGroups } from './processes.js';
import { runCommand } from './shell.js';

const posix = process.platform !== 'win32';
const fixture = fileURLToPath(new URL('./fixtures/leave-running.ts', import.meta.url));
// Resolved here: the fixture runs in a temporary folder, where "tsx" alone cannot be found.
const tsx = import.meta.resolve('tsx');
const sleeper = `"${process.execPath}" -e "setInterval(() => {}, 1000)"`;

/** Alive and not a zombie waiting for a parent that does not reap it. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== 'linux') return true;
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return false;
  }
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 50; i += 1) {
    if (!alive(pid)) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
}

test('a finished group is forgotten; one with a leftover is killed by killAll', { skip: !posix }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-groups-'));
  try {
    const groups = new ProcessGroups();
    await runCommand('echo done', { cwd: dir, timeoutMs: 5_000, groups });
    assert.deepEqual(groups.live, []);
    await runCommand(`${sleeper} > /dev/null 2>&1 & echo $! > pid`, { cwd: dir, timeoutMs: 5_000, groups });
    const pid = Number(await readFile(join(dir, 'pid'), 'utf8'));
    assert.equal(groups.live.length, 1, 'the leftover keeps its group alive between commands');
    assert.ok(alive(pid));
    groups.killAll();
    assert.ok(await gone(pid));
    assert.deepEqual(groups.live, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const how of ['SIGTERM', 'SIGINT', 'SIGHUP', 'crash', 'exit'] as const) {
  test(`what a command left running dies with the agent (${how})`, { skip: !posix }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-exit-'));
    const pidFile = join(dir, 'pid');
    try {
      const child = spawn(process.execPath, ['--import', tsx, fixture, pidFile, how.startsWith('SIG') ? 'signal' : how], {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const exited = new Promise((done) => child.once('exit', done));
      await new Promise<void>((done, fail) => {
        child.stdout.on('data', (chunk: Buffer) => {
          if (chunk.toString().includes('ready')) done();
        });
        child.once('exit', () => fail(new Error('the fixture exited before it was ready')));
      });
      const pid = Number(await readFile(pidFile, 'utf8'));
      assert.ok(alive(pid), 'the leftover runs while the agent runs');
      if (how.startsWith('SIG')) child.kill(how as NodeJS.Signals);
      await exited;
      assert.ok(await gone(pid), `pid ${pid} survived ${how}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
