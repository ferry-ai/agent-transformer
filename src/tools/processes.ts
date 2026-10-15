import { spawnSync } from 'node:child_process';
import { constants } from 'node:os';

const windows = process.platform === 'win32';

/**
 * Commands run in their own process group, so a timeout kills what they started too.
 * What they leave running in the background (a dev server, a watcher) keeps going
 * between commands, as the user expects, but it must not outlive the agent: this
 * registry remembers every group that may still have members, and killAll() ends them
 * when the agent exits, crashes or is stopped by a signal (see onExit).
 *
 * On Windows there are no process groups: the shell's tree is killed with taskkill,
 * which cannot find what the shell left behind once the shell itself has exited.
 */
export class ProcessGroups {
  private readonly groups = new Set<number>();

  add(pid: number): void {
    for (const known of this.groups) if (!groupAlive(known)) this.groups.delete(known);
    this.groups.add(pid);
  }

  /** Called when the command ends: the group is forgotten once nothing in it is left. */
  release(pid: number): void {
    if (!groupAlive(pid)) this.groups.delete(pid);
  }

  /** Groups that may still have members. */
  get live(): number[] {
    return [...this.groups].filter(groupAlive);
  }

  /** Kills every group. Synchronous, so it can run in an "exit" handler. */
  killAll(): void {
    for (const pid of this.groups) {
      if (windows) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }
    this.groups.clear();
  }
}

/** The groups of the commands this process runs. */
export const processGroups = new ProcessGroups();

function groupAlive(pid: number): boolean {
  try {
    process.kill(windows ? pid : -pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const SIGNALS: readonly NodeJS.Signals[] = windows ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Runs cleanup once when this process ends: a normal exit, a crash (an uncaught error
 * still emits "exit"), SIGINT, SIGTERM or SIGHUP. It must be synchronous. SIGKILL
 * cannot be caught: then the next start removes the containers it left (see the
 * sandbox), but host processes survive. Returns a function that removes the handlers.
 */
export function onExit(cleanup: () => void): () => void {
  let done = false;
  const run = (): void => {
    if (done) return;
    done = true;
    try {
      cleanup();
    } catch {
      // Exiting anyway.
    }
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    run();
    process.exit(128 + (constants.signals[signal] ?? 0));
  };
  process.on('exit', run);
  for (const signal of SIGNALS) process.on(signal, onSignal);
  return () => {
    process.off('exit', run);
    for (const signal of SIGNALS) process.off(signal, onSignal);
  };
}
