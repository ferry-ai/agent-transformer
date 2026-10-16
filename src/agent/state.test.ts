import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  findLatestTaskState,
  loadTaskState,
  newTaskState,
  noteCall,
  parseChecklist,
  saveTaskState,
  STATE_LIMITS,
  TASK_STATE_FILE,
  taskTool,
  workspacePath,
  type TaskState,
} from './state.js';

const root = resolve(tmpdir(), 'agent-state-root');

test('checklists: "- [x]" steps are done, plain lines and "- [ ]" are not', () => {
  assert.deepEqual(parseChecklist('- [x] Read app.py\n- [ ] Change greet()\n\n* [X] Plan\n1. [ ] Test\nWrite notes\n- Ship it'), [
    { text: 'Read app.py', done: true },
    { text: 'Change greet()', done: false },
    { text: 'Plan', done: true },
    { text: 'Test', done: false },
    { text: 'Write notes', done: false },
    { text: 'Ship it', done: false },
  ]);
  const long = parseChecklist(Array.from({ length: 60 }, (_, i) => `- [ ] step ${i} ${'x'.repeat(400)}`).join('\n'));
  assert.equal(long.length, STATE_LIMITS.steps);
  assert.ok(long.every((item) => item.text.length <= STATE_LIMITS.step));
});

test('paths are listed relative to the workspace, with "/" and no "./"', () => {
  assert.equal(workspacePath('./src/app.py', root), 'src/app.py');
  assert.equal(workspacePath('src//lib/../app.py', root), 'src/app.py');
  assert.equal(workspacePath(join(root, 'src', 'app.py'), root), 'src/app.py');
  assert.equal(workspacePath('', root), '.');
  // As the path policy resolves them: nothing trimmed, a backslash is a separator on Windows only.
  assert.equal(workspacePath(' app.py', root), ' app.py');
  assert.equal(workspacePath('src\\app.py', root), process.platform === 'win32' ? 'src/app.py' : 'src\\app.py');
  assert.equal(workspacePath('../other/app.py', root), resolve(root, '../other/app.py').replace(/\\/g, '/'));
  assert.equal(workspacePath('..app.py', root), '..app.py');
});

test('calls fill the lists of files and the recent results; update_task is not a result', () => {
  const state = newTaskState('  Fix it  ', root, 0);
  assert.equal(state.goal, 'Fix it');
  noteCall(state, 1, { index: 1, tool: 'read_file', args: { path: './a.py' } }, { ok: true, text: 'line 1\nline 2\nline 3' }, root);
  noteCall(state, 1, { index: 2, tool: 'read_file', args: { path: 'missing.py' } }, { ok: false, text: 'missing.py does not exist.' }, root);
  noteCall(state, 2, { index: 1, tool: 'edit_file', args: { path: 'a.py' } }, { ok: true, text: 'Edited a.py: 1 change.' }, root);
  noteCall(state, 2, { index: 2, tool: 'run_command', args: { command: 'npm test\n' } }, { ok: false, text: '[exit code 1]\nFAIL' }, root);
  noteCall(state, 3, { index: 1, tool: 'update_task', args: { checklist: '- [ ] x' } }, { ok: true, text: 'Saved' }, root);
  assert.deepEqual(state.files, { read: ['a.py'], changed: ['a.py'] });
  assert.deepEqual(
    state.recent.map((call) => [call.reply, call.call, call.ok, call.result]),
    [
      [1, 'read_file ./a.py', true, 'line 1 / … / line 3'],
      [1, 'read_file missing.py', false, 'missing.py does not exist.'],
      [2, 'edit_file a.py', true, 'Edited a.py: 1 change.'],
      [2, 'run_command npm test', false, '[exit code 1] / FAIL'],
    ],
  );
  for (let i = 0; i < 20; i += 1) noteCall(state, 4, { index: i, tool: 'list_dir', args: {} }, { ok: true, text: `${i}` }, root);
  assert.equal(state.recent.length, STATE_LIMITS.recent);
  assert.equal(state.recent.at(-1)?.result, '19');
});

test('update_task replaces the checklist and adds decisions, within limits', async () => {
  const state = newTaskState('task', root, 0);
  const tool = taskTool(() => state);
  const context = { confirm: async () => undefined };
  await assert.rejects(tool.run({}, context), /Nothing to save/);
  const saved = await tool.run({ checklist: '- [x] one\n- [ ] two\n', decision: 'Use  pytest,\nnot unittest' }, context);
  assert.deepEqual(saved, { ok: true, text: 'Saved: 1 of 2 steps done, 1 decision.' });
  assert.deepEqual(state.decisions, ['Use pytest, not unittest']);
  await tool.run({ checklist: '- [x] one\n- [x] two' }, context);
  assert.equal(state.checklist.filter((item) => item.done).length, 2);
  for (let i = 0; i < 30; i += 1) await tool.run({ decision: `d${i}` }, context);
  assert.equal(state.decisions.length, STATE_LIMITS.decisions);
  assert.equal(state.decisions.at(-1), 'd29');
  await assert.rejects(taskTool(() => undefined).run({ decision: 'x' }, context), /No task is running/);
});

test('the state file round-trips, from the file or its session folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-state-'));
  const state = newTaskState('Make greet say hello', root, Date.UTC(2026, 9, 15));
  state.checklist = [{ text: 'Read app.py', done: true }];
  state.decisions = ['Keep the old name'];
  state.status = 'max_iterations';
  const file = await saveTaskState(join(dir, 'session'), state);
  assert.equal(file, join(dir, 'session', TASK_STATE_FILE));
  assert.deepEqual((await loadTaskState(file)).state, state);
  assert.deepEqual((await loadTaskState(join(dir, 'session'))).state, state);
  // Saved again over the old file.
  state.iterations = 5;
  await saveTaskState(join(dir, 'session'), state);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).iterations, 5);
  await rm(dir, { recursive: true, force: true });
});

test('a state file is checked before it is trusted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-state-'));
  const file = join(dir, TASK_STATE_FILE);
  const good: TaskState = newTaskState('goal', root, 0);
  const write = async (value: unknown): Promise<void> => writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));

  await write('{not json');
  await assert.rejects(loadTaskState(file), /not a task state/);
  await write({ ...good, version: 2 });
  await assert.rejects(loadTaskState(file), /version 2/);
  await write({ ...good, goal: '' });
  await assert.rejects(loadTaskState(file), /goal is empty/);
  await write({ ...good, decisions: [1, 2] });
  await assert.rejects(loadTaskState(file), /"decisions" must be a list of strings/);
  await write({ ...good, iterations: -1 });
  await assert.rejects(loadTaskState(file), /"iterations" must be a count/);
  await write({ ...good, status: '\u001b[2Jdone' });
  await assert.rejects(loadTaskState(file), /unknown status/);

  // Oversized model-written parts are capped on the way in.
  await write({ ...good, checklist: [{ text: 'x'.repeat(5_000), done: true }, { nope: 1 }], decisions: Array(50).fill('d') });
  const { state } = await loadTaskState(file);
  assert.equal(state.checklist.length, 1);
  assert.equal(state.checklist[0]?.text.length, STATE_LIMITS.step);
  assert.equal(state.decisions.length, STATE_LIMITS.decisions);
  await rm(dir, { recursive: true, force: true });
});

test('the latest saved task is the most recently updated one', async () => {
  const sessions = await mkdtemp(join(tmpdir(), 'agent-sessions-'));
  assert.equal(await findLatestTaskState(join(sessions, 'none')), undefined);
  assert.equal(await findLatestTaskState(sessions), undefined);
  const older = await saveTaskState(join(sessions, '2026-10-15-10-00-00-fake'), newTaskState('older', root, 0));
  const newer = await saveTaskState(join(sessions, '2026-10-14-10-00-00-fake'), newTaskState('newer', root, 0));
  await mkdir(join(sessions, 'empty-session'));
  await utimes(older, new Date(2026, 0, 1), new Date(2026, 0, 1));
  await utimes(newer, new Date(2026, 5, 1), new Date(2026, 5, 1));
  assert.equal(await findLatestTaskState(sessions), newer);
  await rm(sessions, { recursive: true, force: true });
});
