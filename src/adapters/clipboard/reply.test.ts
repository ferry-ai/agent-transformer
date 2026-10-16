import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkReply, framePrompt, hasOpenFence, markerOf, promptBegin, promptEnd, replyEnd } from './reply.js';

const prompt = framePrompt('Fix the test', 2);

test('a prompt sits between its markers and asks for the end line', () => {
  const lines = prompt.split('\n');
  assert.equal(lines[0], promptBegin(2));
  assert.equal(lines[1], 'Fix the test');
  assert.equal(lines.at(-1), promptEnd(2));
  assert.match(lines.at(-2) ?? '', /outside any code block.*\[\[end of reply 2\]\]\)$/);
  // The instruction names the end line, but is not one itself.
  assert.equal(markerOf(lines.at(-2) ?? ''), undefined);
});

test('markers are found through Markdown, escapes and case', () => {
  assert.deepEqual(markerOf('[[end of reply 3]]'), { kind: 'end', turn: 3 });
  assert.deepEqual(markerOf('  `[[end of reply 3]]`  '), { kind: 'end', turn: 3 });
  assert.deepEqual(markerOf('**[[End Of Reply 3]]**'), { kind: 'end', turn: 3 });
  assert.deepEqual(markerOf('> \\[\\[end of reply 3\\]\\]'), { kind: 'end', turn: 3 });
  assert.deepEqual(markerOf('`[[end of reply 3]]`.'), { kind: 'end', turn: 3 });
  assert.deepEqual(markerOf('[[end]]'), { kind: 'end' });
  assert.deepEqual(markerOf('[[agent-transformer prompt 7 begin]]'), { kind: 'prompt', turn: 7, edge: 'begin' });
  assert.deepEqual(markerOf('[[agent-transformer prompt 7 end]]'), { kind: 'prompt', turn: 7, edge: 'end' });
  assert.equal(markerOf('The reply ends with [[end of reply 3]]'), undefined);
  assert.equal(markerOf('[[end of reply]] and more'), undefined);
});

test('a complete reply passes, without its end line', () => {
  assert.deepEqual(checkReply('Done.\r\n\r\n[[end of reply 2]]\r\n', 2, prompt), { ok: true, text: 'Done.' });
  assert.deepEqual(checkReply('﻿Done.\n[[end]]', 2, prompt), { ok: true, text: 'Done.' });
  const call = '```tool\n{"tool": "read_file", "args": {"path": "a.py"}}\n```';
  assert.deepEqual(checkReply(`Reading.\n\n${call}\n[[end of reply 2]]`, 2, prompt), { ok: true, text: `Reading.\n\n${call}` });
});

test('text after the end line is left out, and said so', () => {
  const checked = checkReply('Done.\n[[end of reply 2]]\ny\nyes', 2, prompt);
  assert.deepEqual(checked, { ok: true, text: 'Done.', note: 'Left out 2 lines after the end line.' });
});

test('the prompt itself is refused, with nothing to accept', () => {
  const checked = checkReply(prompt.replace(/\n/g, '\r\n'), 2, prompt);
  assert.equal(checked.ok, false);
  assert.match(!checked.ok ? checked.problem : '', /still holds the prompt/);
  assert.equal(!checked.ok ? checked.text : 'x', undefined);
  const empty = checkReply('  \n', 2, prompt);
  assert.equal(empty.ok, false);
  assert.equal(!empty.ok ? empty.text : 'x', undefined);
});

test('a prompt copied back from the chat is recognised by its markers', () => {
  // As the chat shows the user's message: trailing spaces, a lost blank line.
  const copied = prompt.replace('Fix the test\n\n', 'Fix the test  \n');
  const checked = checkReply(copied, 2, prompt);
  assert.equal(checked.ok, false);
  assert.match(!checked.ok ? checked.problem : '', /This is a prompt/);
  // An older prompt too, and a prompt cut off before its end line.
  assert.equal(checkReply(framePrompt('Older', 1), 2, prompt).ok, false);
  const cut = checkReply(prompt.split('\n').slice(0, 2).join('\n'), 2, prompt);
  assert.equal(cut.ok, false);
  assert.match(!cut.ok ? cut.problem : '', /This is a prompt/);
});

test('a prompt copied together with its reply is refused; /accept would take the reply part', () => {
  const checked = checkReply(`${prompt}\n\nDone.\n[[end of reply 2]]`, 2, prompt);
  assert.equal(checked.ok, false);
  assert.match(!checked.ok ? checked.problem : '', /holds a prompt as well as the reply/);
  assert.equal(!checked.ok ? checked.text : undefined, 'Done.\n[[end of reply 2]]');
});

test('a reply may quote or edit prompt marker lines', () => {
  const quoting = 'The comment reads:\n> [[agent-transformer prompt 3 end]]\nSo I keep it.';
  assert.deepEqual(checkReply(`${quoting}\n[[end of reply 2]]`, 2, prompt), { ok: true, text: quoting });
  // A write_file of reply.ts: its doc comment has whole marker lines.
  const edit = [
    '```tool',
    '{"tool": "write_file", "args": {"path": "src/adapters/clipboard/reply.ts", "content": "/**',
    ' *   [[agent-transformer prompt 3 begin]]',
    ' *   ...the message...',
    ' *   [[agent-transformer prompt 3 end]]',
    ' */"}}',
    '```',
  ].join('\n');
  assert.deepEqual(checkReply(`Updating it.\n${edit}\n[[end of reply 2]]`, 2, prompt), { ok: true, text: `Updating it.\n${edit}` });
});

test('a reply cut off is refused, and /accept may still take it', () => {
  const cut = 'Let me read it.\n\n```tool\n{"tool": "read_file", "args": {"path": "a.py"}}';
  const open = checkReply(cut, 2, prompt);
  assert.equal(open.ok, false);
  assert.match(!open.ok ? open.problem : '', /not closed/);
  assert.equal(!open.ok ? open.text : undefined, cut);

  const unmarked = checkReply('All done, nothing else to change.', 2, prompt);
  assert.equal(unmarked.ok, false);
  assert.match(!unmarked.ok ? unmarked.problem : '', /does not end with \[\[end of reply 2\]\]/);
  assert.equal(!unmarked.ok ? unmarked.text : undefined, 'All done, nothing else to change.');

  const onlyEnd = checkReply(replyEnd(2), 2, prompt);
  assert.equal(onlyEnd.ok, false);
  assert.match(!onlyEnd.ok ? onlyEnd.problem : '', /empty/);
});

test('the reply to another prompt is refused', () => {
  const checked = checkReply('Old answer.\n[[end of reply 1]]', 2, prompt);
  assert.equal(checked.ok, false);
  assert.match(!checked.ok ? checked.problem : '', /reply to prompt 1, not to prompt 2/);
  assert.equal(!checked.ok ? checked.text : undefined, 'Old answer.');
});

test('open fences are read as the protocol reads them', () => {
  assert.equal(hasOpenFence('```python\nprint(1)\n```'), false);
  assert.equal(hasOpenFence('```python\nprint(1)'), true);
  assert.equal(hasOpenFence('````tool\n{"tool": "w"}\n```\nnested\n```\n````'), false);
  assert.equal(hasOpenFence('~~~\ncode\n~~~'), false);
  assert.equal(hasOpenFence('Inline ```code``` is not a fence.'), false);
  // Inside a tool block, ```python opens a nested block whose ``` does not close the tool block.
  assert.equal(hasOpenFence('```tool\n{"tool": "w"}\n```python\nx = 1\n```\n```'), false);
  assert.equal(hasOpenFence('```tool\n{"tool": "w"}\n```python\nx = 1\n```'), true);
});
