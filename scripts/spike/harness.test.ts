/**
 * Validates the spike harness before any live run: the FakeAdapter replays the ideal
 * script with one failure class injected, the real agent loop and toolbox run it, and
 * each test checks that the meter counts that failure, and only that, in the right
 * cycle. Run with: npx tsx --test scripts/spike/harness.test.ts
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FakeAdapter } from '../../src/adapters/fake/index.js';
import { CONTEXT_DEFAULTS, summarize } from '../../src/agent/context.js';
import { REPEAT_REQUEST } from '../../src/agent/prompt.js';
import { injectFaults, parseFaults } from './faults.js';
import { runSpike, type SpikeOptions } from './harness.js';
import { endsInsideFence, promptKind, type CycleRecord } from './meter.js';
import { ACCESS_ORDERS, idealScript, LOG_ERRORS, PROJECT_FILES } from './project.js';
import { readSpikeLog, renderReport } from './report.js';

async function spike(faults: string, cycles: number, extra: Partial<SpikeOptions> = {}) {
  const base = await mkdtemp(join(tmpdir(), 'spike-test-'));
  const workspace = join(base, 'workspace');
  const dataDir = join(base, 'data');
  await mkdir(workspace);
  await mkdir(dataDir);
  const adapter = new FakeAdapter(injectFaults(idealScript(), parseFaults(faults)));
  await adapter.open();
  const out = join(base, 'spike.jsonl');
  const lines: string[] = [];
  try {
    const summary = await runSpike({
      adapter,
      workspace,
      dataDir,
      cycles,
      out,
      sandbox: 'none',
      sleep: async () => undefined,
      log: (line) => lines.push(line),
      ...extra,
    });
    const log = await readSpikeLog(out);
    // The JSONL holds exactly what the run measured.
    assert.deepEqual(log.cycles, summary.cycles);
    assert.deepEqual(log.tasks, summary.tasks);
    return { summary, adapter, log, lines, cycle: (n: number): CycleRecord => summary.cycles[n - 1] as CycleRecord };
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The counters of one cycle that a failure class may touch. */
function counters(cycle: CycleRecord) {
  return {
    sends: cycle.attempts.length,
    blocks: cycle.blocks,
    malformed: cycle.malformed,
    cutOff: cycle.cutOff,
    reasks: cycle.reasks,
    retries: cycle.retries,
    drift: cycle.drift,
    timeouts: cycle.timeouts,
    filtered: cycle.filtered,
    emptyReplies: cycle.emptyReplies,
    unknownTools: cycle.unknownTools,
    errors: cycle.errors,
    holds: cycle.holds,
  };
}

const QUIET = {
  sends: 1,
  malformed: 0,
  cutOff: 0,
  reasks: 0,
  retries: 0,
  drift: 0,
  timeouts: 0,
  filtered: false,
  emptyReplies: 0,
  unknownTools: 0,
  errors: {},
  holds: true,
};

test('the ideal script: 20 cycles and the task under way, all held, every task done and checked', async () => {
  const { summary, adapter, log } = await spike('', 20);
  const t = summary.totals;
  // The 20th cycle falls inside the 8th task, which runs to its end.
  assert.equal(t.cycles, 21);
  assert.equal(t.heldInARow, 21);
  assert.equal(t.clean, 21);
  assert.equal(t.blocks, 17);
  assert.equal(t.calls, 17);
  assert.equal(t.malformed + t.cutOff + t.reasks + t.retries + t.drift + t.timeouts + t.filtered + t.emptyReplies, 0);
  assert.deepEqual(t.errors, {});
  assert.deepEqual(t.tools, { list_dir: 1, read_file: 10, edit_file: 1, run_command: 1, write_file: 2, update_task: 1 });
  // run_command asks for approval, and without a terminal the normal approver says no.
  assert.equal(t.denied, 1);
  assert.equal(t.toolFailures, 0);
  // The two long logs are summarized and attached: the README's upload, through the task state's budget.
  assert.equal(t.summarized, 2);
  assert.equal(t.attachments, 2);
  assert.equal(adapter.sent.filter((sent) => sent.attachments.length > 0).length, 2);
  assert.deepEqual(t.rollovers, {});
  // The planned stop (Ctrl+C) holds; the resume goes on in a new chat, from the state file.
  assert.deepEqual(t.taskStatuses, { done: 7, aborted: 1 });
  assert.equal(t.chats, 2);
  assert.equal(t.checksPassed, 8);
  assert.equal(summary.stopped, undefined);
  assert.match(renderReport(log), /held in a row from the first: \*\*21\*\*/);
});

test('the planned stop and the resume: the stop holds, the unrun call is in the envelope, a new chat goes on', async () => {
  const { adapter, cycle } = await spike('', 16);
  assert.equal(cycle(13).taskId, 'math-doc');
  assert.equal(cycle(13).end, 'aborted');
  assert.equal(cycle(13).plannedStop, true);
  assert.equal(cycle(13).pending, 1);
  assert.equal(cycle(13).holds, true);
  assert.equal(cycle(14).taskId, 'math-doc-resume');
  assert.equal(cycle(14).prompt, 'envelope:resume');
  assert.equal(cycle(14).chat, 2);
  assert.equal(adapter.newChats, 1);
  const envelope = adapter.sent.find((sent) => promptKind(sent.message) === 'envelope:resume')?.message ?? '';
  assert.match(envelope, /The task stopped earlier \(aborted\)/);
  assert.match(envelope, /"call": "write_file docs\/math\.md",\s+"ok": false,\s+"result": "Not run: the task stopped \(aborted\) before it ran\."/);
  assert.equal(cycle(16).end, 'done');
});

test('a malformed block: counted in its cycle, re-asked in the next', async () => {
  const { summary, cycle } = await spike('malformed@3', 4);
  assert.deepEqual(counters(cycle(3)), { ...QUIET, blocks: 1, malformed: 1, drift: 1 });
  assert.equal(cycle(4).prompt, 'results+malformed');
  assert.deepEqual(counters(cycle(4)), { ...QUIET, blocks: 1, reasks: 1 });
  assert.equal(summary.totals.malformed, 1);
  assert.equal(summary.totals.reasks, 1);
  assert.equal(summary.totals.heldInARow, summary.totals.cycles);
});

test('a reply cut off inside its tool block: cut-off and malformed, then re-asked', async () => {
  const { summary, cycle } = await spike('cutoff@4', 5);
  assert.deepEqual(counters(cycle(4)), { ...QUIET, blocks: 1, malformed: 1, cutOff: 1, drift: 1 });
  assert.deepEqual(counters(cycle(5)), { ...QUIET, blocks: 1, reasks: 1 });
  assert.deepEqual(cycle(5).tools, { edit_file: 1 });
  assert.equal(summary.totals.cutOff, 1);
});

test('a timeout: an adapter error that fails the task and stops the run', async () => {
  const { summary, cycle } = await spike('timeout@4', 20);
  assert.deepEqual(counters(cycle(4)), { ...QUIET, blocks: 0, timeouts: 1, errors: { timeout: 1 }, holds: false });
  assert.equal(cycle(4).end, 'failed');
  assert.equal(summary.cycles.length, 4);
  assert.equal(summary.totals.heldInARow, 3);
  assert.match(summary.stopped ?? '', /fix-subtract\) ended failed: timeout/);
});

test('a content filter hit: counted, the task ends filtered, the run stops', async () => {
  const { summary, cycle } = await spike('filter@4', 20);
  assert.deepEqual(counters(cycle(4)), { ...QUIET, blocks: 0, filtered: true, holds: false });
  assert.equal(cycle(4).end, 'filtered');
  assert.equal(summary.totals.filtered, 1);
  assert.equal(summary.totals.heldInARow, 3);
  assert.match(summary.stopped ?? '', /ended filtered/);
});

test('busy: retried in the same cycle, which holds', async () => {
  const { summary, cycle } = await spike('busy@4', 6);
  assert.deepEqual(counters(cycle(4)), { ...QUIET, sends: 2, blocks: 1, retries: 1, errors: { busy: 1 } });
  assert.equal(cycle(4).clean, false);
  assert.deepEqual(cycle(4).tools, { edit_file: 1 });
  assert.equal(summary.totals.heldInARow, 6);
});

test('limit: the chat rolls over and the same cycle goes on in the new one', async () => {
  const { summary, cycle } = await spike('limit@5', 6);
  assert.deepEqual(counters(cycle(5)), { ...QUIET, sends: 2, blocks: 1, errors: { limit: 1 } });
  assert.deepEqual(
    cycle(5).attempts.map((attempt) => [attempt.prompt, attempt.chat, attempt.error]),
    [
      ['results', 1, 'limit'],
      ['envelope:limit', 2, undefined],
    ],
  );
  assert.deepEqual(cycle(5).rollover, { reason: 'limit', chat: 2, used: cycle(4).budget?.used, limit: 200_000 });
  assert.equal(cycle(6).chat, 2);
  assert.deepEqual(summary.totals.rollovers, { limit: 1 });
  assert.equal(summary.totals.heldInARow, 6);
});

test('a provider error: counted, the task fails, the run stops', async () => {
  const { summary, cycle } = await spike('provider@4', 20);
  assert.deepEqual(counters(cycle(4)), { ...QUIET, blocks: 0, errors: { provider: 1 }, holds: false });
  assert.equal(summary.totals.heldInARow, 3);
  assert.ok(summary.stopped);
});

test('send_failed: counted, the task fails, the run stops', async () => {
  const { summary, cycle } = await spike('send_failed@4', 20);
  assert.deepEqual(counters(cycle(4)), { ...QUIET, blocks: 0, errors: { send_failed: 1 }, holds: false });
  assert.ok(summary.stopped);
});

test('an unreadable reply: asked again in the same cycle, counted as a retry and a re-ask', async () => {
  const { adapter, cycle } = await spike('empty@4', 5);
  assert.deepEqual(counters(cycle(4)), { ...QUIET, sends: 2, blocks: 1, retries: 1, reasks: 1, errors: { empty: 1 } });
  assert.deepEqual(
    cycle(4).attempts.map((attempt) => attempt.prompt),
    ['results', 'repeat'],
  );
  assert.ok(adapter.sent.some((sent) => sent.message === REPEAT_REQUEST));
});

test('a blank reply: counted, asked again like an unreadable one, and the task goes on', async () => {
  const { summary, cycle } = await spike('blank@4', 6);
  assert.deepEqual(counters(cycle(4)), { ...QUIET, sends: 2, blocks: 1, retries: 1, reasks: 1, emptyReplies: 1 });
  assert.deepEqual(cycle(4).tools, { edit_file: 1 });
  assert.equal(summary.tasks[1]?.status, 'done');
  assert.equal(summary.tasks[1]?.check, 'pass');
  assert.equal(summary.totals.emptyReplies, 1);
  assert.equal(summary.totals.heldInARow, summary.totals.cycles);
});

test('protocol forgotten, a JSON call outside the fences: drift, then an off-protocol re-ask', async () => {
  const { cycle } = await spike('unfenced@4', 5);
  assert.deepEqual(counters(cycle(4)), { ...QUIET, blocks: 0, drift: 1 });
  assert.equal(cycle(5).prompt, 'off-protocol');
  assert.deepEqual(counters(cycle(5)), { ...QUIET, blocks: 1, reasks: 1 });
});

test('protocol forgotten, a function-calling tag: drift, then an off-protocol re-ask', async () => {
  const { cycle } = await spike('tag@4', 5);
  assert.deepEqual(counters(cycle(4)), { ...QUIET, blocks: 0, drift: 1 });
  assert.deepEqual(counters(cycle(5)), { ...QUIET, blocks: 1, reasks: 1 });
});

test('protocol forgotten twice in a row: a drift rollover, and the envelope counts as a re-ask', async () => {
  const { summary, cycle } = await spike('unfenced@5,unfenced@5', 7);
  assert.deepEqual(counters(cycle(5)), { ...QUIET, blocks: 0, drift: 1 });
  assert.deepEqual(counters(cycle(6)), { ...QUIET, blocks: 0, drift: 1, reasks: 1 });
  assert.equal(cycle(7).prompt, 'envelope:drift');
  assert.equal(cycle(7).chat, 2);
  assert.equal(cycle(7).rollover?.reason, 'drift');
  assert.deepEqual(counters(cycle(7)), { ...QUIET, blocks: 1, reasks: 1 });
  assert.deepEqual(summary.totals.rollovers, { drift: 1 });
});

test('a call to an unknown tool: counted as such and as drift, not as a tool error', async () => {
  const { summary, cycle } = await spike('unknown@4', 5);
  assert.deepEqual(counters(cycle(4)), { ...QUIET, blocks: 1, unknownTools: 1, drift: 1 });
  assert.equal(summary.totals.toolFailures, 0);
});

test('a failed upload: attachments go off and the same cycle is sent again with the summary', async () => {
  const { summary, cycle } = await spike('send_failed@8', 8);
  const attempts = cycle(8).attempts.map((attempt) => [attempt.prompt, attempt.attachments, attempt.error]);
  assert.deepEqual(attempts, [
    ['results', 1, 'send_failed'],
    ['results', 0, undefined],
  ]);
  assert.equal(cycle(8).attachmentsOff, true);
  assert.equal(cycle(8).attachments, 0);
  assert.equal(cycle(8).holds, true);
  assert.equal(summary.tasks[2]?.id, 'log');
  assert.equal(summary.tasks[2]?.check, 'pass');
});

test('the gate: an edit in a chat that has not read the file is counted as gated', async () => {
  // Two drifting replies roll the chat over right before the edit of fix-subtract.
  const { cycle } = await spike('unfenced@4,unfenced@4', 7);
  assert.equal(cycle(6).chat, 2);
  assert.equal(cycle(6).gated, 1);
  assert.deepEqual(cycle(6).tools, {});
});

test('the logs: summarized and attached; the summary keeps the ERROR lines and none of the /api/orders ones', () => {
  for (const name of ['data/server.log', 'data/access.log']) {
    const text = PROJECT_FILES[name] ?? '';
    // Over the inline limit of read_file, under the toolbox's cut: a summary plus the whole file attached.
    assert.ok(text.length > CONTEXT_DEFAULTS.inlineReadChars && text.length < 20_000, `${name}: ${text.length} characters`);
  }
  const server = summarize(PROJECT_FILES['data/server.log'] ?? '', CONTEXT_DEFAULTS.inlineReadChars).text;
  for (const line of Object.values(LOG_ERRORS)) assert.ok(server.includes(line), line);
  const access = PROJECT_FILES['data/access.log'] ?? '';
  assert.equal(access.match(/\/api\/orders/g)?.length, ACCESS_ORDERS.to - ACCESS_ORDERS.from + 1);
  assert.equal(summarize(access, CONTEXT_DEFAULTS.inlineReadChars).text.match(/\/api\/orders/g), null);
});

test('promptKind tells the messages apart', () => {
  assert.equal(promptKind(REPEAT_REQUEST), 'repeat');
  assert.equal(promptKind('Tool results:\n\n[1] x: ok\n\nReply 1 of 8 used. Continue with more tool blocks, or reply without any tool block when the task is done.'), 'results');
  assert.equal(
    promptKind('Tool results:\n\n[1] x: error\n\nSome tool blocks were malformed: send them again, fixed. Reply 1 of 8 used. Continue...'),
    'results+malformed',
  );
  assert.equal(promptKind('New task from the user. ...\n\n# Task\n\nDo it'), 'follow-up');
  assert.equal(promptKind('You are the mind...\n\n# Task\n\nDo it'), 'task');
  assert.equal(promptKind('Nothing was run: your reply has a JSON line that calls read_file, but no ```tool block.'), 'off-protocol');
});

test('endsInsideFence: an open fence at the end, nested blocks in a tool block are not', () => {
  assert.equal(endsInsideFence('text\n```tool\n{"tool": "x"}\nbody'), true);
  assert.equal(endsInsideFence('```tool\n{"tool": "x"}\n```'), false);
  assert.equal(endsInsideFence('```tool\n{"tool": "w"}\n```python\nprint(1)\n```\nmore\n```'), false);
  assert.equal(endsInsideFence('```tool\n{"tool": "w"}\n```python\nprint(1)\n```\nmore'), true);
  assert.equal(endsInsideFence('use `a` and ```inline``` here'), false);
  assert.equal(endsInsideFence('```js\nx\n```\n````md\n```\n'), true);
});
