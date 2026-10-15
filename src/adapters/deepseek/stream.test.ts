import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCompletionStream } from './stream.js';

const data = (payload: unknown): string => `data: ${JSON.stringify(payload)}`;
const named = (event: string, payload: unknown): string => `event: ${event}\n${data(payload)}`;
const stream = (...events: string[]): string => events.join('\n\n') + '\n\n';

test('older builds: content with continuations and a BATCH status', () => {
  const reply = parseCompletionStream(
    stream(
      data({ v: { response: { message_id: 2, content: '', thinking_content: null, status: 'WIP' } } }),
      data({ p: 'response/content', o: 'APPEND', v: 'Hel' }),
      data({ v: 'lo' }),
      data({ p: 'response', o: 'BATCH', v: [{ p: 'accumulated_token_usage', v: 12 }, { p: 'status', v: 'FINISHED' }] }),
      named('finish', {}),
    ),
  );
  assert.equal(reply.content, 'Hello');
  assert.equal(reply.thinking, '');
  assert.equal(reply.status, 'FINISHED');
  assert.equal(reply.filtered, false);
});

test('older builds: reasoning, then answer, without explicit ops', () => {
  const reply = parseCompletionStream(
    stream(
      data({ p: 'response/thinking_content', v: 'Let me' }),
      data({ v: ' think' }),
      data({ p: 'response/content', v: 'Answer' }),
      data({ v: '!' }),
    ),
  );
  assert.equal(reply.thinking, 'Let me think');
  assert.equal(reply.content, 'Answer!');
});

test('fragments: THINK and RESPONSE, continuations go to the newest fragment', () => {
  const reply = parseCompletionStream(
    stream(
      data({ v: { response: { fragments: [{ id: 1, type: 'THINK', content: 'Hmm' }], status: 'WIP' } } }),
      data({ v: ', ok' }),
      data({ p: 'response/fragments', o: 'APPEND', v: [{ id: 2, type: 'RESPONSE', content: 'Hi' }] }),
      data({ v: ' there' }),
      data({ p: 'response/fragments/-1/content', o: 'APPEND', v: '!' }),
      data({ p: 'response/status', o: 'SET', v: 'FINISHED' }),
    ),
  );
  assert.equal(reply.thinking, 'Hmm, ok');
  assert.equal(reply.content, 'Hi there!');
  assert.equal(reply.status, 'FINISHED');
});

test('a fragment opened inside a BATCH receives the following text', () => {
  const reply = parseCompletionStream(
    stream(
      data({
        p: 'response',
        o: 'BATCH',
        v: [
          { p: 'fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: 'A' }] },
          { p: 'has_pending_fragment', v: false },
        ],
      }),
      data({ v: 'B' }),
    ),
  );
  assert.equal(reply.content, 'AB');
});

test('content filter: canned answer is flagged', () => {
  const reply = parseCompletionStream(
    stream(
      data({ v: { response: { fragments: [], status: 'WIP' } } }),
      data({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'TEMPLATE_RESPONSE', content: 'Sorry, beyond my scope.' }] }),
      data({ p: 'response/status', v: 'CONTENT_FILTER' }),
    ),
  );
  assert.equal(reply.content, 'Sorry, beyond my scope.');
  assert.equal(reply.status, 'CONTENT_FILTER');
  assert.equal(reply.filtered, true);
});

test('toasts are reported as errors', () => {
  const reply = parseCompletionStream(
    stream(named('toast', { type: 'error', content: 'The server is busy. Please try again later.' })),
  );
  assert.equal(reply.content, '');
  assert.deepEqual(reply.errors, ['The server is busy. Please try again later.']);
});

test('CRLF, comments and non-JSON data are tolerated', () => {
  const body = [': keep-alive', 'data: not json', data({ p: 'response/content', o: 'APPEND', v: 'ok' })].join('\r\n\r\n');
  assert.equal(parseCompletionStream(body).content, 'ok');
});
