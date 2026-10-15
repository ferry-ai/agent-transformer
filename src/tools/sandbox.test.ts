import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { nativeTools } from './native.js';
import {
  ContainerRunner,
  createCommandRunner,
  DEFAULT_SANDBOX_IMAGE,
  detectRuntime,
  execArgs,
  execRuntime,
  killArgs,
  removeStaleContainers,
  runArgs,
  type ContainerSettings,
  type Exec,
  type ExecResult,
  type SandboxOptions,
  type Spawn,
} from './sandbox.js';
import { HostRunner, type CommandResult } from './shell.js';
import { Toolbox } from './toolbox.js';
import type { ApprovalRequest } from './types.js';

let base = '';
let workspace = '';

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'agent-sandbox-'));
  workspace = join(base, 'workspace');
  await mkdir(workspace);
});

after(async () => {
  await rm(base, { recursive: true, force: true });
});

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });

/** A container runtime that answers by subcommand and records every call. */
function fakeRuntime(answers: Record<string, ExecResult | ((args: string[]) => ExecResult)> = {}) {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    const answer = answers[args[0] ?? ''];
    return typeof answer === 'function' ? answer(args) : (answer ?? ok());
  };
  return { exec, calls };
}

/** A local "docker exec" client: done at once, or running until it is stopped. */
function fakeSpawn(behavior: 'done' | 'hang', output = 'hello\n') {
  const spawned: string[][] = [];
  const spawn: Spawn = (file, args, options) => {
    spawned.push([file, ...args]);
    const result = (exitCode: number | null): CommandResult => ({ exitCode, signal: null, output, timedOut: false, durationMs: 1 });
    if (behavior === 'done') return Promise.resolve(result(0));
    return new Promise((done) => {
      options.signal?.addEventListener('abort', () => done(result(137)), { once: true });
    });
  };
  return { spawn, spawned };
}

function settings(overrides: Partial<ContainerSettings> = {}): ContainerSettings {
  return {
    runtime: 'docker',
    binary: 'docker',
    image: DEFAULT_SANDBOX_IMAGE,
    workspace: '/home/me/project',
    network: false,
    passEnv: [],
    session: 'abc123',
    owner: 'laptop:4242',
    user: '1000:1000',
    gitDir: false,
    ...overrides,
  };
}

/** The value after a flag, for every time the flag appears. */
function values(args: string[], flag: string): string[] {
  return args.flatMap((arg, i) => (arg === flag ? [args[i + 1] ?? ''] : []));
}

test('the container gets the workspace and nothing else of the host', () => {
  const args = runArgs(settings({ passEnv: ['NPM_TOKEN'] }));
  assert.equal(args[0], 'run');
  for (const flag of ['--rm', '--detach', '--read-only', '--init', '--pull=never']) assert.ok(args.includes(flag), flag);
  assert.deepEqual(values(args, '--network'), ['none']);
  assert.deepEqual(values(args, '--cap-drop'), ['ALL']);
  assert.deepEqual(values(args, '--security-opt'), ['no-new-privileges']);
  assert.deepEqual(values(args, '--pids-limit'), ['512']);
  assert.deepEqual(values(args, '--memory'), ['2g']);
  assert.deepEqual(values(args, '--memory-swap'), ['2g']);
  assert.deepEqual(values(args, '--cpus'), ['2']);
  assert.deepEqual(values(args, '--tmpfs').map((value) => value.split(':')[0]), ['/tmp', '/home/sandbox']);
  assert.deepEqual(values(args, '--mount'), ['type=bind,source=/home/me/project,target=/workspace']);
  assert.deepEqual(values(args, '--workdir'), ['/workspace']);
  assert.deepEqual(values(args, '--user'), ['1000:1000']);
  assert.deepEqual(values(args, '--label'), ['agent-transformer.session=abc123', 'agent-transformer.owner=laptop:4242']);
  // No host environment: fixed values, and pass-env by name only (the value never reaches a command line).
  assert.deepEqual(values(args, '--env'), ['HOME=/home/sandbox', 'TMPDIR=/tmp', 'LANG=C.UTF-8', 'NPM_TOKEN']);
  const joined = args.join(' ');
  for (const forbidden of ['-v', '--volume', '--privileged', '--network=host', '--pid', '--ipc=host']) {
    assert.ok(!args.includes(forbidden), forbidden);
  }
  for (const forbidden of ['docker.sock', 'SSH_AUTH_SOCK', '/home/me ', '/home/me/.', '--cap-add']) {
    assert.ok(!joined.includes(forbidden), forbidden);
  }
  assert.deepEqual(args.slice(-4), [DEFAULT_SANDBOX_IMAGE, 'sh', '-c', 'while :; do sleep 86400; done']);
});

test('.git is mounted read-only, the data dir hidden, the network only on request', () => {
  const args = runArgs(settings({ gitDir: true, dataDir: '/home/me/project/.agent', network: true }));
  assert.deepEqual(values(args, '--mount'), [
    'type=bind,source=/home/me/project,target=/workspace',
    'type=bind,source=/home/me/project/.git,target=/workspace/.git,readonly',
    'type=tmpfs,target=/workspace/.agent,tmpfs-size=4096,tmpfs-mode=0',
  ]);
  assert.deepEqual(values(args, '--network'), []);
  // A data dir outside the workspace is simply not mounted.
  assert.equal(values(runArgs(settings({ dataDir: '/home/me/.local/share/agent-transformer' })), '--mount').length, 1);
});

test('commands go to exec as one argument, never through a shell on the host', () => {
  const command = 'echo "$HOME" && rm -rf / ; `id` $(whoami)';
  const args = execArgs('agent-transformer-abc123', 'abc123-1', command, true);
  assert.deepEqual(args.slice(0, 4), ['exec', '--workdir', '/workspace', 'agent-transformer-abc123']);
  assert.equal(args.at(-2), command);
  assert.equal(args.at(-1), 'setsid');
  assert.equal(args.at(-3), '/tmp/.agent-run-abc123-1');
  assert.deepEqual(killArgs('agent-transformer-abc123', 'abc123-1').slice(0, 4), ['exec', 'agent-transformer-abc123', 'sh', '-c']);
});

async function runnerFor(answers: Record<string, ExecResult | ((args: string[]) => ExecResult)>, extra: Partial<SandboxOptions> = {}) {
  const runtime = fakeRuntime({ info: ok('["name=seccomp,profile=builtin"]'), ...answers });
  const notes: string[] = [];
  const asked: string[] = [];
  const runner = await createCommandRunner({
    choice: 'auto',
    image: DEFAULT_SANDBOX_IMAGE,
    network: false,
    workspace,
    dataDir: join(base, 'data'),
    passEnv: [],
    confirm: async (question) => {
      asked.push(question);
      return false;
    },
    notify: (message) => notes.push(message),
    exec: runtime.exec,
    platform: 'linux',
    uid: 1000,
    gid: 1001,
    ...extra,
  });
  return { runner, calls: runtime.calls, notes, asked };
}

test('on Linux the container runs as the host user: --user, or keep-id with Podman', async () => {
  const startArgs = async (answers: Record<string, ExecResult>, extra: Partial<SandboxOptions> = {}) => {
    const { spawn } = fakeSpawn('done');
    const { runner, calls } = await runnerFor(answers, { ...extra, spawn });
    await runner.run('true', { timeoutMs: 1_000 });
    return calls.find((call) => call[1] === 'run') ?? [];
  };
  const rootful = await startArgs({});
  assert.deepEqual(values(rootful, '--user'), ['1000:1001']);
  const rootless = await startArgs({ info: ok('["name=seccomp","name=rootless"]') });
  assert.deepEqual(values(rootless, '--user'), []);
  const podman = await startArgs({ info: ok('true') }, { choice: 'podman' });
  assert.equal(podman[0], 'podman');
  assert.ok(podman.includes('--userns=keep-id'));
  assert.deepEqual(values(podman, '--user'), ['1000:1001']);
  const mac = await startArgs({}, { platform: 'darwin' });
  assert.deepEqual(values(mac, '--user'), []);
});

test('one container per session: created at the first command, removed at exit', async () => {
  const { spawn, spawned } = fakeSpawn('done');
  const { runner, calls } = await runnerFor({}, { spawn });
  assert.ok(!calls.some((call) => call[1] === 'run'), 'nothing is created before the first command');
  assert.equal(runner.where, '[sandbox: docker, network off]');
  const first = await runner.run('echo hello', { timeoutMs: 1_000 });
  await runner.run('echo again', { timeoutMs: 1_000 });
  assert.equal(first.output, 'hello\n');
  assert.equal(calls.filter((call) => call[1] === 'run').length, 1);
  assert.equal(spawned.length, 2);
  assert.equal(spawned[0]?.at(-2), 'echo hello');
  await runner.close();
  const name = (runner as ContainerRunner).name;
  assert.deepEqual(calls.at(-1), ['docker', 'rm', '--force', name]);
});

test('a timeout kills the command inside the container, then the local client', async () => {
  const { spawn } = fakeSpawn('hang');
  const { runner, calls } = await runnerFor({}, { spawn });
  const result = await runner.run('sleep 600', { timeoutMs: 50 });
  assert.equal(result.timedOut, true);
  const name = (runner as ContainerRunner).name;
  const kill = calls.find((call) => call[1] === 'exec' && call[2] === name && call.at(-1)?.startsWith('/tmp/.agent-run-'));
  assert.ok(kill, 'the kill ran inside the container');
  assert.ok(!calls.some((call) => call[1] === 'restart'), 'setsid worked: no restart needed');
});

test('an abort kills inside too; without setsid, or when the kill fails, the container restarts', async () => {
  const { spawn } = fakeSpawn('hang');
  const probeFails = (args: string[]): ExecResult => (args.includes('command -v setsid >/dev/null 2>&1 && setsid -w true') ? { code: 1, stdout: '', stderr: '' } : ok());
  const { runner, calls, notes } = await runnerFor({ exec: probeFails }, { spawn });
  const controller = new AbortController();
  const running = runner.run('sleep 600', { timeoutMs: 60_000, signal: controller.signal });
  await new Promise((done) => setTimeout(done, 20));
  controller.abort();
  const result = await running;
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 137);
  assert.ok(calls.some((call) => call[1] === 'restart' && call.includes('0')));
  assert.ok(notes.some((note) => /restart/.test(note)));
});

test('a container that does not start is an error for the model, never a run on the host', async () => {
  const { spawn, spawned } = fakeSpawn('done');
  const { runner } = await runnerFor({ run: { code: 125, stdout: '', stderr: 'docker: Error response from daemon: no space left' } }, { spawn });
  const box = new Toolbox(nativeTools({ root: workspace, runner }), { approve: async () => ({ approved: true }) });
  const result = await box.call({ index: 1, tool: 'run_command', args: { command: 'echo hi' } });
  assert.equal(result.ok, false);
  assert.match(result.text, /did not start, so the command did not run: .*no space left/);
  assert.equal(spawned.length, 0);
});

test('every approval prompt says where the command runs', async () => {
  const asked: ApprovalRequest[] = [];
  const approve = async (request: ApprovalRequest) => {
    asked.push(request);
    return { approved: false };
  };
  const { spawn } = fakeSpawn('done');
  const { runner } = await runnerFor({}, { spawn });
  await new Toolbox(nativeTools({ root: workspace, runner }), { approve }).call({ index: 1, tool: 'run_command', args: { command: 'ls' } });
  assert.equal(asked[0]?.where, '[sandbox: docker, network off]');
  assert.equal(asked[0]?.summary, 'run a command in /workspace');
  const host = new HostRunner({ root: workspace, fallback: 'no Docker or Podman was found.' });
  await new Toolbox(nativeTools({ root: workspace, runner: host }), { approve }).call({ index: 1, tool: 'run_command', args: { command: 'ls' } });
  assert.equal(asked[1]?.where, '[HOST, not sandboxed]');
  assert.match(asked[1]?.warnings?.[0] ?? '', /Not sandboxed: no Docker or Podman was found/);
});

test('auto falls back to the host with a warning; docker or podman on request is required', async () => {
  const none = (): ExecResult => ({ code: null, stdout: '', stderr: 'spawn docker ENOENT' });
  const { runner, notes } = await runnerFor({ info: none });
  assert.ok(runner instanceof HostRunner);
  assert.equal(runner.where, '[HOST, not sandboxed]');
  assert.equal(runner.warnings.length, 1);
  assert.match(notes[0] ?? '', /Not sandboxed/);
  await assert.rejects(runnerFor({ info: none }, { choice: 'docker' }), /--sandbox docker: docker is not installed/);
  await assert.rejects(runnerFor({ info: { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' } }, { choice: 'docker' }), /docker is not running/);
  // --sandbox none asks nothing and warns about nothing: the user chose it.
  const chosen = await runnerFor({ info: none }, { choice: 'none' });
  assert.deepEqual(chosen.calls, []);
  assert.deepEqual(chosen.runner.warnings, []);
});

test('a missing image is pulled only after a yes; a no is an error, not the host', async () => {
  const missing = { image: { code: 1, stdout: '', stderr: 'No such image' } };
  const runtime = fakeRuntime({ info: ok('[]'), ...missing });
  const questions: string[] = [];
  const declined = createCommandRunner({
    choice: 'auto',
    image: DEFAULT_SANDBOX_IMAGE,
    network: false,
    workspace,
    dataDir: join(base, 'data'),
    passEnv: [],
    confirm: async (question) => {
      questions.push(question);
      return false;
    },
    notify: () => undefined,
    exec: runtime.exec,
  });
  await assert.rejects(declined, /image docker\.io\/library\/node:24-bookworm is missing/);
  assert.match(questions[0] ?? '', /not on this machine\. Download it now/);
  assert.ok(!runtime.calls.some((call) => call[1] === 'pull'), 'never pulled without a yes');
  const yes = await runnerFor(missing, { confirm: async () => true });
  assert.ok(yes.calls.some((call) => call[1] === 'pull' && call[2] === DEFAULT_SANDBOX_IMAGE));
});

test('containers left by a crashed session on this host are removed at the next start', async () => {
  const host = hostname();
  const runtime = fakeRuntime({
    ps: ok('aaa\nbbb\nccc\nddd\n'),
    inspect: ok(`aaa ${host}:111\nbbb ${host}:${process.pid}\nccc other-host:111\nddd \n`),
  });
  const removed = await removeStaleContainers('docker', runtime.exec, (pid) => pid === process.pid, host);
  assert.deepEqual(removed, ['aaa']);
  assert.deepEqual(runtime.calls.at(-1), ['docker', 'rm', '--force', 'aaa']);
  assert.ok(runtime.calls[0]?.includes('label=agent-transformer.session'));
});

test('a mount path that would break the mount options is refused', async () => {
  const odd = join(base, 'a,b');
  await mkdir(odd);
  await assert.rejects(runnerFor({}, { workspace: odd }), /commas, quotes and newlines/);
});

test('the user is warned when a command creates a git repository in the workspace', async () => {
  const fresh = join(base, 'no-git');
  await mkdir(fresh);
  const notes: string[] = [];
  const spawn: Spawn = async () => {
    await mkdir(join(fresh, '.git'));
    await writeFile(join(fresh, '.git', 'config'), '[core]\n\tfsmonitor = evil\n');
    return { exitCode: 0, signal: null, output: '', timedOut: false, durationMs: 1 };
  };
  const runner = new ContainerRunner(settings({ workspace: fresh }), {
    exec: fakeRuntime().exec,
    spawn,
    execSync: () => undefined,
    notify: (message) => notes.push(message),
  });
  await runner.run('git init', { timeoutMs: 1_000 });
  assert.ok(notes.some((note) => /created a git repository in the workspace \(\.git\)/.test(note)));
});

// A real container: only when Docker or Podman runs here and the image is already present.
const real = await (async () => {
  const { info } = await detectRuntime('auto', execRuntime);
  if (!info) return undefined;
  const image = process.env.AGENT_SANDBOX_TEST_IMAGE ?? DEFAULT_SANDBOX_IMAGE;
  const present = await execRuntime(info.binary, ['image', 'inspect', image]);
  return present.code === 0 ? { info, image } : undefined;
})();

test('a real container: confined, offline, killed on timeout, removed at exit', { skip: real === undefined && 'needs Docker or Podman and the image, already present' }, async () => {
  if (!real) return;
  const dir = await mkdtemp(join(tmpdir(), 'agent-real-sandbox-'));
  const ws = join(dir, 'workspace');
  await mkdir(join(ws, '.git'), { recursive: true });
  await writeFile(join(ws, '.git', 'config'), '[core]\n');
  process.env.AGENT_TEST_TOKEN = 'not-for-the-container';
  const runner = await createCommandRunner({
    choice: real.info.runtime,
    image: real.image,
    network: false,
    workspace: ws,
    dataDir: join(dir, 'data'),
    passEnv: [],
    confirm: async () => false,
    notify: () => undefined,
  });
  try {
    const run = (command: string, timeoutMs = 60_000) => runner.run(command, { timeoutMs });
    assert.equal((await run('echo hello && pwd')).output, 'hello\n/workspace\n');
    assert.notEqual((await run('touch /outside.txt')).exitCode, 0, 'the root filesystem is read-only');
    assert.notEqual((await run('touch /etc/outside.txt')).exitCode, 0);
    assert.notEqual((await run('echo x >> .git/config')).exitCode, 0, '.git is read-only');
    assert.notEqual((await run('getent hosts example.com || node -e "fetch(\'http://1.1.1.1\').then(() => process.exit(0), () => process.exit(1))"')).exitCode, 0, 'no network');
    assert.doesNotMatch((await run('env')).output, /AGENT_TEST_TOKEN/);
    assert.equal((await run('echo made > made.txt')).exitCode, 0);
    if (process.platform === 'linux') assert.equal((await stat(join(ws, 'made.txt'))).uid, process.getuid?.());
    const slow = await run('echo $$ > inner.pid; exec sleep 300', 1_500);
    assert.equal(slow.timedOut, true);
    assert.notEqual((await run('kill -0 "$(cat inner.pid)"')).exitCode, 0, 'the command is dead inside the container');
  } finally {
    delete process.env.AGENT_TEST_TOKEN;
    await runner.close();
    const left = await execRuntime(real.info.binary, ['ps', '--all', '--quiet', '--filter', `name=${(runner as ContainerRunner).name}`]);
    assert.equal(left.stdout.trim(), '', 'the container is removed');
    await rm(dir, { recursive: true, force: true });
  }
});

// The wrapper and the kill script run in the container's /bin/sh: a POSIX shell here runs them the same way.
const hasSetsid = (() => {
  try {
    return execFileSync('sh', ['-c', 'command -v setsid >/dev/null && setsid -w true && echo yes']).toString().trim() === 'yes';
  } catch {
    return false;
  }
})();

for (const mode of ['setsid', 'plain'] as const) {
  test(`the exec wrapper and the kill script work in a POSIX shell (${mode})`, { skip: (process.platform === 'win32' || (mode === 'setsid' && !hasSetsid)) && 'needs sh (and setsid -w)' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-wrapper-'));
    const run = `test-${process.pid}-${mode}`;
    const child = `"${process.execPath}" -e "setInterval(() => {}, 1000)" & echo $! > child.pid; wait`;
    const wrapped = execArgs('unused', run, child, mode === 'setsid').slice(4);
    assert.equal(wrapped[0], 'sh');
    const shell = spawn('sh', wrapped.slice(1), { cwd: dir, stdio: 'ignore' });
    const exited = new Promise((done) => shell.once('exit', done));
    let leftover = 0;
    try {
      const pidFile = wrapped[4] ?? '';
      for (let i = 0; i < 50 && !(existsSync(pidFile) && existsSync(join(dir, 'child.pid'))); i += 1) await new Promise((done) => setTimeout(done, 50));
      const group = Number(readFileSync(pidFile, 'utf8'));
      leftover = Number(readFileSync(join(dir, 'child.pid'), 'utf8'));
      assert.ok(group > 1 && leftover > 1);
      const kill = killArgs('unused', run).slice(2);
      const killed = execFileSync(kill[0] ?? 'sh', kill.slice(1), { stdio: 'pipe' });
      assert.equal(killed.toString(), '');
      await exited;
      for (let i = 0; i < 50 && processAlive(leftover); i += 1) await new Promise((done) => setTimeout(done, 50));
      // Plain mode kills only the shell: there the runner restarts the container.
      if (mode === 'setsid') assert.ok(!processAlive(leftover), 'the whole group is dead');
      assert.ok(!existsSync(pidFile));
    } finally {
      shell.kill('SIGKILL');
      if (leftover > 1 && processAlive(leftover)) process.kill(leftover, 'SIGKILL');
      await rm(dir, { recursive: true, force: true });
    }
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return process.platform !== 'linux';
  }
}
