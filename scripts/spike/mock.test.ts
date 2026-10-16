/**
 * The spike end to end on the real DeepSeek adapter, against the local copy of the page
 * (headless): each failure class is played as the page or its stream would play it
 * (HTTP 429, a toast, an error event, a stream stopped before FINISHED, a canned
 * filter answer, a reply the page never shows...), the adapter classifies it, and the
 * meter must count what it counted with the FakeAdapter. Skipped without a browser.
 * Run with: npx tsx --test scripts/spike/mock.test.ts
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DeepSeekWebAdapter } from '../../src/adapters/deepseek/index.js';
import { startMockSite } from '../../src/adapters/deepseek/testing/mock-site.js';
import { parseFaults } from './faults.js';
import { runSpike } from './harness.js';
import type { CycleRecord } from './meter.js';
import { answer, mockTurns } from './mock-faults.js';
import { idealScript } from './project.js';

async function mockSpike(faults: string, cycles: number, timeoutMs: number) {
  const base = await mkdtemp(join(tmpdir(), 'spike-mock-'));
  const workspace = join(base, 'workspace');
  const dataDir = join(base, 'data');
  await mkdir(workspace);
  await mkdir(dataDir);
  const turns = mockTurns(idealScript(), parseFaults(faults));
  const site = await startMockSite(() => turns.shift() ?? answer('The mock has no scripted reply left.'));
  const adapter = new DeepSeekWebAdapter({
    profileDir: join(base, 'profile'),
    browser: 'auto',
    replyTimeoutMs: timeoutMs,
    debug: false,
    notify: () => undefined,
    waitForUser: false,
    url: site.url,
    headless: true,
  });
  try {
    try {
      const report = await adapter.inspect();
      if (!report.inputVisible) return undefined;
    } catch {
      return undefined; // no browser on this machine
    }
    const summary = await runSpike({
      adapter,
      workspace,
      dataDir,
      cycles,
      sandbox: 'none',
      sleep: async () => undefined,
      log: () => undefined,
    });
    return { summary, site, cycle: (n: number): CycleRecord => summary.cycles[n - 1] as CycleRecord };
  } finally {
    await adapter.close();
    await site.close();
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
  }
}

test('every failure class through the real adapter on the mock page, counted as with the FakeAdapter', async (t) => {
  const run = await mockSpike('malformed@3,cutoff@4,busy@5,notice@6,blank@7,empty@8,limit@10,unfenced@15,tag@18,unknown@20,filter@21', 30, 30_000);
  if (!run) return t.skip('no browser available');
  const { summary, cycle } = run;
  const row = (n: number) => {
    const c = cycle(n);
    return [c.taskId, c.prompt, c.attempts.length, c.malformed, c.cutOff, c.reasks, c.retries, c.drift, c.emptyReplies, c.unknownTools, c.errors, c.filtered, c.holds];
  };
  assert.deepEqual(row(3), ['fix-subtract', 'follow-up', 1, 1, 0, 0, 0, 1, 0, 0, {}, false, true]);
  assert.deepEqual(row(4), ['fix-subtract', 'results+malformed', 1, 0, 0, 1, 0, 0, 0, 0, {}, false, true]);
  // The stream stops before FINISHED inside the tool block, and the page shows no more: cut off.
  assert.deepEqual(row(5), ['fix-subtract', 'results', 1, 1, 1, 0, 0, 0, 0, 0, {}, false, true]);
  // HTTP 429, then a "server busy" toast: both busy, retried in the same cycle.
  assert.deepEqual(row(7), ['fix-subtract', 'results', 2, 0, 0, 0, 1, 0, 0, 0, { busy: 1 }, false, true]);
  assert.deepEqual(row(8), ['fix-subtract', 'results', 2, 0, 0, 0, 1, 0, 0, 0, { busy: 1 }, false, true]);
  // A blank streamed reply, then a reply the page never shows: both asked again.
  assert.deepEqual(row(9), ['log', 'follow-up', 2, 0, 0, 1, 1, 0, 1, 0, {}, false, true]);
  assert.deepEqual(row(10), ['log', 'results', 2, 0, 0, 1, 1, 0, 0, 0, { empty: 1 }, false, true]);
  // The upload went through before the unreadable reply: it counts as sent.
  assert.equal(cycle(10).attachments, 1);
  // The length limit, as an error event in the stream: a rollover, and the cycle goes on in chat 2.
  assert.deepEqual(row(12), ['run-tests', 'results', 2, 0, 0, 0, 0, 0, 0, 0, { limit: 1 }, false, true]);
  assert.equal(cycle(12).rollover?.reason, 'limit');
  assert.equal(cycle(12).chat, 2);
  // The planned stop, then the resume in a new chat.
  assert.equal(cycle(15).plannedStop, true);
  assert.deepEqual([cycle(16).prompt, cycle(16).chat], ['envelope:resume', 3]);
  assert.deepEqual(row(17), ['math-doc-resume', 'results', 1, 0, 0, 0, 0, 1, 0, 0, {}, false, true]);
  assert.deepEqual(row(18), ['math-doc-resume', 'off-protocol', 1, 0, 0, 1, 0, 0, 0, 0, {}, false, true]);
  assert.equal(cycle(21).drift, 1);
  assert.equal(cycle(21).attachments, 1);
  assert.equal(cycle(22).prompt, 'off-protocol');
  assert.deepEqual(row(24), ['usage-doc', 'results', 1, 0, 0, 0, 0, 1, 0, 1, {}, false, true]);
  // The canned filter answer (status CONTENT_FILTER) ends the task and the run.
  assert.deepEqual(row(26), ['usage-doc', 'results', 1, 0, 0, 0, 0, 0, 0, 0, {}, true, false]);
  const t2 = summary.totals;
  assert.equal(t2.cycles, 26);
  assert.equal(t2.heldInARow, 25);
  assert.deepEqual(t2.errors, { busy: 2, empty: 1, limit: 1 });
  assert.deepEqual([t2.malformed, t2.cutOff, t2.emptyReplies, t2.filtered, t2.reasks, t2.retries, t2.drift, t2.unknownTools], [2, 1, 1, 1, 6, 4, 4, 1]);
  assert.deepEqual(t2.rollovers, { limit: 1 });
  assert.equal(t2.chats, 3);
  assert.match(summary.stopped ?? '', /usage-doc\) ended filtered/);
  // Every reply was read from the stream, as the mock serves it.
  assert.ok(summary.cycles.every((c) => c.source === undefined || c.source === 'network'));
});

test('a provider error and a timeout through the real adapter: counted, and the run stops', async (t) => {
  const provider = await mockSpike('provider@2', 20, 30_000);
  if (!provider) return t.skip('no browser available');
  assert.deepEqual(provider.cycle(2).errors, { provider: 1 });
  assert.equal(provider.cycle(2).holds, false);
  assert.equal(provider.summary.totals.heldInARow, 1);
  assert.match(provider.summary.stopped ?? '', /explore\) ended failed: provider: DeepSeek: Internal error \(HTTP 500\)/);

  const timeout = await mockSpike('timeout@2', 20, 5_000);
  if (!timeout) return t.skip('no browser available');
  assert.deepEqual(timeout.cycle(2).errors, { timeout: 1 });
  assert.equal(timeout.cycle(2).timeouts, 1);
  assert.equal(timeout.summary.totals.heldInARow, 1);
  assert.match(timeout.summary.stopped ?? '', /ended failed: timeout/);
});
