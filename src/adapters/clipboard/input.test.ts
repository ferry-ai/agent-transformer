import assert from 'node:assert/strict';
import { createInterface } from 'node:readline/promises';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { readlineInput } from './input.js';

/** A readline like the agent CLI's, on fake streams instead of the terminal. */
function terminal() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let shown = '';
  stdout.on('data', (chunk: Buffer) => {
    shown += chunk.toString('utf8');
  });
  const rl = createInterface({ input: stdin, output: stdout, terminal: false });
  rl.setPrompt('task> ');
  return { rl, stdin, shown: () => shown };
}

const tick = (): Promise<void> => new Promise((done) => setImmediate(done));

test('no line of a paste is lost between two reads', async () => {
  const { rl, stdin, shown } = terminal();
  const session = readlineInput(rl).listen();
  const first = session.next('reply 1> ');
  stdin.write('one\ntwo\nthree\n');
  assert.deepEqual(await first, { kind: 'line', text: 'one' });
  assert.deepEqual(await session.next('… '), { kind: 'line', text: 'two' });
  assert.deepEqual(await session.next('… '), { kind: 'line', text: 'three' });
  assert.match(shown(), /reply 1> /);
  assert.doesNotMatch(shown(), /… /, 'no prompt while lines are waiting');
  session.close();
  rl.close();
});

test('drain swallows the rest of a paste, so it cannot answer a later question', async () => {
  const { rl, stdin } = terminal();
  const input = readlineInput(rl, { quietMs: 30 });
  const session = input.listen();
  const first = session.next('reply 1> ');
  stdin.write('[[end of reply 1]]\ny\n');
  assert.deepEqual(await first, { kind: 'line', text: '[[end of reply 1]]' });
  setTimeout(() => stdin.write('yes\n'), 5);
  assert.deepEqual(await session.drain(), ['y', 'yes']);
  session.close();

  // The CLI's prompt is back, and its next question gets the next line typed.
  assert.equal(rl.getPrompt(), 'task> ');
  const answer = rl.question('Allow? ');
  stdin.write('n\n');
  assert.equal(await answer, 'n');
  rl.close();
});

test('lines typed when no session listens are not kept for the next one', async () => {
  const { rl, stdin } = terminal();
  const input = readlineInput(rl);
  stdin.write('\n');
  await tick();
  const session = input.listen();
  const next = session.next('reply 1> ');
  stdin.write('later\n');
  assert.deepEqual(await next, { kind: 'line', text: 'later' });
  session.close();
  rl.close();
});

test('Ctrl+C interrupts, the end of the input closes', async () => {
  const { rl } = terminal();
  const input = readlineInput(rl);
  const session = input.listen();
  const interrupted = session.next('reply 1> ');
  rl.emit('SIGINT');
  assert.deepEqual(await interrupted, { kind: 'interrupt' });
  const closed = session.next('reply 1> ');
  rl.close();
  assert.deepEqual(await closed, { kind: 'closed' });
  assert.deepEqual(await session.next('reply 1> '), { kind: 'closed' });
  session.close();
  assert.deepEqual(await input.listen().next('reply 2> '), { kind: 'closed' });
});

test('closing a session wakes a pending read', async () => {
  const { rl } = terminal();
  const session = readlineInput(rl).listen();
  const pending = session.next('reply 1> ');
  session.close();
  assert.deepEqual(await pending, { kind: 'closed' });
  assert.equal(rl.listenerCount('SIGINT'), 0);
  rl.close();
});
