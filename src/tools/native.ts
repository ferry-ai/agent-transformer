import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { runCommand } from './shell.js';
import { ToolError, type ApprovalSpec, type Tool } from './types.js';

export interface NativeToolsOptions {
  /** The workspace: file tools cannot reach outside it, commands start in it. */
  root: string;
  /** Ask before writing or editing files too, not only before commands. */
  confirmWrites?: boolean;
  /** Default and longest time a command may run. */
  commandTimeoutMs?: number;
  maxCommandTimeoutMs?: number;
}

const READ_LIMIT_LINES = 2_000;
const LIST_LIMIT = 500;
const MAX_DEPTH = 5;
/** Shown in listings but not descended into. */
const SKIPPED_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__', 'dist']);

/** File and shell tools confined to one workspace folder. */
export function nativeTools(options: NativeToolsOptions): Tool[] {
  const root = resolve(options.root);
  const where = (path: string): Promise<string> => insideWorkspace(root, path);
  const show = (path: string): string => relative(root, path).split(sep).join('/') || '.';
  const writeApproval = (spec: ApprovalSpec): ApprovalSpec | undefined => (options.confirmWrites ? spec : undefined);
  const timeout = options.commandTimeoutMs ?? 120_000;
  const maxTimeout = options.maxCommandTimeoutMs ?? 600_000;

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
    async run(args) {
      const path = await where(String(args.path));
      const data = await readFile(path).catch((error: unknown) => fail(error, show(path)));
      if (data.includes(0)) throw new ToolError(`${show(path)} looks like a binary file.`);
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
    approval: (args) =>
      writeApproval({ summary: `write ${String(args.path)} (${String(args.content).length} characters)`, detail: String(args.content) }),
    async run(args) {
      const path = await where(String(args.path));
      const content = String(args.content);
      const existed = await stat(path).then(
        (info) => {
          if (info.isDirectory()) throw new ToolError(`${show(path)} is a folder.`);
          return true;
        },
        () => false,
      );
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
      const lines = content === '' ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
      return { ok: true, text: `${existed ? 'Overwrote' : 'Created'} ${show(path)} (${lines} lines).` };
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
    approval: (args) => writeApproval({ summary: `edit ${String(args.path)}`, detail: String(args.edits) }),
    async run(args) {
      const path = await where(String(args.path));
      const original = await readFile(path, 'utf8').catch((error: unknown) => fail(error, show(path)));
      // The model writes \n; a Windows file keeps its \r\n.
      const eol = (text: string): string => (original.includes('\r\n') ? text.replace(/\r?\n/g, '\r\n') : text);
      const edits = parseEdits(String(args.edits)).map((edit) => ({ search: eol(edit.search), replace: eol(edit.replace) }));
      let content = original;
      for (const [i, edit] of edits.entries()) {
        const count = occurrences(content, edit.search);
        const label = edits.length > 1 ? `Block ${i + 1}: ` : '';
        if (count === 0) {
          throw new ToolError(
            `${label}the SEARCH text is not in ${show(path)}. Nothing was changed. Read the file again and copy the text exactly.`,
          );
        }
        if (count > 1) {
          throw new ToolError(
            `${label}the SEARCH text appears ${count} times in ${show(path)}. Nothing was changed. Add lines around it to make it unique.`,
          );
        }
        content = content.replace(edit.search, () => edit.replace);
      }
      await writeFile(path, content);
      return { ok: true, text: `Edited ${show(path)}: ${edits.length} change${edits.length === 1 ? '' : 's'}.` };
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
      const path = await where(String(args.path ?? '.'));
      const depth = Math.min(MAX_DEPTH, Math.max(1, Number(args.depth ?? 1)));
      const info = await stat(path).catch((error: unknown) => fail(error, show(path)));
      if (!info.isDirectory()) throw new ToolError(`${show(path)} is not a folder.`);
      const entries: string[] = [];
      const truncated = await listInto(path, '', depth, entries);
      if (entries.length === 0) return { ok: true, text: `${show(path)} is empty.` };
      const note = truncated ? `\n[stopped at ${LIST_LIMIT} entries: list a sub-folder or lower the depth]` : '';
      return { ok: true, text: entries.join('\n') + note };
    },
  };

  const runCommandTool: Tool = {
    name: 'run_command',
    description:
      'Runs a shell command in the workspace and returns its output and exit code. The user approves every command. ' +
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
    approval: (args) => ({ summary: `run a command in ${root}`, detail: String(args.command).trimEnd() }),
    async run(args, context) {
      const seconds = Number(args.timeout_sec ?? timeout / 1000);
      const result = await runCommand(String(args.command), {
        cwd: root,
        timeoutMs: Math.min(maxTimeout, Math.max(1, seconds) * 1000),
        signal: context.signal,
      });
      const status = result.timedOut
        ? `stopped after ${Math.round(result.durationMs / 1000)}s (timeout)`
        : result.signal
          ? `killed by ${result.signal}`
          : `exit code ${result.exitCode}`;
      const output = result.output.trimEnd();
      return { ok: result.exitCode === 0 && !result.timedOut, text: `[${status}]${output === '' ? '' : `\n${output}`}` };
    },
  };

  return [readFileTool, writeFileTool, editFileTool, listDirTool, runCommandTool];
}

/**
 * Resolves a path given by the model and refuses anything outside the workspace,
 * symbolic links included.
 */
export async function insideWorkspace(root: string, path: string): Promise<string> {
  if (path.trim() === '') throw new ToolError('The path is empty.');
  const target = resolve(root, path);
  const realRoot = await realpath(root);
  // The deepest part of the path that exists decides where it really points.
  let existing = target;
  let rest = '';
  for (;;) {
    try {
      existing = await realpath(existing);
      break;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) break;
      rest = rest === '' ? relative(parent, existing) : join(relative(parent, existing), rest);
      existing = parent;
    }
  }
  const real = rest === '' ? existing : join(existing, rest);
  const inside = relative(realRoot, real);
  if (inside.startsWith('..') || isAbsolute(inside)) {
    throw new ToolError(`${path} is outside the workspace (${root}). Use paths inside it.`);
  }
  return target;
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

/** Fills entries depth-first; returns true when the listing was cut at LIST_LIMIT. */
async function listInto(dir: string, prefix: string, depth: number, entries: string[]): Promise<boolean> {
  const children = await readdir(dir, { withFileTypes: true });
  children.sort((a, b) => a.name.localeCompare(b.name));
  for (const child of children) {
    if (entries.length >= LIST_LIMIT) return true;
    const isDir = child.isDirectory();
    entries.push(`${prefix}${child.name}${isDir ? '/' : ''}`);
    if (isDir && depth > 1 && !SKIPPED_DIRS.has(child.name)) {
      if (await listInto(join(dir, child.name), `${prefix}${child.name}/`, depth - 1, entries)) return true;
    }
  }
  return false;
}

function fail(error: unknown, path: string): never {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') throw new ToolError(`${path} does not exist.`);
  if (code === 'EISDIR') throw new ToolError(`${path} is a folder: use list_dir.`);
  if (code === 'EACCES' || code === 'EPERM') throw new ToolError(`No permission to read ${path}.`);
  throw error;
}
