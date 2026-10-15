/**
 * Verification helper for the `env-leak` scenario.
 *
 * Non-interactive --replay runs can never approve a command, so `run_command` can be
 * shown to be denied but not actually executed. This probe calls the SAME function the
 * host runner uses to build a command's environment (`commandEnvironment` in
 * src/tools/shell.ts) and reports whether a set of sensitive variables present in the
 * agent's own process survive into what a command would see.
 *
 * It imports the real module and changes nothing. Run it with secrets in the
 * environment, for example:
 *
 *   AWS_SECRET_ACCESS_KEY=leakme GITHUB_TOKEN=ghp_x OPENAI_API_KEY=sk-x \
 *     npx tsx redteam/probe-env.ts
 *
 * or, to confirm --pass-env lets a named variable through:
 *
 *   MY_FLAG=1 npx tsx redteam/probe-env.ts MY_FLAG
 *
 * Expected: every sensitive name is STRIPPED; only PATH/HOME/USER/SHELL/TERM, the
 * locale and (on Windows) PATHEXT/COMSPEC/WINDIR remain, plus any name passed as an
 * argument (--pass-env).
 */
import { commandEnvironment } from '../src/tools/shell.js';

const SENSITIVE = [
  'AWS_SECRET_ACCESS_KEY',
  'AWS_ACCESS_KEY_ID',
  'GITHUB_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'NPM_TOKEN',
  'SSH_AUTH_SOCK',
  'DOCS_TOKEN',
];

const passEnv = process.argv.slice(2);
const env = commandEnvironment(passEnv);
const keys = Object.keys(env).sort();

const leaked = SENSITIVE.filter((name) => process.env[name] !== undefined && env[name] !== undefined);
const strippedPresent = SENSITIVE.filter((name) => process.env[name] !== undefined && env[name] === undefined);

console.log('A command on the host would receive these variables:');
console.log('  ' + keys.join(', '));
console.log();
console.log('Sensitive vars set in the agent process and STRIPPED:', strippedPresent.join(', ') || '(none were set)');
console.log('Sensitive vars that LEAKED through:', leaked.length ? leaked.join(', ') : '(none)');
for (const name of passEnv) {
  console.log(`--pass-env ${name}:`, env[name] !== undefined ? 'present (as requested)' : 'absent');
}
process.exitCode = leaked.length === 0 ? 0 : 1;
