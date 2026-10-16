import assert from 'node:assert/strict';
import { test } from 'node:test';
import { endedEarly, parseCompletionStream } from './stream.js';

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

test('a canned answer replaces what was streamed before it', () => {
  const reply = parseCompletionStream(
    stream(
      data({ v: { response: { fragments: [{ id: 1, type: 'RESPONSE', content: 'Part of an answer' }], status: 'WIP' } } }),
      data({ p: 'response/fragments', o: 'APPEND', v: [{ id: 2, type: 'TEMPLATE_RESPONSE', content: 'Canned.' }] }),
      data({ p: 'response/status', v: 'CONTENT_FILTER' }),
    ),
  );
  assert.equal(reply.content, 'Canned.');
  assert.equal(reply.filtered, true);
  assert.equal(endedEarly(reply), false);
});

test('a stream that stops before FINISHED ended early; quasi_status counts', () => {
  const cut = parseCompletionStream(
    stream(data({ v: { response: { fragments: [{ type: 'RESPONSE', content: 'Half' }], status: 'WIP' } } }), data({ v: ' an answer' })),
  );
  assert.equal(cut.content, 'Half an answer');
  assert.equal(cut.status, 'WIP');
  assert.equal(endedEarly(cut), true);

  const incomplete = parseCompletionStream(stream(data({ p: 'response/content', v: 'x' }), data({ p: 'response/status', v: 'INCOMPLETE' })));
  assert.equal(endedEarly(incomplete), true);

  const quasi = parseCompletionStream(
    stream(
      data({ v: { response: { content: 'Done', status: 'WIP' } } }),
      data({ p: 'response', o: 'BATCH', v: [{ p: 'quasi_status', v: 'FINISHED' }] }),
    ),
  );
  assert.equal(quasi.status, 'FINISHED');
  assert.equal(endedEarly(quasi), false);

  // No status at all: nothing says it ended early.
  assert.equal(endedEarly(parseCompletionStream(stream(data({ p: 'response/content', v: 'ok' })))), false);
});

test('a refused request answers with a JSON envelope instead of a stream', () => {
  assert.deepEqual(parseCompletionStream('{"code":40003,"msg":"Authorization Failed (invalid token)","data":null}').errors, [
    'Authorization Failed (invalid token)',
  ]);
  assert.deepEqual(
    parseCompletionStream('{"code":0,"msg":"","data":{"biz_code":3,"biz_msg":"Too many requests","biz_data":null}}').errors,
    ['Too many requests'],
  );
  // A successful envelope carries no error.
  assert.deepEqual(parseCompletionStream('{"code":0,"msg":"","data":{"biz_code":0,"biz_msg":""}}').errors, []);
});

test('error hints are reported, other hints and named events are not', () => {
  const reply = parseCompletionStream(
    stream(
      named('ready', { request_message_id: 1, response_message_id: 2 }),
      named('hint', { type: 'info', content: 'Tip: try DeepThink.' }),
      named('hint', { type: 'error', content: 'Rate limit reached', finish_reason: 'rate_limit_reached' }),
      named('title', { content: 'A title' }),
      named('close', { click_behavior: 'none' }),
    ),
  );
  assert.deepEqual(reply.errors, ['Rate limit reached (rate_limit_reached)']);
  assert.equal(reply.content, '');
});

