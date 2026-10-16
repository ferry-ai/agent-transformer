import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { FakeAdapter, type FakeStep } from '../adapters/fake/index.js';
import { AdapterError } from '../core/adapter.js';
import { Transcript } from '../core/transcript.js';
import { nativeTools } from '../tools/native.js';
import { Toolbox } from '../tools/toolbox.js';
import type { Tool } from '../tools/types.js';
import { fitResults, render, resultCost, SQUEEZED_CHARS, summarize, type ContextOptions } from './context.js';
import { Agent, type AgentEvent, type AgentOptions } from './loop.js';
import { loadTaskState, TASK_STATE_FILE } from './state.js';

const tool = (block: string): string => `\`\`\`tool\n${block}\n\`\`\``;
const call = (name: string, args: Record<string, unknown> = {}, body?: string): string =>
  tool(JSON.stringify({ tool: name, args }) + (body === undefined ? '' : `\n${body}`));

/** "emit" answers with a text of the given size; "note" records its text. */
function tools(log: string[] = []): Tool[] {
  return [
    {
      name: 'emit',
      description: 'Prints a long text.',
      params: { type: 'object', properties: { size: { type: 'integer' }, id: { type: 'string' } }, required: ['size'] },
      run: async (args) => {
        const size = Number(args.size);
        const lines = Array.from({ length: Math.ceil(size / 50) }, (_, i) => `line ${String(i).padStart(4, '0')} ${'.'.repeat(39)}`);
        lines.splice(Math.floor(lines.length / 2), 0, 'ERROR: something broke in the middle');
        return { ok: true, text: `emitted ${String(args.id ?? '')}\n${lines.join('\n')}`.slice(0, size) };
      },
    },
    {
      name: 'note',
      description: 'Writes a note.',
      params: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      body: 'text',
      run: async (args) => {
        log.push(String(args.text));
        return { ok: true, text: `noted ${String(args.text)}` };
      },
    },
  ];
}

async function session(): Promise<{ base: string; transcript: Transcript; done: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), 'agent-context-'));
  const transcript = await Transcript.create(base, 'fake');
  return { base, transcript, done: () => rm(base, { recursive: true, force: true }) };
}

async function setup(steps: FakeStep[], options: Partial<AgentOptions> & { context?: ContextOptions | false } = {}) {
  const adapter = new FakeAdapter(steps);
  await adapter.open();
  const log: string[] = [];
  const events: AgentEvent[] = [];
  const agent = new Agent({
    adapter,
    toolbox: new Toolbox(tools(log)),
    root: '/work',
    sleep: async () => undefined,
    onEvent: (event) => events.push(event),
    ...options,
  });
  const of = <T extends AgentEvent['type']>(type: T) => events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type);
  return { adapter, agent, log, events, of };
}

async function transcriptLines(transcript: Transcript): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(transcript.dir, 'transcript.jsonl'), 'utf8');
  return text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('summaries keep the start, the end and the lines that mention errors', () => {
  const text = Array.from({ length: 400 }, (_, i) => (i === 200 ? 'AssertionError: expected 1 to be 2' : `line ${i}`)).join('\n');
  const summary = summarize(text, 1_000);
  assert.ok(summary.text.length <= 1_100, `summary of ${summary.text.length} characters`);
  assert.match(summary.text, /^line 0\n/);
  assert.match(summary.text, /line 399$/);
  assert.match(summary.text, /lines from the part left out that mention errors:\]\nAssertionError: expected 1 to be 2\n/);
  assert.equal(summary.lines, 400);
  assert.ok(summary.cut > text.length - 1_100);
  assert.deepEqual(summarize('short', 1_000), { text: 'short', cut: 0, lines: 1 });
});

test('a message renders its long results with or without the attachments', () => {
  const message = {
    results: [
      { index: 1, tool: 'run_command', ok: false, text: 'x'.repeat(50), summary: { text: 'x…x', cut: 47, lines: 1, attachment: '/s/attachments/result-0001-run_command.txt' } },
      { index: 2, tool: 'list_dir', ok: true, text: 'a.py' },
    ],
    tail: 'Footer.',
  };
  const attached = render(message, true);
  assert.deepEqual(attached.attachments, ['/s/attachments/result-0001-run_command.txt']);
  assert.equal(attached.attachedChars, 50);
  assert.match(attached.text, /^Tool results:\n\n\[1\] run_command: error\n```text\nx…x\n\[The full result \(1 lines, 50 characters\) is attached as result-0001-run_command\.txt\./);
  assert.match(attached.text, /\[2\] list_dir: ok\n```text\na\.py\n```\n\nFooter\.$/);
  const inline = render(message, false);
  assert.deepEqual(inline.attachments, []);
  assert.match(inline.text, /x…x\n\[47 characters were left out to keep this chat short\./);
});

test('the results of one message fit a room: the first ones keep the most, the others are cut down', () => {
  const long = (id: string): string => `${id}\n${'x'.repeat(3_000)}\nend of ${id}`;
  const results = [
    { index: 1, tool: 'emit', ok: true, text: long('A') },
    {
      index: 2,
      tool: 'emit',
      ok: true,
      text: long('B'),
      summary: { text: 'B…', cut: 3_000, lines: 3, attachment: '/s/attachments/result-0001-emit.txt' },
    },
    { index: 3, tool: 'emit', ok: true, text: long('C') },
    { index: 4, tool: 'emit', ok: false, text: 'short error' },
  ];
  const whole = fitResults(results, 100_000);
  assert.deepEqual(whole, results);

  const fitted = fitResults(results, 3_400);
  assert.equal(fitted[0], results[0]); // it fits whole
  assert.deepEqual(fitted[1]?.summary, { text: 'B…', cut: 3_000, lines: 3 }); // no room left for its attachment
  assert.equal(fitted[2]?.summary?.text, 'C / … / end of C'); // only its first and last lines
  assert.equal(fitted[2]?.summary?.full, true);
  assert.match(
    render({ results: fitted, tail: '' }, true).text,
    /\[3\] emit: ok\n```text\nC \/ … \/ end of C\n\[\d+ characters were left out because this message was full\./,
  );
  assert.ok(fitted.slice(0, 2).reduce((sum, result) => sum + resultCost(result), 0) <= 3_400);

  // With a little more room, the third one keeps a short summary instead.
  const roomier = fitResults(results, 3_400 + SQUEEZED_CHARS + 300);
  assert.equal(roomier[2]?.summary?.full, true);
  assert.match(roomier[2]?.summary?.text ?? '', /^C\n/);
  assert.ok((roomier[2]?.summary?.text.length ?? 0) <= SQUEEZED_CHARS + 100);
});

test('a long result goes as a summary, its full text attached from the session folder', async () => {
  const { transcript, done } = await session();
  const { adapter, agent, of } = await setup([call('emit', { size: 12_000, id: 'A' }), 'Done.'], {
    transcript,
    context: { inlineResultChars: 2_000 },
  });
  const result = await agent.run('Print the log');
  assert.equal(result.status, 'done');

  const sent = adapter.sent[1];
  assert.equal(sent?.attachments.length, 1);
  const attachment = sent?.attachments[0] ?? '';
  assert.equal(relative(join(transcript.dir, 'attachments'), attachment).includes('..'), false);
  assert.match(attachment, /result-0001-emit\.txt$/);
  const full = await readFile(attachment, 'utf8');
  assert.equal(full.length, 12_000);
  assert.ok(full.startsWith('emitted A\n'));
  assert.ok((sent?.message.length ?? 0) < 3_000, `message of ${sent?.message.length} characters`);
  assert.match(sent?.message ?? '', /is attached as result-0001-emit\.txt/);
  assert.match(sent?.message ?? '', /ERROR: something broke in the middle/);

  assert.deepEqual(of('summarized').map((event) => [event.tool, event.chars, event.attachment]), [['emit', 12_000, attachment]]);
  const lines = await transcriptLines(transcript);
  const summarized = lines.find((line) => line.event === 'result_summarized');
  assert.equal(summarized?.attachment, attachment);
  const turn2 = lines.find((line) => line.turn === 2);
  assert.deepEqual(turn2?.attachments, [attachment]);
  assert.equal(turn2?.chat, 1);
  assert.equal(typeof turn2?.contextChars, 'number');
  await done();
});

test('without a session folder, or in summary mode, long results are only summarized', async () => {
  for (const mode of ['no folder', 'summary'] as const) {
    const { transcript, done } = await session();
    const { adapter, agent } = await setup(
      [call('emit', { size: 12_000 }), 'Done.'],
      mode === 'summary' ? { transcript, context: { inlineResultChars: 2_000, largeResults: 'summary' } } : { context: { inlineResultChars: 2_000 } },
    );
    await agent.run('Print the log');
    assert.deepEqual(adapter.sent[1]?.attachments, []);
    assert.match(adapter.sent[1]?.message ?? '', /characters were left out to keep this chat short/);
    await done();
  }
});

test('when attachments cannot be sent, the same results go again as summaries', async () => {
  const { transcript, done } = await session();
  const { adapter, agent, of } = await setup(
    [call('emit', { size: 12_000 }), new AdapterError('send_failed', 'The upload never finished.'), 'Done.', call('emit', { size: 9_000 }), 'Done again.'],
    { transcript, context: { inlineResultChars: 2_000 } },
  );
  assert.equal((await agent.run('Print the log')).status, 'done');
  assert.equal(adapter.sent.length, 3);
  assert.equal(adapter.sent[1]?.attachments.length, 1);
  assert.deepEqual(adapter.sent[2]?.attachments, []);
  assert.match(adapter.sent[2]?.message ?? '', /characters were left out/);
  assert.equal(of('attachments_off').length, 1);
  // Off for the rest of the session.
  await agent.run('Again');
  assert.deepEqual(adapter.sent[4]?.attachments, []);
  await done();
});

test('an upload that fails with a raw error (not an AdapterError) also falls back to summaries', async () => {
  const { transcript, done } = await session();
  const { adapter, agent, of } = await setup(
    [
      call('emit', { size: 12_000 }),
      () => {
        throw new Error('locator.setInputFiles: Timeout 30000ms exceeded.');
      },
      'Done.',
    ],
    { transcript, context: { inlineResultChars: 2_000 } },
  );
  assert.equal((await agent.run('Print the log')).status, 'done');
  assert.equal(adapter.sent.length, 3);
  assert.equal(adapter.sent[1]?.attachments.length, 1);
  assert.deepEqual(adapter.sent[2]?.attachments, []);
  assert.deepEqual(of('attachments_off').map((event) => event.message), ['locator.setInputFiles: Timeout 30000ms exceeded.']);
  const lines = await transcriptLines(transcript);
  assert.equal(lines.filter((line) => line.event === 'attachments_off').length, 1);
  await done();
});

test('one message attaches at most a quarter of the budget; the other long results stay summaries', async () => {
  const { transcript, done } = await session();
  const { adapter, agent, of } = await setup(
    [`${call('emit', { size: 8_000, id: 'A' })}\n${call('emit', { size: 8_000, id: 'B' })}`, 'Done.'],
    { transcript, context: { budgetChars: 40_000, replyReserveChars: 0, inlineResultChars: 2_000 } },
  );
  assert.equal((await agent.run('Print two logs')).status, 'done');
  const sent = adapter.sent[1];
  assert.equal(sent?.attachments.length, 1);
  assert.match(sent?.message ?? '', /\[1\] emit: ok\n```text\nemitted A\n[\s\S]*is attached as result-0001-emit\.txt/);
  assert.match(sent?.message ?? '', /\[2\] emit: ok\n```text\nemitted B\n[\s\S]*characters were left out to keep this chat short/);
  assert.deepEqual(of('summarized').map((event) => event.attachment !== undefined), [true, false]);
  await done();
});

/** Runs a script once to measure the chat, so the budget can be set just below or above it. */
async function measure(steps: () => FakeStep[], task: string, context: ContextOptions = {}): Promise<number[]> {
  const sizes: number[] = [];
  const { agent } = await setup(steps(), { context, onEvent: (event) => event.type === 'budget' && sizes.push(event.used) });
  await agent.run(task);
  return sizes;
}

test('the budget moves a long task to a new chat with the envelope: protocol, task state, last results', async () => {
  const steps = (): FakeStep[] => [
    `${call('update_task', { decision: 'Print in four parts' }, '- [x] Plan\n- [ ] Print the parts')}\n${call('emit', { size: 10_000, id: 'one' })}`,
    call('emit', { size: 10_000, id: 'two' }),
    call('emit', { size: 10_000, id: 'three' }),
    call('emit', { size: 10_000, id: 'four' }),
    'All four printed.',
  ];
  // Results this long stay whole. Without a budget the chat would hold this much after each reply.
  const inline: ContextOptions = { inlineResultChars: 20_000 };
  const sizes = await measure(steps, 'Print the report', inline);
  assert.equal(sizes.length, 5);
  const budgetChars = (sizes[3] ?? 0) + 1_000; // the fourth results message does not fit

  const { transcript, done } = await session();
  const { adapter, agent, of, log } = await setup(steps(), { transcript, context: { ...inline, budgetChars, replyReserveChars: 500 } });
  const result = await agent.run('Print the report');
  assert.equal(result.status, 'done');
  assert.equal(result.iterations, 5);
  assert.deepEqual(log, []);
  assert.equal(adapter.newChats, 1);
  assert.equal(agent.conversation.number, 2);

  const envelope = adapter.sent[4]?.message ?? '';
  assert.match(envelope, /^You are the mind of a coding agent/);
  assert.match(envelope, /# Calling tools/);
  assert.match(envelope, /# Task\n\nPrint the report\n\n# Task state\n\nThe previous chat grew too long \(\d+ characters\)/);
  assert.match(envelope, /"replies_used": 4,\n\s+"replies_left": 26/);
  assert.match(envelope, /"\[x\] Plan",\n\s+"\[ \] Print the parts"/);
  assert.match(envelope, /"decisions": \[\n\s+"Print in four parts"/);
  assert.match(envelope, /"call": "emit three",\n\s+"ok": true,\n\s+"result": "emitted three \/ … \//);
  assert.match(envelope, /# Last results\n\nTool results:\n\n\[1\] emit: ok\n```text\nemitted four\n/);
  assert.match(envelope, /\n```\n\nReply 4 of 30 used\. Continue/);
  assert.doesNotMatch(envelope, /emitted one\n/);
  assert.ok(envelope.length + 500 <= budgetChars, `envelope of ${envelope.length} characters`);
  assert.deepEqual(of('summarized'), []); // every result fitted whole, the last one in the envelope too

  assert.deepEqual(of('rollover').map((event) => [event.reason, event.chat, event.limit]), [['budget', 2, budgetChars]]);
  assert.ok(of('budget').every((event) => event.used <= budgetChars));
  const lines = await transcriptLines(transcript);
  assert.deepEqual(
    lines.filter((line) => line.event === 'rollover').map((line) => [line.reason, line.chat]),
    [['budget', 2]],
  );
  assert.deepEqual(lines.filter((line) => line.turn !== undefined).map((line) => line.chat), [1, 1, 1, 1, 2]);
  const { state } = await loadTaskState(transcript.dir);
  assert.equal(state.status, 'done');
  assert.equal(state.chats, 2);
  assert.deepEqual(state.rollovers.map((rollover) => rollover.reason), ['budget']);
  assert.equal(state.answer, 'All four printed.');
  await done();
});

test('many long results in one reply fit the budget: the envelope fits, and a chat holds more than one reply', async () => {
  const budgetChars = 30_000;
  const replyReserveChars = 1_000;
  const batch = Array.from({ length: 8 }, (_, i) => call('emit', { size: 5_500, id: `r${i}` })).join('\n');
  const { adapter, agent, of } = await setup([batch, batch, batch, batch, batch, 'Done.'], {
    context: { budgetChars, replyReserveChars },
  });
  // Which message opened each new chat: the envelope.
  const firsts: number[] = [];
  const newChat = adapter.newChat.bind(adapter);
  adapter.newChat = async () => {
    firsts.push(adapter.sent.length);
    await newChat();
  };
  const goal = `Print the logs.\n${'Context. '.repeat(600)}`; // 5 400 characters
  const result = await agent.run(goal);
  assert.equal(result.status, 'done');
  assert.equal(result.iterations, 6);
  assert.ok(firsts.length > 0, 'the budget should run out at least once');
  assert.ok(adapter.newChats <= 2, `${adapter.newChats} new chats for 6 replies`);
  for (const index of firsts) {
    const envelope = adapter.sent[index]?.message ?? '';
    assert.match(envelope, /^You are the mind of a coding agent[\s\S]*# Last results\n\nTool results:/);
    assert.match(envelope, /# Task\n\nPrint the logs\.\n[\s\S]*…\n\n\[The task was cut to 3000 characters to fit this chat\.\]/);
    assert.ok(envelope.length + replyReserveChars <= budgetChars, `envelope of ${envelope.length} characters`);
  }
  for (const event of of('budget')) assert.ok(event.used <= budgetChars, `chat ${event.chat}: ${event.used} > ${budgetChars}`);
  // The first results message kept the first result whole and cut the rest down.
  const second = adapter.sent[1]?.message ?? '';
  assert.match(second, /\[1\] emit: ok\n```text\nemitted r0\n/);
  assert.match(second, /\[8\] emit: ok\n```text\nemitted r7[\s\S]*this message was full/);
});

test('a new task in a full chat starts a new chat with the instructions', async () => {
  const steps = (): FakeStep[] => [call('emit', { size: 1_000 }), 'First done.', 'Second done.'];
  const { agent: probe } = await setup(steps());
  await probe.run('first');
  const budgetChars = probe.conversation.usedChars + 100; // too small for the follow-up message

  const { adapter, agent, of } = await setup(steps(), { context: { budgetChars, replyReserveChars: 0 } });
  await agent.run('first');
  assert.equal((await agent.run('second')).status, 'done');
  assert.equal(adapter.newChats, 1);
  assert.match(adapter.sent[2]?.message ?? '', /^You are the mind of a coding agent[\s\S]*# Task\n\nsecond$/);
  assert.deepEqual(of('rollover').map((event) => event.reason), ['budget']);
});

test('drift: replies with no valid call move the task to a new chat, then it goes on', async () => {
  const broken = tool('{"tool": "note", "args": {"text": "oops"}');
  const { adapter, agent, of, log } = await setup([broken, call('nope'), call('note', {}, 'fixed'), 'Done.']);
  const result = await agent.run('Write a note');
  assert.equal(result.status, 'done');
  assert.deepEqual(log, ['fixed\n']);
  assert.equal(adapter.newChats, 1);
  assert.deepEqual(of('drift').map((event) => event.count), [1, 2]);
  assert.deepEqual(of('rollover').map((event) => event.reason), ['drift']);
  const envelope = adapter.sent[2]?.message ?? '';
  assert.match(envelope, /did not follow the tool protocol/);
  assert.match(envelope, /# Last results\n\nTool results:\n\n\[1\] nope: error\n```text\nUnknown tool "nope"/);
});

test('drift that goes on after the new chat still stops the task', async () => {
  const broken = tool('not json at all');
  const { adapter, agent } = await setup([broken, broken, broken, 'never'], { maxMalformedReplies: 3 });
  const result = await agent.run('task');
  assert.equal(result.status, 'failed');
  assert.match(String(result.error), /malformed tool calls 3 times/);
  assert.equal(adapter.newChats, 1);
  assert.equal(adapter.remaining, 1);
});

test('a tool call written outside a tool block is not taken for the final answer', async () => {
  const { adapter, agent, of, log } = await setup([
    'Reading it now.\n{"tool": "note", "args": {"text": "hi"}}',
    call('note', { text: 'hi' }),
    'Done.',
  ]);
  const result = await agent.run('Write a note');
  assert.equal(result.status, 'done');
  assert.equal(result.iterations, 3);
  assert.deepEqual(log, ['hi']);
  assert.match(adapter.sent[1]?.message ?? '', /^Nothing was run: your reply has a JSON line that calls note, but no ```tool block\./);
  assert.deepEqual(of('drift').map((event) => event.detail), ['a JSON line that calls note']);
  // With the context features off, the same reply is a final answer, as before.
  const { agent: plain } = await setup(['Reading it now.\n{"tool": "note", "args": {"text": "hi"}}'], { context: false });
  assert.equal((await plain.run('Write a note')).status, 'done');
});

test("the provider's length limit moves the task to a new chat once; on a fresh chat it fails", async () => {
  const { adapter, agent, of } = await setup([call('note', { text: 'one' }), new AdapterError('limit', 'The chat is too long.'), 'Done.']);
  const result = await agent.run('Write a note');
  assert.equal(result.status, 'done');
  assert.equal(adapter.newChats, 1);
  assert.match(adapter.sent[2]?.message ?? '', /reached the provider's length limit[\s\S]*# Last results\n\nTool results:\n\n\[1\] note: ok\n```text\nnoted one/);
  assert.deepEqual(of('rollover').map((event) => event.reason), ['limit']);

  const fresh = await setup([new AdapterError('limit', 'Daily limit reached.'), 'never']);
  const failed = await fresh.agent.run('task');
  assert.equal(failed.status, 'failed');
  assert.equal(fresh.adapter.newChats, 0);
});

test('a saved task resumes in a new chat from its state file, and only in its workspace', async () => {
  const first = await session();
  const { agent } = await setup(
    [
      `${call('update_task', { decision: 'Notes go in NOTES.md' }, '- [x] Plan\n- [ ] Write the notes')}\n${call('note', { text: 'draft' })}`,
      call('note', { text: 'second draft' }),
      call('note', { text: 'never run' }),
    ],
    { transcript: first.transcript, maxIterations: 3 },
  );
  const stopped = await agent.run('Write the notes');
  assert.equal(stopped.status, 'max_iterations');
  const { state: saved, file } = await loadTaskState(first.transcript.dir);
  assert.equal(file, join(first.transcript.dir, TASK_STATE_FILE));
  assert.equal(saved.status, 'max_iterations');
  assert.equal(saved.iterations, 3);
  assert.deepEqual(saved.checklist, [
    { text: 'Plan', done: true },
    { text: 'Write the notes', done: false },
  ]);
  assert.deepEqual(saved.decisions, ['Notes go in NOTES.md']);
  // The call of the last reply never ran: the state says so, for the resume.
  assert.deepEqual(
    saved.recent.map((recent) => [recent.reply, recent.call, recent.ok, recent.result]),
    [
      [1, 'note draft', true, 'noted draft'],
      [2, 'note second draft', true, 'noted second draft'],
      [3, 'note never run', false, 'Not run: the task stopped (max_iterations) before it ran.'],
    ],
  );

  const second = await session();
  const resumed = await setup(
    [
      (message) => {
        assert.match(message, /^You are the mind of a coding agent/);
        assert.match(message, /# Task\n\nWrite the notes\n\n# Task state\n\nThe task stopped earlier \(max_iterations\) and is resumed/);
        assert.match(message, /"\[ \] Write the notes"/);
        assert.match(message, /"Notes go in NOTES\.md"/);
        assert.match(message, /"result": "noted second draft"/);
        assert.match(message, /"call": "note never run",\n\s+"ok": false,\n\s+"result": "Not run: the task stopped \(max_iterations\)/);
        assert.match(message, /# Last results\n\nNone in this chat yet/);
        return call('note', { text: 'final' });
      },
      'Notes written.',
    ],
    { transcript: second.transcript },
  );
  const result = await resumed.agent.resume(saved, undefined, file);
  assert.equal(result.status, 'done');
  assert.equal(result.iterations, 2);
  assert.deepEqual(resumed.log, ['final']);
  assert.equal(resumed.adapter.newChats, 0); // a fresh agent is already on a new chat
  assert.equal(resumed.of('resume').length, 1);

  const { state } = await loadTaskState(second.transcript.dir);
  assert.equal(state.status, 'done');
  assert.equal(state.runs, 2);
  assert.equal(state.iterations, 5);
  assert.equal(state.resumedFrom, file);
  const lines = await transcriptLines(second.transcript);
  assert.equal(lines[0]?.event, 'resume');

  // A primed agent opens a new chat first; another workspace is refused.
  const again = await setup(['ok', 'resumed']);
  await again.agent.run('warm up');
  await again.agent.resume(saved);
  assert.equal(again.adapter.newChats, 1);
  const elsewhere = await setup(['never'], { root: resolve(tmpdir(), 'another-workspace') });
  await assert.rejects(elsewhere.agent.resume(saved), /That task ran in .*resume it with --workspace/);
  assert.equal(elsewhere.adapter.sent.length, 0);
  await first.done();
  await second.done();
});

test('edit_file needs the file read (or written) in the same conversation', async () => {
  const base = await mkdtemp(join(tmpdir(), 'agent-gate-'));
  const root = join(base, 'workspace');
  await mkdir(root);
  await writeFile(join(root, 'app.py'), 'def greet():\n    return "hi"\n');
  const edit = (from: string, to: string): string => call('edit_file', { path: 'app.py' }, `<<<<<<< SEARCH\n${from}\n=======\n${to}\n>>>>>>> REPLACE`);
  const broken = tool('{"tool": "read_file"');
  const adapter = new FakeAdapter([
    edit('    return "hi"', '    return "hello"'),
    call('read_file', { path: './app.py' }),
    edit('    return "hi"', '    return "hello"'),
    broken,
    broken,
    edit('    return "hello"', '    return "hey"'), // a new chat: read it again first
    call('read_file', { path: 'app.py' }),
    edit('    return "hello"', '    return "hey"'),
    `${call('write_file', { path: 'new.py' }, 'x = 1')}\n${edit('x = 1', 'x = 2').replace('app.py', 'new.py')}`,
    'Done.',
  ]);
  await adapter.open();
  const events: AgentEvent[] = [];
  const agent = new Agent({ adapter, toolbox: new Toolbox(nativeTools({ root })), root, onEvent: (event) => events.push(event) });
  const result = await agent.run('Change the greeting');
  assert.equal(result.status, 'done');
  assert.equal(await readFile(join(root, 'app.py'), 'utf8'), 'def greet():\n    return "hey"\n');
  assert.equal(await readFile(join(root, 'new.py'), 'utf8'), 'x = 2\n');
  assert.match(adapter.sent[1]?.message ?? '', /\[1\] edit_file: error\n```text\nNot run: app\.py was not read in this conversation/);
  assert.match(adapter.sent[6]?.message ?? '', /\[1\] edit_file: error\n```text\nNot run: app\.py was not read/);
  assert.equal(events.filter((event) => event.type === 'gated').length, 2);
  assert.equal(result.toolCalls, 6); // the refused edits never reached the toolbox

  // The gate is off with the context features.
  await writeFile(join(root, 'app.py'), 'a\n');
  const plain = new FakeAdapter([edit('a', 'b'), 'Done.']);
  await plain.open();
  await new Agent({ adapter: plain, toolbox: new Toolbox(nativeTools({ root })), root, context: false }).run('Edit');
  assert.equal(await readFile(join(root, 'app.py'), 'utf8'), 'b\n');
  await rm(base, { recursive: true, force: true });
});

test('update_task is offered with its rule; context: false offers neither', async () => {
  const { adapter, agent } = await setup([call('update_task', {}, '- [ ] one'), 'ok']);
  await agent.run('task');
  const first = adapter.sent[0]?.message ?? '';
  assert.match(first, /\n9\. Keep your plan current with update_task\./);
  assert.match(first, /## update_task\nKeeps your plan/);
  assert.match(adapter.sent[1]?.message ?? '', /\[1\] update_task: ok\n```text\nSaved: 0 of 1 steps done, 0 decisions\./);
  assert.deepEqual(agent.state?.checklist, [{ text: 'one', done: false }]);

  const plain = await setup([call('update_task', {}, '- [ ] one'), 'ok'], { context: false });
  await plain.agent.run('task');
  assert.doesNotMatch(plain.adapter.sent[0]?.message ?? '', /update_task|\n9\. /);
  assert.match(plain.adapter.sent[1]?.message ?? '', /Unknown tool "update_task"/);
});
