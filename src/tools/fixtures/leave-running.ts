/**
 * For processes.test.ts: runs a command that leaves a process running in its group,
 * prints "ready", then ends the way the test asks: a signal from outside, a crash or
 * a normal exit. The process it left must not survive any of them.
 */
import { onExit, processGroups } from '../processes.js';
import { runCommand } from '../shell.js';

const [pidFile = '', how = 'signal'] = process.argv.slice(2);
onExit(() => processGroups.killAll());
const sleeper = `"${process.execPath}" -e "setInterval(() => {}, 1000)"`;
await runCommand(`${sleeper} > /dev/null 2>&1 & echo $! > "${pidFile}"`, { cwd: process.cwd(), timeoutMs: 10_000 });
process.stdout.write('ready\n');
if (how === 'crash') setTimeout(() => {
  throw new Error('crash on purpose');
}, 10);
else if (how === 'exit') setTimeout(() => process.exit(0), 10);
else setInterval(() => undefined, 1000);
