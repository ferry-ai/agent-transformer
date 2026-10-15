import { homedir } from 'node:os';
import { join } from 'node:path';

export const APP_NAME = 'Agent-Transformer';

/**
 * Where browser profiles and session logs live. It is outside the repo and outside
 * synced folders, because a profile holds the cookies of a logged-in account.
 */
export function defaultDataDir(): string {
  const home = homedir();
  switch (process.platform) {
    case 'win32':
      return join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), APP_NAME);
    case 'darwin':
      return join(home, 'Library', 'Application Support', APP_NAME);
    default:
      return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'agent-transformer');
  }
}
