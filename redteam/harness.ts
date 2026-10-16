/**
 * Shared pieces of the red-team runners (run.test.ts, container.test.ts): what a
 * scenario script asks for, what a run left on disk, and what reached the model.
 *
 * Every check is on effects: folders compared entry by entry, content hash and all,
 * before and after a run; sentinel strings searched in everything the agent saved;
 * commands caught by stand-ins placed first on PATH. Nothing here reads the agent's
 * console output: it is kept only to explain a failure.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REDTEAM = join(REPO, 'redteam');
const TSX_CLI = join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const AGENT_CLI = join(REPO, 'src', 'cli.ts');

export const windows = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Scenario scripts

export interface ScriptCall {
  /** The reply the call is in, from 1. */
  reply: number;
  tool: string;
  args: Record<string, unknown>;
  body?: string;
}

export interface Script {
  replies: string[];
  calls: ScriptCall[];
}

/**
 * A replay script and its tool calls, read the way the corpus writes them: a ```tool
 * line, a JSON line with the name and arguments, the body, a closing ``` line.
 */
export async function readScript(file: string): Promise<Script> {
  const data: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(data) || !data.every((reply) => typeof reply === 'string')) {
    throw new Error(`${file}: expected a JSON list of reply strings.`);
  }
  const replies = data as string[];
  const calls: ScriptCall[] = [];
  replies.forEach((reply, i) => {
    const lines = reply.split('\n');
    for (let at = 0; at < lines.length; at += 1) {
      if (!/^```tool\s*$/.test(lines[at] ?? '')) continue;
      const end = lines.findIndex((line, j) => j > at && /^```\s*$/.test(line));
      if (end < 0) throw new Error(`${file}, reply ${i + 1}: a tool block is not closed.`);
      const [header = '', ...rest] = lines.slice(at + 1, end);
      const parsed = JSON.parse(header) as { tool: string; args?: Record<string, unknown> };
      const call: ScriptCall = { reply: i + 1, tool: parsed.tool, args: parsed.args ?? {} };
      if (rest.length > 0) call.body = `${rest.join('\n')}\n`;
      calls.push(call);
      at = end;
    }
  });
  return { replies, calls };
}

/** The command line run_command gets for a call, as its approval prompt shows it. */
export function commandOf(call: ScriptCall): string {
  return String(call.args.command ?? call.body ?? '').replace(/\n+$/, '');
}

// ---------------------------------------------------------------------------
// What reached the model: the session transcripts in the data dir

export interface RecordedCall {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  output: string;
  /** Stopped by the agent loop before it reached the toolbox. */
  gated: boolean;
}

export interface Recorded {
  /** Session folders that hold a transcript. */
  sessions: string[];
  /** Messages exchanged with the model. */
  turns: number;
  calls: RecordedCall[];
}

/** Reads every sessions/<id>/transcript.jsonl of a data dir. */
export async function readTranscripts(dataDir: string): Promise<Recorded> {
  const recorded: Recorded = { sessions: [], turns: 0, calls: [] };
  const sessions = join(dataDir, 'sessions');
  const folders = await readdir(sessions, { withFileTypes: true }).catch(() => []);
  for (const folder of folders.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
    const text = await readFile(join(sessions, folder, 'transcript.jsonl'), 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    recorded.sessions.push(folder);
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (typeof entry.turn === 'number') recorded.turns += 1;
      if (entry.event === 'tool_call') {
        recorded.calls.push({
          tool: String(entry.tool),
          args: (entry.args ?? {}) as Record<string, unknown>,
          ok: entry.ok === true,
          output: String(entry.output ?? ''),
          gated: entry.gated === true,
        });
      }
    }
  }
  return recorded;
}

// ---------------------------------------------------------------------------
// What a run left on disk

export interface Entry {
  type: 'file' | 'dir' | 'link' | 'other';
  /** Permission bits. */
  mode: number;
  size?: number;
  sha256?: string;
  mtimeMs?: number;
  /** Hard links of a file. */
  nlink?: number;
  /** Where a symbolic link (or a Windows junction) points. */
  target?: string;
}

export type Snapshot = Map<string, Entry>;

/** Every entry under a folder, by "/"-separated path relative to it. Links are recorded, never followed. */
export async function snapshot(root: string): Promise<Snapshot> {
  const entries: Snapshot = new Map();
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name);
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      const info = await lstat(path);
      const mode = info.mode & 0o7777;
      if (info.isSymbolicLink()) entries.set(rel, { type: 'link', mode, target: await readlink(path) });
      else if (info.isDirectory()) {
        entries.set(rel, { type: 'dir', mode });
        await walk(path, rel);
      } else if (info.isFile()) {
        const sha256 = createHash('sha256').update(await readFile(path)).digest('hex');
        entries.set(rel, { type: 'file', mode, size: info.size, sha256, mtimeMs: info.mtimeMs, nlink: info.nlink });
      } else entries.set(rel, { type: 'other', mode });
    }
  };
  await walk(root, '');
  return entries;
}

export interface Change {
  path: string;
  change: 'created' | 'deleted' | 'changed';
  before?: Entry;
  after?: Entry;
}

export function compare(before: Snapshot, after: Snapshot): Change[] {
  const changes: Change[] = [];
  for (const [path, entry] of before) {
    const now = after.get(path);
    if (now === undefined) changes.push({ path, change: 'deleted', before: entry });
    else if (!sameEntry(entry, now)) changes.push({ path, change: 'changed', before: entry, after: now });
  }
  for (const [path, entry] of after) if (!before.has(path)) changes.push({ path, change: 'created', after: entry });
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function sameEntry(a: Entry, b: Entry): boolean {
  const keys: (keyof Entry)[] = ['type', 'mode', 'size', 'sha256', 'mtimeMs', 'nlink', 'target'];
  return keys.every((key) => a[key] === b[key]);
}

/** One line per change, for assertion messages. */
export function describeChanges(changes: Change[]): string {
  return changes.map((change) => `  ${change.change} ${JSON.stringify(change.path)} ${JSON.stringify(change.after ?? change.before)}`).join('\n');
}

/** The changes under a "/"-separated prefix, with paths made relative to it. */
export function under(changes: Change[], prefix: string): Change[] {
  return changes
    .filter((change) => change.path === prefix || change.path.startsWith(`${prefix}/`))
    .map((change) => ({ ...change, path: change.path === prefix ? '' : change.path.slice(prefix.length + 1) }));
}

/** The state of a path outside the folders a run is compared on: undefined when nothing is there. */
export async function probe(path: string): Promise<string | undefined> {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined) return undefined;
  if (!info.isFile()) return `${info.isDirectory() ? 'dir' : 'other'} ${info.mtimeMs}`;
  const content = await readFile(path).catch(() => Buffer.alloc(0));
  return `file ${info.size} ${info.mtimeMs} ${createHash('sha256').update(content).digest('hex')}`;
}

// ---------------------------------------------------------------------------
// Sentinels: unique strings planted in what must never reach the model

export function sentinel(label: string): string {
  return `RTSENTINEL-${label}-${randomBytes(8).toString('hex')}`;
}

export interface Finding {
  file: string;
  needle: string;
}

/**
 * Searches every regular file under a folder for each needle, byte for byte. skip
 * leaves out a "/"-separated relative path (and, for a folder, all it holds).
 */
export async function findNeedles(root: string, needles: readonly string[], skip: (rel: string) => boolean = () => false): Promise<Finding[]> {
  const found: Finding[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (skip(rel)) continue;
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
      else if (entry.isFile()) {
        const data = await readFile(join(dir, entry.name));
        for (const needle of needles) if (data.includes(Buffer.from(needle, 'utf8'))) found.push({ file: rel, needle });
      }
    }
  };
  await walk(root, '');
  return found;
}

// ---------------------------------------------------------------------------
// Canaries: stand-ins for common commands, first on PATH. A command that runs one
// leaves a line in the hits file. No command may run in an unattended pass.

export const CANARY_COMMANDS = ['touch', 'whoami', 'env', 'printenv', 'nohup', 'sleep', 'id'] as const;

export interface Canary {
  bin: string;
  hits: string;
}

export async function plantCanaries(dir: string): Promise<Canary> {
  const bin = join(dir, 'bin');
  const hits = join(dir, 'hits.log');
  await mkdir(bin, { recursive: true });
  for (const name of CANARY_COMMANDS) {
    if (windows) await writeFile(join(bin, `${name}.cmd`), `@echo off\r\necho ${name}>>"${hits}"\r\nexit /b 0\r\n`);
    else await writeFile(join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${hits}'\n`, { mode: 0o755 });
  }
  return { bin, hits };
}

/** The canary lines written so far. */
export async function canaryHits(canary: Canary): Promise<string[]> {
  const text = await readFile(canary.hits, 'utf8').catch(() => '');
  return text.split(/\r?\n/).filter((line) => line.trim() !== '');
}

export async function clearCanaryHits(canary: Canary): Promise<void> {
  await rm(canary.hits, { force: true });
}

/** The name PATH has in an environment: "Path" on Windows, usually. */
function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
}

/** A copy of env with dir first on PATH. */
export function withFirstOnPath(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const copy = { ...env };
  const key = pathKey(copy);
  copy[key] = [dir, copy[key]].filter(Boolean).join(delimiter);
  return copy;
}

// ---------------------------------------------------------------------------
// Processes

/** The command lines of every process on this machine. */
export function processCommandLines(): string[] {
  const listed = windows
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 120_000,
      })
    : spawnSync('ps', ['-A', '-o', 'args='], { encoding: 'utf8', timeout: 60_000 });
  if (listed.status !== 0) throw new Error(`Listing the processes failed: ${listed.error?.message ?? listed.stderr}`);
  return listed.stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
}

// ---------------------------------------------------------------------------
// The real CLI

export interface CliRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** stdout and stderr, for failure messages only. */
  output: string;
}

/**
 * Runs src/cli.ts with tsx, its stdin an empty pipe that is closed at once (as with
 * `printf '' |`): there is no terminal, so the agent denies every approval.
 */
export function runCli(args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, AGENT_CLI, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group, so a timeout takes tsx's child and anything it started too.
      detached: !windows,
      windowsHide: true,
    });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stdin?.end();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, options.timeoutMs ?? 120_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, output });
    });
  });
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (windows) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

/** The last lines of a run's output, for an assertion message. */
export function tail(text: string, lines = 40): string {
  return text.split('\n').slice(-lines).join('\n');
}

/** Runs tsx on a script of ours (probe-env.ts), with no shell in between. */
export function runTsx(file: string, args: readonly string[], env: NodeJS.ProcessEnv): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [TSX_CLI, file, ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}
