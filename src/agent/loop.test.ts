import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FakeAdapter, type FakeStep } from '../adapters/fake/index.js';
import { AdapterError } from '../core/adapter.js';
import { Transcript } from '../core/transcript.js';
import { nativeTools } from '../tools/native.js';
import { Toolbox } from '../tools/toolbox.js';
import type { Tool } from '../tools/types.js';
import { Agent, type AgentEvent, type AgentOptions } from './loop.js';
import { REPEAT_REQUEST } from './prompt.js';

const tool = (block: string): string => `\`\`\`tool\n${block}\n\`\`\``;

/** A tool that records its calls; "fail" in the text makes it fail. */
function noteTool(log: string[]): Tool {
  return {
    name: 'note',
    description: 'Writes a note.',
    params: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    body: 'text',
    run: async (args) => {
      log.push(String(args.text));
      return String(args.text).includes('fail') ? { ok: false, text: 'could not' } : { ok: true, text: `noted ${String(args.text)}` };
    },
  };
}

async function setup(steps: FakeStep[], options: Partial<AgentOptions> = {}) {
  const adapter = new FakeAdapter(steps);
  await adapter.open();
  const log: string[] = [];
  const events: AgentEvent[] = [];
  const delays: number[] = [];
  const agent = new Agent({
    adapter,
    toolbox: new Toolbox([noteTool(log)]),
    root: '/work',
    sleep: async (ms) => {
      delays.push(ms);
    },
    onEvent: (event) => events.push(event),
    ...options,
  });
  return { adapter, agent, log, events, delays };
}

test('a reply without tool blocks ends the task at once', async () => {
  const { adapter, agent } = await setup(['Hello! Nothing to do.']);
  const result = await agent.run('Say hello');
  assert.deepEqual(result, { status: 'done', answer: 'Hello! Nothing to do.', iterations: 1, toolCalls: 0, pending: 0 });
  const first = adapter.sent[0]?.message ?? '';
  assert.match(first, /# Calling tools/);
  assert.match(first, /## note\nWrites a note\.\nArguments:\n- text \(string, required, text after the JSON line\)/);
  assert.match(first, /workspace folder, \/work/);
  assert.match(first, /# Task\n\nSay hello$/);
});

test('tool calls run in order and their results go back in one message', async () => {
  const { adapter, agent, log } = await setup([
    `I'll write two notes.\n${tool('{"tool": "note", "args": {"text": "one"}}')}\n${tool('{"tool": "note"}\ntwo, fail')}`,
    'Done: wrote two notes, the second failed.',
  ]);
  const result = await agent.run('Write notes');
  assert.equal(result.status, 'done');
  assert.equal(result.iterations, 2);
  assert.equal(result.toolCalls, 2);
  assert.deepEqual(log, ['one', 'two, fail\n']);
  assert.equal(
    adapter.sent[1]?.message,
    'Tool results:\n\n[1] note: ok\n```text\nnoted one\n```\n\n[2] note: error\n```text\ncould not\n```\n\n' +
      'Reply 1 of 30 used. Continue with more tool blocks, or reply without any tool block when the task is done.',
  );
});

test('busy: the same message is sent again after growing waits', async () => {
  const busy = (): AdapterError => new AdapterError('busy', 'server is busy');
  const { adapter, agent, delays, events } = await setup([busy(), busy(), 'ok'], {
    retry: { attempts: 3, baseDelayMs: 1_000, maxDelayMs: 1_500 },
  });
  const result = await agent.run('task');
  assert.equal(result.status, 'done');
  assert.deepEqual(delays, [1_000, 1_500]);
  assert.equal(adapter.sent.length, 3);
  assert.equal(adapter.sent[2]?.message, adapter.sent[0]?.message);
  assert.equal(events.filter((event) => event.type === 'retry').length, 2);
});

test('busy too many times: the task fails with the adapter error', async () => {
  const busy = (): AdapterError => new AdapterError('busy', 'server is busy');
  const { agent, delays } = await setup([busy(), busy(), busy()], { retry: { attempts: 2, baseDelayMs: 10, maxDelayMs: 100 } });
  const result = await agent.run('task');
  assert.equal(result.status, 'failed');
  assert.ok(result.error instanceof AdapterError && result.error.kind === 'busy');
  assert.deepEqual(delays, [10, 20]);
});

test('no retry when the wait would pass the time limit', async () => {
  const { agent, delays } = await setup([new AdapterError('busy', 'busy'), 'ok'], {
    now: () => 0,
    maxDurationMs: 5_000,
    retry: { attempts: 3, baseDelayMs: 10_000, maxDelayMs: 10_000 },
  });
  const result = await agent.run('task');
  assert.equal(result.status, 'failed');
  assert.deepEqual(delays, []);
});

test('an unreadable reply is asked again, not the same message', async () => {
  const { adapter, agent } = await setup([new AdapterError('empty', 'unreadable'), 'Done.']);
  const result = await agent.run('task');
  assert.equal(result.status, 'done');
  assert.equal(adapter.sent[1]?.message, REPEAT_REQUEST);
});

test('errors that need the user are not retried', async () => {
  for (const kind of ['limit', 'send_failed', 'closed', 'timeout', 'provider'] as const) {
    const { adapter, agent } = await setup([new AdapterError(kind, kind), 'never']);
    const result = await agent.run('task');
    assert.equal(result.status, 'failed', kind);
    assert.equal(adapter.sent.length, 1, kind);
  }
});

test('the iteration limit stops the loop and leaves the last calls unrun', async () => {
  const again = tool('{"tool": "note", "args": {"text": "again"}}');
  const { adapter, agent, log } = await setup([again, again, again, again], { maxIterations: 3 });
  const result = await agent.run('loop forever');
  assert.equal(result.status, 'max_iterations');
  assert.equal(result.iterations, 3);
  assert.equal(result.pending, 1);
  assert.equal(log.length, 2);
  assert.equal(adapter.remaining, 1);
  assert.match(adapter.sent[0]?.message ?? '', /at most 3 replies/);
});

test('the time limit is checked between turns', async () => {
  let clock = 0;
  const step = (): string => {
    clock += 40_000;
    return tool('{"tool": "note", "args": {"text": "slow"}}');
  };
  const { agent, log } = await setup([step, step, step], { now: () => clock, maxDurationMs: 100_000 });
  const result = await agent.run('slow task');
  assert.equal(result.status, 'timeout');
  assert.equal(result.iterations, 3);
  assert.equal(log.length, 2);
});

test('a malformed block holds the calls after it; the fix goes through', async () => {
  const { adapter, agent, log, events } = await setup([
    [
      tool('{"tool": "note", "args": {"text": "before"}}'),
      tool('{"tool": "note", "args": {"text": "broken"}'),
      tool('{"tool": "note", "args": {"text": "after"}}'),
    ].join('\n'),
    tool('{"tool": "note", "args": {"text": "fixed"}}'),
    'All good.',
  ]);
  const result = await agent.run('task');
  assert.equal(result.status, 'done');
  assert.deepEqual(log, ['before', 'fixed']);
  const second = adapter.sent[1]?.message ?? '';
  assert.match(second, /\[2\] \?: error\n```text\nThe JSON line is not closed/);
  assert.match(second, /\[3\] note: error\n```text\nNot run: block 2 is malformed/);
  assert.match(second, /send them again, fixed/);
  assert.equal(events.filter((event) => event.type === 'malformed').length, 1);
});

test('a model that only writes malformed calls is stopped', async () => {
  const broken = tool('not json at all');
  const { agent } = await setup([broken, broken, broken, 'never'], { maxMalformedReplies: 3 });
  const result = await agent.run('task');
  assert.equal(result.status, 'failed');
  assert.match(String(result.error), /malformed tool calls 3 times/);
});

test('unknown tools and bad arguments go back to the model as errors', async () => {
  const { adapter, agent } = await setup([
    `${tool('{"tool": "nope", "args": {}}')}\n${tool('{"tool": "note", "args": {}}')}`,
    'ok',
  ]);
  await agent.run('task');
  const second = adapter.sent[1]?.message ?? '';
  assert.match(second, /\[1\] nope: error\n```text\nUnknown tool "nope". Available tools: note\./);
  assert.match(second, /\[2\] note: error\n```text\nMissing arguments for note: text\./);
});

test('a content-filtered answer stops the task', async () => {
  const { agent } = await setup([{ text: 'Sorry, that is beyond my scope.', filtered: true }]);
  assert.equal((await agent.run('task')).status, 'filtered');
});

test('later tasks continue the conversation; after reset the instructions come again', async () => {
  const { adapter, agent } = await setup(['one', 'two', 'three']);
  await agent.run('first');
  await agent.run('second');
  agent.reset();
  await agent.run('third');
  const [first, second, third] = adapter.sent.map((sent) => sent.message);
  assert.match(first ?? '', /# Calling tools/);
  assert.doesNotMatch(second ?? '', /# Calling tools/);
  assert.match(second ?? '', /^New task from the user\..*# Task\n\nsecond$/s);
  assert.match(third ?? '', /# Calling tools/);
});

test('stopping during a tool call skips the rest and ends the task', async () => {
  const controller = new AbortController();
  const adapter = new FakeAdapter([
    `${tool('{"tool": "stop", "args": {}}')}\n${tool('{"tool": "stop", "args": {}}')}`,
    'never',
  ]);
  await adapter.open();
  let runs = 0;
  const stopper: Tool = {
    name: 'stop',
    description: 'Stops the agent.',
    params: { type: 'object' },
    run: async () => {
      runs += 1;
      controller.abort();
      return { ok: true, text: 'stopping' };
    },
  };
  const agent = new Agent({ adapter, toolbox: new Toolbox([stopper]), root: '/work' });
  const result = await agent.run('task', controller.signal);
  assert.equal(result.status, 'aborted');
  assert.equal(runs, 1);
  assert.equal(adapter.sent.length, 1);
});

test('end to end with the native tools and a transcript on disk', async () => {
  const base = await mkdtemp(join(tmpdir(), 'agent-loop-'));
  const root = join(base, 'workspace');
  await mkdir(root);
  await writeFile(join(root, 'app.py'), 'def greet():\n    return "hi"\n');
  const adapter = new FakeAdapter([
    'Let me read it.\n' + tool('{"tool": "read_file", "args": {"path": "app.py"}}'),
    (message) => {
      assert.match(message, /\[1\] read_file: ok\n```text\ndef greet\(\):/);
      return [
        'Now the change and a test file:',
        tool('{"tool": "edit_file", "args": {"path": "app.py"}}\n<<<<<<< SEARCH\n    return "hi"\n=======\n    return "hello"\n>>>>>>> REPLACE'),
        '````tool\n{"tool": "write_file", "args": {"path": "NOTES.md"}}\nRun:\n```\npython app.py\n```\n````',
        tool('{"tool": "run_command", "args": {"command": "echo checked"}}'),
      ].join('\n');
    },
    'Changed greet() to return "hello" and added NOTES.md.',
  ]);
  await adapter.open();
  const transcript = await Transcript.create(base, adapter.name);
  const approvals: string[] = [];
  const agent = new Agent({
    adapter,
    toolbox: new Toolbox(nativeTools({ root }), {
      approve: async (request) => {
        approvals.push(request.summary);
        return { approved: true };
      },
    }),
    root,
    transcript,
  });
  const result = await agent.run('Make greet say hello');
  assert.equal(result.status, 'done');
  assert.equal(result.toolCalls, 4);
  assert.equal(await readFile(join(root, 'app.py'), 'utf8'), 'def greet():\n    return "hello"\n');
  assert.equal(await readFile(join(root, 'NOTES.md'), 'utf8'), 'Run:\n```\npython app.py\n```\n');
  assert.deepEqual(approvals, [`run in ${root}:\necho checked`]);
  assert.match(adapter.sent[2]?.message ?? '', /\[3\] run_command: ok\n```text\n\[exit code 0\]\nchecked\n```/);

  const lines = (await readFile(join(transcript.dir, 'transcript.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(
    lines.map((line) => line.event ?? `turn ${line.turn}`),
    ['task', 'turn 1', 'tool_call', 'turn 2', 'tool_call', 'tool_call', 'tool_call', 'turn 3', 'task_end'],
  );
  assert.equal(lines.at(-1).status, 'done');
  await rm(base, { recursive: true, force: true });
});

test('FakeAdapter scripts load from JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-fake-'));
  const file = join(dir, 'script.json');
  await writeFile(file, JSON.stringify(['first', { error: 'busy', message: 'later' }, { text: 'third', thinking: 'hm' }]));
  const adapter = await FakeAdapter.fromFile(file);
  await adapter.open();
  assert.equal((await adapter.send('a')).text, 'first');
  await assert.rejects(adapter.send('b'), (error) => error instanceof AdapterError && error.kind === 'busy');
  assert.equal((await adapter.send('c')).thinking, 'hm');
  await assert.rejects(adapter.send('d'), /no scripted reply left/);
  await rm(dir, { recursive: true });
});
