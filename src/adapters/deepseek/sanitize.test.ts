import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { test } from 'node:test';
import { fixtureFiles, streamExpectation, strayFixtureFiles } from './testing/fixtures.js';
import { checkText, IdMap, sanitizeHtml, sanitizeStream } from './testing/sanitize.js';

// The sanitizer stands between a logged-in session and a public repository: these
// tests use made-up ids and tokens shaped like real ones.

const SESSION = '3f2b9c1e-8d7a-4e6f-9b0c-1a2b3c4d5e6f';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl';

test('stream ids, times, tokens and emails become placeholders; the reply stays readable', () => {
  const raw = [
    'event: ready',
    'data: {"request_message_id":7,"response_message_id":8}',
    '',
    `data: {"v":{"response":{"message_id":8,"parent_id":7,"chat_session_id":"${SESSION}","inserted_at":1760000000.5,"status":"WIP","fragments":[{"id":1,"type":"RESPONSE","content":"Hi"}],"files":[{"id":"file-abc123","file_name":"sample-notes.txt"}]}}}`,
    '',
    `data: {"v":" there, write to someone@mail.test or use ${TOKEN}"}`,
    '',
    'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
    '',
    'event: update_session',
    'data: {"updated_at":1760000001.25,"email":"someone@mail.test"}',
    '',
  ].join('\n');
  const ids = new IdMap();
  const clean = sanitizeStream(raw, ids);
  assert.doesNotMatch(clean, /3f2b9c1e|file-abc123|1760000000|mail\.test|eyJhbGci/);
  assert.match(clean, /"response_message_id":1002/);
  assert.match(clean, /"message_id":1002,"parent_id":1001/);
  assert.match(clean, /"chat_session_id":"id-1"/);
  assert.match(clean, /"inserted_at":0/);
  assert.match(clean, /"id":"id-2","file_name":"sample-notes.txt"/);
  assert.deepEqual(checkText('stream.sse', clean), []);
  const parsed = streamExpectation(clean);
  assert.equal(parsed.content, 'Hi there, write to user@example.com or use <redacted-token>');
  assert.equal(parsed.status, 'FINISHED');
});

test('the same id gets the same placeholder in the stream and in the HTML', () => {
  const ids = new IdMap();
  sanitizeStream('data: {"v":{"response":{"message_id":42}}}\n\n', ids);
  const html = sanitizeHtml(
    '<div data-message-id="42" class="ds-message"><a href="/a/chat/s/abcDEF123">x</a><img src="data:image/png;base64,AAAA"><div class="ds-markdown"><p>C:\\Users\\someone\\notes.txt</p></div></div>',
    ids,
  );
  assert.match(html, /data-message-id="1001"/);
  assert.match(html, /\/a\/chat\/s\/id-1"/);
  assert.match(html, /src=""/);
  assert.match(html, /<user-folder>/);
  assert.deepEqual(checkText('message.html', html), []);
});

test('a refused request body (plain JSON) is sanitized too', () => {
  const clean = sanitizeStream(`{"code":40003,"msg":"Authorization Failed","data":{"user_id":"u-998877","token":"${TOKEN}"}}`, new IdMap());
  assert.doesNotMatch(clean, /u-998877|eyJhbGci/);
  assert.deepEqual(checkText('refused.sse', clean), []);
});

test('checkText finds what must never be committed', () => {
  const rules = (text: string, deny: string[] = []): string[] => checkText('x', text, deny).map((finding) => finding.rule);
  assert.deepEqual(rules('Cookie: ds_session_id=abc'), ['header']);
  assert.deepEqual(rules('{"authorization": "Bearer abcdefghijkl"}'), ['header', 'bearer token']);
  assert.deepEqual(rules(`token ${TOKEN}`), ['jwt']);
  assert.deepEqual(rules('mail me at someone@mail.test'), ['email']);
  assert.deepEqual(rules('mail me at user@example.com'), []);
  assert.deepEqual(rules(`session ${SESSION}`), ['uuid']);
  assert.deepEqual(rules('C:\\Users\\someone\\x'), ['user folder']);
  assert.deepEqual(rules('{"message_id": 77}'), ['numeric id']);
  assert.deepEqual(rules('{"message_id": 1001}'), []);
  assert.deepEqual(rules('{"chat_session_id": "abc"}'), ['string id']);
  assert.deepEqual(rules('<div data-message-id="77">'), ['id attribute']);
  assert.deepEqual(rules('<a href="/a/chat/s/abcDEF">'), ['chat link']);
  assert.deepEqual(rules('{"email": "x"}'), ['personal field']);
  assert.deepEqual(rules('Hello Somebody', ['somebody']), ['denied word']);
  // The excerpt never prints a whole secret back.
  const [finding] = checkText('x', `prefix ${TOKEN} suffix`);
  assert.ok(finding && !finding.excerpt.includes(TOKEN));
});

test('committed fixtures carry nothing private and no stray files', () => {
  const findings = fixtureFiles().flatMap((file) => checkText(basename(file), readFileSync(file, 'utf8')));
  assert.deepEqual(findings, []);
  assert.deepEqual(strayFixtureFiles(), []);
});
