import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { foldName } from './paths.js';

export interface WorkspaceCheckOptions {
  dataDir: string;
  /** Default: the user's home folder. */
  home?: string;
  /** Default: this machine's. Windows and macOS compare paths ignoring case. */
  platform?: NodeJS.Platform;
}

/**
 * Refuses a workspace that would hand the agent far more than a project: the
 * filesystem root, the home folder or a folder that contains it (SSH keys, cloud
 * credentials, browser profiles), or the agent's own data dir. Returns the warnings
 * to show at startup.
 */
export async function checkWorkspace(workspace: string, options: WorkspaceCheckOptions): Promise<string[]> {
  const real = await realpath(workspace).catch(() => undefined);
  if (real === undefined || !(await stat(real)).isDirectory()) throw new Error(`The workspace is not a folder: ${workspace}`);
  const insensitive = ['win32', 'darwin'].includes(options.platform ?? process.platform);
  const home = await realOrResolved(options.home ?? homedir());
  const dataDir = await realOrResolved(options.dataDir);

  if (parse(real).root === real) {
    throw new Error(`The workspace is the root of the file system (${real}). Choose a project folder with --workspace.`);
  }
  if (contains(real, home, insensitive)) {
    const what = sameDir(real, home, insensitive) ? 'your home folder' : `a folder that contains your home folder (${home})`;
    throw new Error(`The workspace is ${what}: the agent could read your keys and credentials. Choose a project folder with --workspace.`);
  }
  if (contains(dataDir, real, insensitive)) {
    throw new Error(
      `The workspace (${real}) is inside the agent's data folder (${dataDir}), which holds the browser profile and the session logs. Choose another folder.`,
    );
  }
  const warnings: string[] = [];
  if (contains(real, dataDir, insensitive)) {
    warnings.push(
      `The data folder (${dataDir}) is inside the workspace. The file tools and the sandbox keep it out of reach, ` +
        'but a command run on the host can still read it: prefer a data folder outside the workspace (--data-dir).',
    );
  }
  return warnings;
}

async function realOrResolved(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

/** Whether child is parent itself or inside it. */
function contains(parent: string, child: string, insensitive: boolean): boolean {
  if (insensitive) {
    const a = parent.split(/[\\/]+/).filter(Boolean).map(foldName);
    const b = child.split(/[\\/]+/).filter(Boolean).map(foldName);
    return a.length <= b.length && a.every((part, i) => part === b[i]);
  }
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function sameDir(a: string, b: string, insensitive: boolean): boolean {
  return contains(a, b, insensitive) && contains(b, a, insensitive);
}
