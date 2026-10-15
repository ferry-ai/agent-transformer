import type { FileHandle } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { dangerHints } from './hints.js';
import { redactSecrets } from './redact.js';
import { hardLinkReason, MAX_FILE_BYTES, PathPolicy, type CheckedPath } from './paths.js';
import { HostRunner, type CommandRunner } from './shell.js';
import { ToolError, type Tool, type ToolContext } from './types.js';

export interface NativeToolsOptions {
  /** The workspace: file tools cannot reach outside it, commands start in it. */
  root: string;
  /** The agent's data folder: off limits even when it lies inside the workspace. */
  dataDir?: string;
  /** Ask before writing or editing files too, not only before commands. */
  confirmWrites?: boolean;
  /** Where commands run. Default: the host, with passEnv. */
  runner?: CommandRunner;
  /** Environment variables host commands get on top of the basics (--pass-env). */
  passEnv?: readonly string[];
  /** Default and longest time a command may run. */
  commandTimeoutMs?: number;
  maxCommandTimeoutMs?: number;
}

const READ_LIMIT_LINES = 2_000;
const LIST_LIMIT = 500;
const MAX_DEPTH = 5;
/** Shown in listings but not descended into. */
const SKIPPED_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__', 'dist']);

/** File and shell tools confined to one workspace folder. Every path goes through the PathPolicy. */
export function nativeTools(options: NativeToolsOptions): Tool[] {
  const root = resolve(options.root);
  const policy = new PathPolicy({ root, dataDir: options.dataDir });
  const runner = options.runner ?? new HostRunner({ root, passEnv: options.passEnv });
  const timeout = options.commandTimeoutMs ?? 120_000;
  const maxTimeout = options.maxCommandTimeoutMs ?? 600_000;

  /** Asks when the policy has reasons (or always, with --confirm-writes); returns the reasons asked about. */
  const confirm = async (
    context: ToolContext,
    checked: CheckedPath,
    summary: string,
    detail?: string,
    always = false,
  ): Promise<string[]> => {
    if (checked.reasons.length === 0 && !always) return [];
    await context.confirm({ summary, detail, warnings: checked.reasons });
    return checked.reasons;
  };
  /** A hard link that appeared after the question was asked: refuse rather than write through it. */
  const refuseNewHardLink = async (handle: FileHandle, checked: CheckedPath, asked: string[]): Promise<void> => {
    const { nlink } = await handle.stat({ bigint: true });
    if (nlink > 1n && !asked.includes(hardLinkReason(checked.display, nlink))) {
      throw new ToolError(`${checked.display} has ${nlink} hard links now. Nothing was written; try again.`);
    }
  };

  const readFileTool: Tool = {
    name: 'read_file',
    description: `Reads a text file. Long files come in slices of ${READ_LIMIT_LINES} lines: use offset to go on.`,
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the workspace.' },
        offset: { type: 'integer', description: 'First line to read, from 1. Default 1.' },
        limit: { type: 'integer', description: `How many lines to read. Default ${READ_LIMIT_LINES}.` },
      },
      required: ['path'],
    },
    async run(args, context) {
      const checked = await policy.check(String(args.path), 'read');
      await confirm(context, checked, `read ${checked.display}`);
      const data = await readChecked(policy, checked, 'read');
      if (data.includes(0)) throw new ToolError(`${checked.display} looks like a binary file.`);
      const text = data.toString('utf8');
      const lines = text.replace(/\n$/, '').split('\n');
      const offset = Math.max(1, Number(args.offset ?? 1));
      const limit = Math.max(1, Number(args.limit ?? READ_LIMIT_LINES));
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const last = offset - 1 + slice.length;
      if (offset === 1 && last >= lines.length) return { ok: true, text };
      const more = last < lines.length ? ` Next: offset ${last + 1}.` : '';
      return { ok: true, text: `[lines ${offset}-${last} of ${lines.length}.${more}]\n${slice.join('\n')}` };
    },
  };

  const writeFileTool: Tool = {
    name: 'write_file',
    description: 'Creates or overwrites a file with the given content. Missing folders are created.',
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the workspace.' },
        content: { type: 'string', description: 'The whole new content of the file.' },
      },
      required: ['path', 'content'],
    },
    body: 'content',
    mutates: true,
    async run(args, context) {
      const content = String(args.content);
      const checked = await policy.check(String(args.path), 'write');
      if (checked.info?.isDirectory()) throw new ToolError(`${checked.display} is a folder.`);
      const summary = `write ${checked.display} (${content.length} characters)`;
      const asked = await confirm(context, checked, summary, content, options.confirmWrites === true);
      await policy.makeParents(checked);
      const handle = await policy.open(checked, 'write').catch((error: unknown) => fail(error, checked.display));
      try {
        await refuseNewHardLink(handle, checked, asked);
        await handle.truncate(0);
        await handle.writeFile(content);
      } finally {
        await handle.close();
      }
      const lines = content === '' ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
      return { ok: true, text: `${checked.info ? 'Overwrote' : 'Created'} ${checked.display} (${lines} lines).` };
    },
  };

  const editFileTool: Tool = {
    name: 'edit_file',
    description:
      'Replaces exact text in a file. After the JSON line, write one or more blocks:\n' +
      '<<<<<<< SEARCH\n(exact current text)\n=======\n(new text)\n>>>>>>> REPLACE\n' +
      'Each SEARCH text must appear exactly once in the file: include enough lines to make it unique.',
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the workspace.' },
        edits: { type: 'string', description: 'The SEARCH/REPLACE blocks.' },
      },
      required: ['path', 'edits'],
    },
    body: 'edits',
    mutates: true,
    async run(args, context) {
      const checked = await policy.check(String(args.path), 'edit');
      if (checked.info === undefined) throw new ToolError(`${checked.display} does not exist.`);
      // Asked before reading: on a secret, whether a SEARCH text matches already tells something.
      const asked = await confirm(context, checked, `edit ${checked.display}`, String(args.edits), options.confirmWrites === true);
      const handle = await policy.open(checked, 'edit').catch((error: unknown) => fail(error, checked.display));
      try {
        await refuseNewHardLink(handle, checked, asked);
        const original = (await readHandle(handle, checked)).toString('utf8');
        // The model writes \n; a Windows file keeps its \r\n.
        const eol = (text: string): string => (original.includes('\r\n') ? text.replace(/\r?\n/g, '\r\n') : text);
        const edits = parseEdits(String(args.edits)).map((edit) => ({ search: eol(edit.search), replace: eol(edit.replace) }));
        let content = original;
        for (const [i, edit] of edits.entries()) {
          const count = occurrences(content, edit.search);
          const label = edits.length > 1 ? `Block ${i + 1}: ` : '';
          if (count === 0) {
            throw new ToolError(
              `${label}the SEARCH text is not in ${checked.display}. Nothing was changed. Read the file again and copy the text exactly.`,
            );
          }
          if (count > 1) {
            throw new ToolError(
              `${label}the SEARCH text appears ${count} times in ${checked.display}. Nothing was changed. Add lines around it to make it unique.`,
            );
          }
          content = content.replace(edit.search, () => edit.replace);
        }
        await handle.truncate(0);
        await writeAt(handle, Buffer.from(content, 'utf8'));
        return { ok: true, text: `Edited ${checked.display}: ${edits.length} change${edits.length === 1 ? '' : 's'}.` };
      } finally {
        await handle.close();
      }
    },
  };

  const listDirTool: Tool = {
    name: 'list_dir',
    description: `Lists a folder; sub-folders end with "/". ${[...SKIPPED_DIRS].join(', ')} are listed but not opened.`,
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Folder path, relative to the workspace. Default ".".' },
        depth: { type: 'integer', description: `How many levels to go down, 1 to ${MAX_DEPTH}. Default 1.` },
      },
    },
    async run(args) {
      const checked = await policy.check(String(args.path ?? '.'), 'list');
      const depth = Math.min(MAX_DEPTH, Math.max(1, Number(args.depth ?? 1)));
      if (checked.info === undefined) throw new ToolError(`${checked.display} does not exist.`);
      if (!checked.info.isDirectory()) throw new ToolError(`${checked.display} is not a folder.`);
      const entries: string[] = [];
      const truncated = await listInto(policy, checked.real, '', depth, entries);
      if (entries.length === 0) return { ok: true, text: `${checked.display} is empty.` };
      const note = truncated ? `\n[stopped at ${LIST_LIMIT} entries: list a sub-folder or lower the depth]` : '';
      return { ok: true, text: entries.join('\n') + note };
    },
  };

  const runCommandTool: Tool = {
    name: 'run_command',
    description:
      `Runs a shell command and returns its output and exit code. ${runner.note} The user approves every command. ` +
      'No input can be typed: use non-interactive flags.',
    params: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line (several lines run as a script).' },
        timeout_sec: {
          type: 'integer',
          description: `Seconds before the command is stopped. Default ${timeout / 1000}, at most ${maxTimeout / 1000}.`,
        },
      },
      required: ['command'],
    },
    body: 'command',
    // The exact command: only the final newlines the protocol adds are left out (trimEnd() would hide invisible characters too).
    approval: (args) => ({
      summary: `run a command in ${runner.cwd}`,
      detail: String(args.command).replace(/\n+$/, ''),
      where: runner.where,
      // Hints are a pattern match, easy to get around: they point the user's attention, nothing more.
      warnings: [...runner.warnings, ...dangerHints(String(args.command)).map((hint) => `hint: ${hint}`)],
    }),
    async run(args, context) {
      const seconds = Number(args.timeout_sec ?? timeout / 1000);
      const run: { timeoutMs: number; signal?: AbortSignal } = { timeoutMs: Math.min(maxTimeout, Math.max(1, seconds) * 1000) };
      if (context.signal) run.signal = context.signal;
      const result = await runner.run(String(args.command), run);
      const status = result.timedOut
        ? `stopped after ${Math.round(result.durationMs / 1000)}s (timeout)`
        : result.signal
          ? `killed by ${result.signal}`
          : `exit code ${result.exitCode}`;
      // A stray "cat .env" or "env": obvious secrets are masked before the output reaches the chat.
      const output = redactSecrets(result.output.trimEnd()).text;
      return { ok: result.exitCode === 0 && !result.timedOut, text: `[${status}]${output === '' ? '' : `\n${output}`}` };
    },
  };

  return [readFileTool, writeFileTool, editFileTool, listDirTool, runCommandTool];
}

async function readChecked(policy: PathPolicy, checked: CheckedPath, mode: 'read'): Promise<Buffer> {
  const handle = await policy.open(checked, mode).catch((error: unknown) => fail(error, checked.display));
  try {
    return await readHandle(handle, checked);
  } finally {
    await handle.close();
  }
}

async function readHandle(handle: FileHandle, checked: CheckedPath): Promise<Buffer> {
  const { size } = await handle.stat();
  if (size > MAX_FILE_BYTES) {
    throw new ToolError(`${checked.display} is ${Math.round(size / 1024 / 1024)} MB: too large to read (limit ${MAX_FILE_BYTES / 1024 / 1024} MB).`);
  }
  return handle.readFile();
}

/** Writes all of data from the start of the file, whatever the handle's position after a read. */
async function writeAt(handle: FileHandle, data: Buffer): Promise<void> {
  for (let done = 0; done < data.length; ) {
    const { bytesWritten } = await handle.write(data, done, data.length - done, done);
    done += bytesWritten;
  }
}

interface Edit {
  search: string;
  replace: string;
}

function parseEdits(text: string): Edit[] {
  const pattern = /^<{5,9} ?SEARCH[^\n]*\n([\s\S]*?)^={5,9}[ \t]*\n([\s\S]*?)^>{5,9} ?REPLACE[^\n]*$/gm;
  const edits = Array.from(text.matchAll(pattern), (match) => ({
    search: stripFinalNewline(match[1] ?? ''),
    replace: stripFinalNewline(match[2] ?? ''),
  }));
  if (edits.length === 0) {
    throw new ToolError(
      'No SEARCH/REPLACE block found. After the JSON line write:\n<<<<<<< SEARCH\n(exact current text)\n=======\n(new text)\n>>>>>>> REPLACE',
    );
  }
  if (edits.some((edit) => edit.search === '')) throw new ToolError('A SEARCH text is empty: use write_file for new files.');
  return edits;
}

function stripFinalNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

function occurrences(text: string, search: string): number {
  let count = 0;
  for (let at = text.indexOf(search); at >= 0; at = text.indexOf(search, at + 1)) count += 1;
  return count;
}

/** Fills entries depth-first; returns true when the listing was cut at LIST_LIMIT. Never opens .git or the data dir. */
async function listInto(policy: PathPolicy, dir: string, prefix: string, depth: number, entries: string[]): Promise<boolean> {
  const children = await readdir(dir, { withFileTypes: true });
  children.sort((a, b) => a.name.localeCompare(b.name));
  for (const child of children) {
    if (entries.length >= LIST_LIMIT) return true;
    const isDir = child.isDirectory();
    entries.push(`${prefix}${child.name}${isDir ? '/' : ''}`);
    if (isDir && depth > 1 && !SKIPPED_DIRS.has(child.name) && !(await policy.offLimits(join(dir, child.name)))) {
      if (await listInto(policy, join(dir, child.name), `${prefix}${child.name}/`, depth - 1, entries)) return true;
    }
  }
  return false;
}

function fail(error: unknown, path: string): never {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') throw new ToolError(`${path} does not exist.`);
  if (code === 'EISDIR') throw new ToolError(`${path} is a folder: use list_dir.`);
  if (code === 'ENOTDIR') throw new ToolError(`${path}: part of the path is a file, not a folder.`);
  if (code === 'EACCES' || code === 'EPERM') throw new ToolError(`No permission to open ${path}.`);
  throw error;
}
