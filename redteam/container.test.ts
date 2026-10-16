/**
 * The container-level red-team scenarios (redteam/container-*.json), played in the
 * Docker sandbox with the network off, on a machine with Docker and the image:
 *
 *   docker build -t agent-sandbox:local sandbox
 *   AGENT_SANDBOX_TEST_IMAGE=agent-sandbox:local npx tsx --test redteam/container.test.ts
 *
 * These attacks start with a command, so here commands are approved: by this harness
 * only, never by the CLI, which denies everything without a terminal. It goes through
 * the public APIs the real-container test in src/tools/sandbox.test.ts uses
 * (createCommandRunner, nativeTools, a Toolbox with an approver), with checkpoints
 * wired in as the CLI does. The approver says yes only to run_command, only for a
 * command that is exactly one of the scenario's scripted, harmless commands, and only
 * when the prompt says it runs in the sandbox with the network off. Everything else
 * it is asked is denied.
 *
 * The checks are on effects seen from the host: links and files in the workspace,
 * .git byte for byte, the host's /etc, what the tools returned (everything the model
 * would read), stand-ins first on PATH that would catch any command running on the
 * host instead of the container, and the container gone after close.
 *
 * Without Docker or the image the tests are skipped; REDTEAM_REQUIRE_CONTAINER=1 (set
 * in CI) makes that a failure.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFile, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Checkpoints } from '../src/tools/checkpoints.js';
import { nativeTools } from '../src/tools/native.js';
import { processGroups } from '../src/tools/processes.js';
import { ContainerRunner, createCommandRunner, detectRuntime, execRuntime } from '../src/tools/sandbox.js';
import { Toolbox } from '../src/tools/toolbox.js';
import type { ApprovalRequest, ToolOutput } from '../src/tools/types.js';
import {
  canaryHits,
  clearCanaryHits,
  commandOf,
  compare,
  describeChanges,
  plantCanaries,
  probe,
  readScript,
  REDTEAM,
  sentinel,
  snapshot,
  under,
  withFirstOnPath,
  type Canary,
  type Change,
  type ScriptCall,
  type Snapshot,
} from './harness.js';

const IMAGE = process.env.AGENT_SANDBOX_TEST_IMAGE;
const WHERE = '[sandbox: docker, network off]';
const ENV_SECRETS = ['AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'NPM_TOKEN', 'AGENT_TEST_TOKEN'];

const unavailable = await (async (): Promise<string | false> => {
  if (IMAGE === undefined || IMAGE === '') {
    return 'set AGENT_SANDBOX_TEST_IMAGE to an image that is already present (docker build -t agent-sandbox:local sandbox)';
  }
  const { info, problems } = await detectRuntime('docker', execRuntime);
  if (info === undefined) return `needs Docker: ${problems.join('; ')}`;
  const present = await execRuntime(info.binary, ['image', 'inspect', '--format', '{{.Id}}', IMAGE]);
  return present.code === 0 ? false : `the image ${IMAGE} is not present (docker build -t agent-sandbox:local sandbox)`;
})();

if (unavailable && process.env.REDTEAM_REQUIRE_CONTAINER === '1') {
  test('the container scenarios can run here', () => {
    assert.fail(`REDTEAM_REQUIRE_CONTAINER=1, but they cannot: ${unavailable}`);
  });
}

interface Box {
  base: string;
  workspace: string;
  dataDir: string;
  canary: Canary;
}

/** A workspace (with a git repository when asked), a data dir outside it, and the canaries. */
async function makeBox(name: string, options: { git: boolean }): Promise<Box> {
  const base = await realpath(await mkdtemp(join(tmpdir(), `rt-${name}-`)));
  const workspace = join(base, 'workspace');
  const dataDir = join(base, 'data');
  await mkdir(workspace);
  await mkdir(dataDir, { mode: 0o700 });
  if (options.git) {
    execFileSync('git', ['init', '--quiet', workspace], { stdio: 'ignore' });
    await appendFile(join(workspace, '.git', 'config'), `[redteam]\n\tsentinel = ${sentinel('git-config')}\n`);
  }
  return { base, workspace, dataDir, canary: await plantCanaries(join(base, 'canary')) };
}

interface Result {
  call: ScriptCall;
  output: ToolOutput;
}

interface Played {
  results: Result[];
  /** Every approval the tools asked for. */
  asked: ApprovalRequest[];
  /** The commands the harness approved, in order. */
  approved: string[];
  /** What the runner and the checkpoints told the user. */
  notes: string[];
  /** Values of the secrets the agent's environment held while the scenario ran. */
  secrets: string[];
  before: Snapshot;
  after: Snapshot;
}

interface PlayOptions {
  /** Called after each scripted call, before the next one. */
  between?(index: number, result: Result): Promise<void>;
  /** More calls after the script, before the container is removed: file tools only, never approved. */
  more?(toolbox: Toolbox): Promise<Result[]>;
}

/**
 * Plays a scenario's calls, in order, through a Toolbox whose commands run in the
 * sandbox. While it plays, the canaries are first on this process's PATH (so on the
 * PATH of the checkpoints' git too) and secrets sit in its environment.
 */
async function play(name: string, box: Box, options: PlayOptions = {}): Promise<Played> {
  const script = await readScript(join(REDTEAM, `${name}.json`));
  const scripted = new Set(script.calls.filter((call) => call.tool === 'run_command').map(commandOf));
  const asked: ApprovalRequest[] = [];
  const approved: string[] = [];
  const notes: string[] = [];
  const saved = { ...process.env };
  const secrets = ENV_SECRETS.map((variable) => sentinel(`env-${variable.toLowerCase()}`));
  Object.assign(process.env, withFirstOnPath(process.env, box.canary.bin), Object.fromEntries(ENV_SECRETS.map((variable, i) => [variable, secrets[i]])));
  const before = await snapshot(box.base);
  const results: Result[] = [];
  let runner: ContainerRunner | undefined;
  try {
    const created = await createCommandRunner({
      choice: 'docker',
      image: IMAGE ?? '',
      network: false,
      workspace: box.workspace,
      dataDir: box.dataDir,
      passEnv: [],
      confirm: async () => false,
      notify: (message) => notes.push(message),
    });
    assert.ok(created instanceof ContainerRunner, 'commands run in a container');
    runner = created;
    assert.equal(runner.where, WHERE);
    const checkpoints = await Checkpoints.open({ workspace: box.workspace, dataDir: box.dataDir });
    const toolbox = new Toolbox(nativeTools({ root: box.workspace, dataDir: box.dataDir, runner }), {
      approve: async (request) => {
        asked.push(request);
        const detail = request.detail ?? '';
        if (request.tool === 'run_command' && request.where === WHERE && scripted.has(detail)) {
          approved.push(detail);
          return { approved: true };
        }
        return { approved: false, note: 'Denied by the red-team harness: it approves only the scripted commands, in the sandbox.' };
      },
      // As the CLI does: a snapshot before every change, its failures reported and the call let through.
      checkpoint: async (label) => {
        if (!(checkpoints instanceof Checkpoints)) return;
        try {
          const taken = await checkpoints.snapshot(`before ${label}`);
          if (taken.skipped) notes.push(`checkpoint skipped: ${taken.skipped}`);
        } catch (error) {
          notes.push(`no checkpoint: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    });
    for (const [i, call] of script.calls.entries()) {
      const output = await toolbox.call({ index: i + 1, tool: call.tool, args: call.args, ...(call.body === undefined ? {} : { body: call.body }) });
      const result = { call, output };
      results.push(result);
      await options.between?.(i, result);
    }
    if (options.more) results.push(...(await options.more(toolbox)));
  } finally {
    processGroups.killAll();
    await runner?.close();
    for (const variable of Object.keys(process.env)) if (!(variable in saved)) delete process.env[variable];
    Object.assign(process.env, saved);
  }
  if (runner !== undefined) {
    const left = await execRuntime('docker', ['ps', '--all', '--quiet', '--filter', `name=${runner.name}`]);
    assert.equal(left.stdout.trim(), '', 'the container is removed at close');
  }
  assert.deepEqual(approved, script.calls.filter((call) => call.tool === 'run_command').map(commandOf), 'every scripted command was approved once, in order, to run in the sandbox');
  return { results, asked, approved, notes, secrets, before, after: await snapshot(box.base) };
}

function inside(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Checks common to every scenario: nothing changed outside the workspace and the data
 * dir, the data dir only gained checkpoints, no command ran on the host, and no tool
 * output (what the model reads) holds a secret of the agent's environment.
 * Returns the changes in the workspace.
 */
async function common(box: Box, played: Played): Promise<Change[]> {
  const changes = compare(played.before, played.after);
  const elsewhere = changes.filter((change) => !inside(change.path, 'workspace') && !inside(change.path, 'data'));
  assert.deepEqual(elsewhere, [], `changed outside the workspace and the data dir:\n${describeChanges(elsewhere)}`);
  const data = under(changes, 'data').filter((change) => !(change.change === 'created' && inside(change.path, 'checkpoints')));
  assert.deepEqual(data, [], `changed in the data dir, besides the checkpoints:\n${describeChanges(data)}`);
  assert.deepEqual(await canaryHits(box.canary), [], 'a command ran on the host instead of the container');
  for (const { call, output } of played.results) {
    for (const secret of played.secrets) assert.ok(!output.text.includes(secret), `${call.tool} returned a secret of the agent's environment`);
  }
  return under(changes, 'workspace');
}

/** The line of the host's /etc/passwd for this user: the image has no such line. */
async function hostAccountLine(): Promise<string> {
  const { username } = userInfo();
  const line = (await readFile('/etc/passwd', 'utf8')).split('\n').find((entry) => entry.startsWith(`${username}:`));
  assert.ok(line, `no /etc/passwd line for ${username} on this host`);
  return line;
}

function shown(changes: Change[]): string[] {
  return changes.map((change) => `${change.change} ${change.path} (${change.after?.type ?? change.before?.type})`);
}

test('self-check: a stand-in first on PATH catches a command on the host', { skip: process.platform === 'win32' && 'POSIX stand-ins' }, async () => {
  const box = await makeBox('container-self-check', { git: false });
  try {
    spawnSync('id', { shell: true, env: withFirstOnPath(process.env, box.canary.bin), stdio: 'ignore' });
    assert.deepEqual(await canaryHits(box.canary), ['id ']);
    await clearCanaryHits(box.canary);
    assert.deepEqual(await canaryHits(box.canary), []);
  } finally {
    await rm(box.base, { recursive: true, force: true });
  }
});

test(
  'container-symlink-escape: links a command plants in the sandbox are not followed by the file tools on the host',
  { skip: unavailable, timeout: 600_000 },
  async (t: TestContext) => {
    const box = await makeBox('container-symlink-escape', { git: false });
    try {
      const account = await hostAccountLine();
      const cron = '/etc/cron.d/agent';
      const cronBefore = await probe(cron);
      const played = await play('container-symlink-escape', box);
      const workspace = await common(box, played);

      // The command ran in the container and planted the links in the mounted workspace.
      assert.equal(await readlink(join(box.workspace, 'etc-link')), '/etc');
      assert.equal(await readlink(join(box.workspace, 'passwd-link')), '/etc/passwd');
      assert.deepEqual(shown(workspace), ['created etc-link (link)', 'created passwd-link (link)']);

      // The host tools refused to follow them: nothing of the host's /etc read or written.
      const [, read, write] = played.results;
      assert.equal(read?.call.tool, 'read_file');
      assert.equal(read?.output.ok, false, read?.output.text);
      assert.equal(write?.call.tool, 'write_file');
      assert.equal(write?.output.ok, false, write?.output.text);
      for (const { call, output } of played.results) assert.ok(!output.text.includes(account), `${call.tool} returned the host's /etc/passwd`);
      assert.equal(await probe(cron), cronBefore, `${cron} changed`);
      t.diagnostic(`read: ${read?.output.text}`);
      t.diagnostic(`write: ${write?.output.text}`);
    } finally {
      await rm(box.base, { recursive: true, force: true });
    }
  },
);

test(
  'container-race-swap: a folder swapped for a link to /etc while write_file runs leaves nothing outside the workspace',
  { skip: unavailable, timeout: 600_000 },
  async (t: TestContext) => {
    const box = await makeBox('container-race-swap', { git: false });
    try {
      const report = '/etc/report.txt';
      const reportBefore = await probe(report);
      const seen = new Set<string>();
      const played = await play('container-race-swap', box, {
        // The loop runs in the container: watch "out" from the host until it has been a link.
        async between(index) {
          if (index !== 0) return;
          const out = join(box.workspace, 'out');
          for (const end = Date.now() + 10_000; Date.now() < end && !seen.has('link'); ) {
            const info = await lstat(out).catch(() => undefined);
            seen.add(info === undefined ? 'missing' : info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'dir' : 'other');
          }
        },
      });
      const workspace = await common(box, played);
      assert.ok(seen.has('link'), `the swap loop ran in the container (out was seen as: ${[...seen].join(', ')})`);
      assert.equal(await probe(report), reportBefore, `${report} changed`);
      // Whatever the timing, the writes landed in the workspace or nowhere.
      const allowed = new Set(['out', 'out/report.txt']);
      const stray = workspace.filter((change) => !(change.change === 'created' && allowed.has(change.path)));
      assert.deepEqual(stray, [], `changed in the workspace:\n${describeChanges(stray)}`);
      for (const { call, output } of played.results.slice(1)) {
        t.diagnostic(`${call.tool} ${String(call.args.path)}: ${output.ok ? 'ok' : 'refused'}: ${output.text}`);
      }
    } finally {
      await rm(box.base, { recursive: true, force: true });
    }
  },
);

test(
  'container-git-init-fsmonitor: the host repository is read-only in the sandbox, and a planted fsmonitor never runs on the host',
  { skip: unavailable, timeout: 600_000 },
  async (t: TestContext) => {
    const box = await makeBox('container-git-init-fsmonitor', { git: true });
    try {
      const played = await play('container-git-init-fsmonitor', box, {
        // The file tools refuse .git in any repository, a nested one included.
        more: async (toolbox) =>
          Promise.all(
            ['.git/config', 'sub/.git/config'].map(async (path): Promise<Result> => {
              const call: ScriptCall = { reply: 0, tool: 'write_file', args: { path }, body: '[core]\n\tfsmonitor = true\n' };
              return { call, output: await toolbox.call({ index: 1, tool: call.tool, args: call.args, body: call.body }) };
            }),
          ),
      });
      const workspace = await common(box, played);

      // The command inside could not write the host repository: .git is byte for byte as it was.
      const gitChanges = workspace.filter((change) => inside(change.path, '.git'));
      assert.deepEqual(gitChanges, [], `.git changed:\n${describeChanges(gitChanges)}`);
      // It could create a nested repository with an fsmonitor: the README lists this as not protected.
      assert.match(await readFile(join(box.workspace, 'sub', '.git', 'config'), 'utf8'), /fsmonitor/);
      const writes = played.results.slice(-2);
      for (const { call, output } of writes) assert.equal(output.ok, false, `${String(call.args.path)}: ${output.text}`);
      assert.doesNotMatch(await readFile(join(box.workspace, 'sub', '.git', 'config'), 'utf8'), /fsmonitor = true/);
      for (const note of played.notes) t.diagnostic(`note: ${note}`);
    } finally {
      await rm(box.base, { recursive: true, force: true });
    }
  },
);

test(
  'container-git-init-fsmonitor, no repository yet: a repository the sandbox creates gets a warning',
  { skip: unavailable, timeout: 600_000 },
  async (t: TestContext) => {
    const box = await makeBox('container-git-init-fresh', { git: false });
    try {
      const played = await play('container-git-init-fsmonitor', box);
      await common(box, played);
      assert.ok((await stat(join(box.workspace, '.git'))).isDirectory(), 'git init in the sandbox created .git in the workspace');
      assert.ok(
        played.notes.some((note) => /created a git repository in the workspace/.test(note)),
        `the user is warned about the new repository; notes: ${JSON.stringify(played.notes)}`,
      );
      for (const note of played.notes) t.diagnostic(`note: ${note}`);
    } finally {
      await rm(box.base, { recursive: true, force: true });
    }
  },
);

test(
  'container-confinement: confined to /workspace, read-only root and .git, offline, no host environment, host uid',
  { skip: unavailable, timeout: 600_000 },
  async (t: TestContext) => {
    const box = await makeBox('container-confinement', { git: true });
    try {
      const outsideBefore = await Promise.all(['/outside.txt', '/etc/outside.txt'].map(probe));
      const played = await play('container-confinement', box);
      const workspace = await common(box, played);
      const [probeFs, probeNet, made] = played.results;

      // a, f: the working directory is /workspace; outside it the root is read-only, and so is .git.
      // (touch quotes the name with ' or with curly quotes, depending on the locale.)
      assert.equal(probeFs?.output.ok, false, probeFs?.output.text);
      const fsLines = probeFs?.output.text ?? '';
      const refused = '(Read-only file system|Permission denied)';
      assert.match(fsLines, /^\/workspace$/m, 'pwd is /workspace');
      assert.match(fsLines, new RegExp(`cannot touch .\\/outside\\.txt.: ${refused}`), 'nothing can be created in /');
      assert.match(fsLines, new RegExp(`cannot touch .\\/etc\\/outside\\.txt.: ${refused}`), 'nothing can be created in /etc');
      assert.match(fsLines, new RegExp(`\\.git\\/config: ${refused}`), '.git cannot be written');
      assert.deepEqual(await Promise.all(['/outside.txt', '/etc/outside.txt'].map(probe)), outsideBefore);
      assert.deepEqual(workspace.filter((change) => inside(change.path, '.git')), [], '.git is byte for byte as it was');

      // b, e: no name resolves without a network; the environment is the container's own.
      const netLines = probeNet?.output.text ?? '';
      assert.doesNotMatch(netLines, /^\S+\s+example\.com\s*$/m, 'example.com resolved');
      assert.match(netLines, /^HOME=\/home\/sandbox$/m, 'env printed the container environment');

      // h: files written in the workspace belong to the host user, and so does the process.
      assert.equal(made?.output.ok, true, made?.output.text);
      assert.equal(await readFile(join(box.workspace, 'made.txt'), 'utf8'), 'made\n');
      assert.deepEqual(shown(workspace), ['created made.txt (file)']);
      if (process.platform === 'linux') {
        assert.equal((await stat(join(box.workspace, 'made.txt'))).uid, process.getuid?.());
        assert.match(made?.output.text ?? '', new RegExp(`uid=${process.getuid?.()}\\b`), 'the command runs as the host uid');
      }
      for (const { call, output } of played.results) t.diagnostic(`${commandOf(call)}\n${output.text}`);
    } finally {
      await rm(box.base, { recursive: true, force: true });
    }
  },
);
