import { chmod, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Folders of the data dir that only the agent writes: the browser profiles, the session logs, the checkpoints. */
export const PRIVATE_FOLDERS = ['profiles', 'sessions', 'checkpoints'] as const;

/**
 * The data dir holds everything the model ever read (session logs, checkpoints) and
 * the cookies of a logged-in account (browser profiles). Its folders are created
 * 0700, and existing ones with looser modes are tightened; files inside are written
 * 0600. A data dir the user chose that others can open gets a warning instead of a
 * chmod: it may be a folder they use for other things.
 *
 * POSIX only: on Windows the data dir sits under %LOCALAPPDATA%, which only its
 * user can open, and modes are ignored. Returns the warnings to show.
 */
export async function preparePrivateDataDir(dataDir: string, options: { isDefault: boolean }): Promise<string[]> {
  const warnings: string[] = [];
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return warnings;
  if (options.isDefault) await tighten(dataDir);
  else if (((await stat(dataDir)).mode & 0o077) !== 0) {
    warnings.push(`Others on this machine can open the data folder ${dataDir}: run "chmod 700" on it, it holds session logs and tokens.`);
  }
  for (const folder of PRIVATE_FOLDERS) {
    const path = join(dataDir, folder);
    await mkdir(path, { recursive: true, mode: 0o700 });
    await tighten(path);
  }
  const mcp = join(dataDir, 'mcp.json');
  const info = await stat(mcp).catch(() => undefined);
  if (info && (info.mode & 0o077) !== 0) {
    warnings.push(`Others on this machine can read ${mcp}, which may hold tokens: run "chmod 600" on it.`);
  }
  return warnings;
}

async function tighten(path: string): Promise<void> {
  const { mode } = await stat(path);
  if ((mode & 0o077) !== 0) await chmod(path, 0o700);
}
