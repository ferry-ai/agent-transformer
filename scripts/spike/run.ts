/**
 * The reliability spike: at least N consecutive agent cycles on a throwaway project,
 * measured cycle by cycle (see SPIKE-REPORT.md).
 *
 *   npx tsx scripts/spike/run.ts                         offline, the scripted replies
 *   npx tsx scripts/spike/run.ts --faults malformed@3,busy@5
 *   npx tsx scripts/spike/run.ts --adapter mock          the DeepSeek adapter on a local copy of the page
 *   npx tsx scripts/spike/run.ts --adapter deepseek      live, with the logged-in profile
 *
 * Everything the run writes (workspace, session log, task state, checkpoints, JSONL)
 * goes to a fresh temp folder. Live, the only thing taken from the data dir is the
 * browser profile, opened by the adapter as the CLI opens it; the run never waits for
 * a login or a verification, and stops at the first error from the provider.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DeepSeekWebAdapter } from '../../src/adapters/deepseek/index.js';
import { fragmentStream, replyHtml, startMockSite, type MockSite } from '../../src/adapters/deepseek/testing/mock-site.js';
import { FakeAdapter } from '../../src/adapters/fake/index.js';
import type { BrowserChoice } from '../../src/browser/launch.js';
import { defaultDataDir } from '../../src/config.js';
import type { ChatAdapter } from '../../src/core/adapter.js';
import type { SandboxChoice } from '../../src/tools/sandbox.js';
import { injectFaults, parseFaults } from './faults.js';
import { runSpike } from './harness.js';
import { idealScript } from './project.js';
import { readSpikeLog, renderReport } from './report.js';

const USAGE = `Usage: npx tsx scripts/spike/run.ts [options]

  --adapter <name>      fake (default): scripted replies, offline
                        mock: the DeepSeek adapter on a local copy of the page, headless
                        deepseek: chat.deepseek.com with the logged-in profile (live)
  --cycles <n>          cycles to reach (default 20); the task under way finishes
  --faults <list>       fake only: failures to inject, e.g. malformed@3,busy@5 (scripts/spike/faults.ts)
  --budget <chars>      context budget of one chat (default: the agent's, 200000)
  --max-iterations <n>  replies per task (default 8)
  --max-minutes <n>     time limit per task (default 30)
  --timeout <sec>       longest wait for one reply (mock, deepseek; default 300)
  --debug               keep the raw stream and HTML of every reply in the session folder
  --browser <name>      chrome | msedge | chromium (deepseek; default: the first one found)
  --data-dir <path>     deepseek: the data dir whose profiles/deepseek is used (default: the real one)
  --sandbox <mode>      auto (default, as in the CLI) | none | docker | podman
  --pause <sec>         wait between two tasks (default 0)
  --workspace-base <d>  where the workspace folder is made (default: the run folder; live, a
                        folder whose path does not carry your user name, since the model sees it)
  --out <file>          the per-cycle JSONL (default: spike.jsonl in the run folder)
  --keep-going          do not stop at the first task that ends on a provider error`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      adapter: { type: 'string', default: 'fake' },
      cycles: { type: 'string', default: '20' },
      faults: { type: 'string' },
      budget: { type: 'string' },
      'max-iterations': { type: 'string', default: '8' },
      'max-minutes': { type: 'string', default: '30' },
      timeout: { type: 'string', default: '300' },
      debug: { type: 'boolean', default: false },
      browser: { type: 'string', default: 'auto' },
      'data-dir': { type: 'string' },
      sandbox: { type: 'string', default: 'auto' },
      out: { type: 'string' },
      pause: { type: 'string', default: '0' },
      'workspace-base': { type: 'string' },
      'keep-going': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) return console.log(USAGE);
  const kind = values.adapter;
  if (kind !== 'fake' && kind !== 'mock' && kind !== 'deepseek') throw new Error('--adapter must be fake, mock or deepseek.');
  if (values.faults !== undefined && kind !== 'fake') throw new Error('--faults works with --adapter fake only.');
  const cycles = whole(values.cycles, '--cycles');
  const timeoutMs = whole(values.timeout, '--timeout') * 1000;
  const sandbox = (['auto', 'none', 'docker', 'podman'] as const).find((choice) => choice === values.sandbox);
  if (sandbox === undefined) throw new Error('--sandbox must be auto, none, docker or podman.');

  const pauseSec = Number(values.pause);
  if (!Number.isFinite(pauseSec) || pauseSec < 0) throw new Error('--pause must be a number of seconds.');

  const run = await mkdtemp(join(tmpdir(), 'agent-spike-'));
  const base = values['workspace-base'] ?? (kind === 'deepseek' ? neutralBase() : undefined);
  const workspace = base === undefined ? join(run, 'workspace') : await mkdtemp(join(resolve(base), 'agent-spike-workspace-'));
  const dataDir = join(run, 'data');
  if (base === undefined) await mkdir(workspace);
  await mkdir(dataDir, { mode: 0o700 });
  const out = resolve(values.out ?? join(run, 'spike.jsonl'));
  console.log(`Run folder: ${run}`);
  if (base !== undefined) console.log(`Workspace folder (its path is shown to the model): ${workspace}`);

  let adapter: ChatAdapter;
  let site: MockSite | undefined;
  let fastRetries = false;
  const script = idealScript();
  if (kind === 'fake') {
    const fake = new FakeAdapter(injectFaults(script, parseFaults(values.faults ?? '')));
    await fake.open();
    adapter = fake;
    fastRetries = true;
  } else {
    if (kind === 'mock') {
      const replies = [...script];
      site = await startMockSite(() => {
        const text = replies.shift() ?? 'The mock has no scripted reply left.';
        return { body: fragmentStream({ text }), html: replyHtml({ text }) };
      });
    }
    const profileDir =
      kind === 'mock' ? join(run, 'mock-profile') : join(resolve(values['data-dir'] ?? defaultDataDir()), 'profiles', 'deepseek');
    const deepseek = new DeepSeekWebAdapter({
      profileDir,
      browser: parseBrowser(values.browser),
      replyTimeoutMs: timeoutMs,
      debug: values.debug === true,
      // Never wait for a login or a verification: report it and stop.
      waitForUser: false,
      notify: (message) => console.log(`  ${message}`),
      ...(site ? { url: site.url, headless: true } : {}),
    });
    adapter = deepseek;
    const stop = (): void => {
      void deepseek.close().finally(() => process.exit(130));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      // inspect() opens the browser and never waits for a login: it says what the page shows.
      const report = await deepseek.inspect();
      console.log(`Browser ${report.browser}, page ${report.url}, message box ${report.inputVisible ? 'yes' : 'no'}`);
      if (!report.inputVisible || report.verificationFrames > 0) {
        const why = report.verificationFrames > 0 ? 'a verification is shown' : report.signInPage ? 'the profile is not logged in (sign-in page)' : 'no message box';
        console.log(`Live run skipped: ${why}. Log in with "npm run chat" first.`);
        process.exitCode = 2;
        await deepseek.close();
        await site?.close();
        return;
      }
    } catch (error) {
      console.log(`Live run skipped: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
      await deepseek.close();
      await site?.close();
      return;
    }
  }

  try {
    const summary = await runSpike({
      adapter,
      workspace,
      dataDir,
      cycles,
      out,
      maxIterations: whole(values['max-iterations'], '--max-iterations'),
      maxMinutes: whole(values['max-minutes'], '--max-minutes'),
      sandbox: sandbox as SandboxChoice,
      stopOnError: values['keep-going'] !== true,
      pauseSec,
      label: kind === 'fake' ? `fake${values.faults ? ` (faults ${values.faults})` : ''}` : kind,
      ...(values.budget === undefined ? {} : { context: { budgetChars: whole(values.budget, '--budget') } }),
      ...(fastRetries ? { sleep: async () => undefined } : {}),
    });
    console.log(`\n${renderReport(await readSpikeLog(out))}\n`);
    console.log(`JSONL: ${out}`);
    console.log(`Session log: ${summary.sessionDir}`);
    if (summary.totals.heldInARow < cycles) process.exitCode = 1;
  } finally {
    await adapter.close();
    await site?.close();
  }
}

/**
 * A folder for the live workspace whose path does not carry the user's name: the
 * instructions show the workspace path to the model, and it lands in the provider's
 * history. On Windows the temp folder is under the user's profile, so the shared
 * Public folder is used instead.
 */
function neutralBase(): string {
  const temp = tmpdir();
  const name = userInfo().username.toLowerCase();
  if (name === '' || !temp.toLowerCase().includes(name)) return temp;
  const shared = process.env.PUBLIC ?? 'C:\\Users\\Public';
  if (process.platform === 'win32' && existsSync(shared) && !shared.toLowerCase().includes(name)) return shared;
  console.log('warning: the workspace path carries your user name, and the model will see it. Use --workspace-base to choose another folder.');
  return temp;
}

function whole(value: string | undefined, flag: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${flag} must be a positive whole number, got "${value}".`);
  return number;
}

function parseBrowser(value: string | undefined): BrowserChoice {
  const choices: readonly BrowserChoice[] = ['auto', 'chrome', 'msedge', 'chromium'];
  const match = choices.find((choice) => choice === value);
  if (!match) throw new Error(`--browser must be one of: ${choices.join(', ')}.`);
  return match;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
