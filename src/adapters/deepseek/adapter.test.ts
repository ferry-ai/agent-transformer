import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { AdapterError } from '../../core/adapter.js';
import { DeepSeekWebAdapter, type DeepSeekOptions } from './index.js';
import { fragmentStream, replyHtml, startMockSite, type MockSite, type MockTurn } from './testing/mock-site.js';

// The adapter drives a real (headless) browser against a local copy of the chat page:
// this checks the browser mechanics (stream capture, page fallback, uploads, toggles),
// not DeepSeek's own formats, which only captures can confirm (docs/calibration.md).

const turns = new Map<string, MockTurn>();
let site: MockSite | undefined;
let adapter: DeepSeekWebAdapter | undefined;
let folder = '';

function options(url: string, profile: string): DeepSeekOptions {
  return {
    profileDir: join(folder, profile),
    browser: 'auto',
    replyTimeoutMs: 20_000,
    debug: true,
    notify: () => undefined,
    waitForUser: false,
    url,
    headless: true,
  };
}

before(async () => {
  folder = await mkdtemp(join(tmpdir(), 'agent-deepseek-'));
  site = await startMockSite((request) => {
    const scripted = turns.get(request.prompt);
    if (scripted) return scripted;
    const text = `echo: ${request.prompt}`;
    return { body: fragmentStream({ text }), html: replyHtml({ text }) };
  });
  const candidate = new DeepSeekWebAdapter(options(site.url, 'profile'));
  try {
    await candidate.open();
    adapter = candidate;
  } catch {
    await candidate.close();
  }
});

after(async () => {
  await adapter?.close();
  await site?.close();
  await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('headless is refused on DeepSeek itself', () => {
  assert.throws(
    () => new DeepSeekWebAdapter({ ...options('https://chat.deepseek.com/', 'unused'), headless: true }),
    /visible browser window/,
  );
});

test('reads the answer and the reasoning from the stream', async (t) => {
  if (!adapter) return t.skip('no browser available');
  const body = fragmentStream({ text: 'Hello **world**, a longer answer that spans several pieces.', thinking: 'Let me think about it.' });
  turns.set('stream', { body, html: replyHtml({ text: 'Hello **world**, a longer answer that spans several pieces.', thinking: 'Let me think about it.' }) });
  const reply = await adapter.send('stream');
  assert.equal(reply.source, 'network');
  assert.equal(reply.text, 'Hello **world**, a longer answer that spans several pieces.');
  assert.equal(reply.thinking, 'Let me think about it.');
  assert.equal(reply.filtered, false);
  assert.equal(reply.raw?.stream, body);
  assert.match(reply.raw?.html ?? '', /ds-markdown/);
});

test('falls back to the page when the stream is not understood', async (t) => {
  if (!adapter) return t.skip('no browser available');
  turns.set('unknown format', { body: 'data: {"unknown": true}\n\n', html: replyHtml({ text: 'Read from the page.' }) });
  const reply = await adapter.send('unknown format');
  assert.equal(reply.source, 'dom');
  assert.equal(reply.text, 'Read from the page.');
});

test('a stream that ends before FINISHED is completed from the page', async (t) => {
  if (!adapter) return t.skip('no browser available');
  turns.set('cut', {
    body: fragmentStream({ text: 'The first half', status: 'INCOMPLETE' }),
    html: replyHtml({ text: 'The first half, and then the second half.' }),
  });
  const reply = await adapter.send('cut');
  assert.equal(reply.source, 'dom');
  assert.equal(reply.text, 'The first half, and then the second half.');
});

test('a busy toast, HTTP 429 and a refused session become adapter errors', async (t) => {
  if (!adapter) return t.skip('no browser available');
  turns.set('toast', {
    body: 'event: toast\ndata: {"type":"error","content":"The server is busy. Please try again later."}\n\n',
    html: '',
  });
  turns.set('429', { status: 429, contentType: 'application/json', body: '{"code":429,"msg":"Too many requests"}', html: '' });
  turns.set('signed out', {
    contentType: 'application/json',
    body: '{"code":40003,"msg":"Authorization Failed (invalid token)","data":null}',
    html: '',
  });
  const kind = async (prompt: string): Promise<[string, string]> => {
    const error = await adapter!.send(prompt).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    assert.ok(error instanceof AdapterError, `${prompt}: expected an AdapterError, got ${String(error)}`);
    return [error.kind, error.message];
  };
  assert.equal((await kind('toast'))[0], 'busy');
  assert.equal((await kind('429'))[0], 'busy');
  const [refused, message] = await kind('signed out');
  assert.equal(refused, 'provider');
  assert.match(message, /log in again/i);
});

test('attachments are uploaded and the message waits for the upload', async (t) => {
  if (!adapter || !site) return t.skip('no browser available');
  const file = join(folder, 'notes.txt');
  await writeFile(file, 'one\ntwo\nthree\n');
  const reply = await adapter.send('with a file', { attachments: [file] });
  assert.equal(reply.text, 'echo: with a file');
  assert.deepEqual(site.requests.at(-1)?.files, ['notes.txt']);
});

test('DeepThink is turned on and off', async (t) => {
  if (!adapter || !site) return t.skip('no browser available');
  assert.equal(await adapter.setDeepThink(true), true);
  await adapter.send('thinking on');
  assert.equal(site.requests.at(-1)?.thinking, true);
  assert.equal(await adapter.setDeepThink(true), true);
  assert.equal(await adapter.setDeepThink(false), false);
  await adapter.send('thinking off');
  assert.equal(site.requests.at(-1)?.thinking, false);
});

test('a new chat reloads the chat page', async (t) => {
  if (!adapter || !site) return t.skip('no browser available');
  const loads = site.pageLoads;
  await adapter.newChat();
  assert.equal(site.pageLoads, loads + 1);
  assert.equal((await adapter.send('after a new chat')).text, 'echo: after a new chat');
});

test('inspect reports the sign-in page at once instead of waiting', async (t) => {
  if (!adapter) return t.skip('no browser available');
  const loggedOut = await startMockSite(() => ({ body: '', html: '' }));
  loggedOut.signedOut = true;
  const other = new DeepSeekWebAdapter(options(loggedOut.url, 'signed-out-profile'));
  try {
    const started = Date.now();
    const report = await other.inspect();
    assert.equal(report.inputVisible, false);
    assert.equal(report.signInPage, true);
    assert.match(report.url, /\/sign_in$/);
    assert.ok(Date.now() - started < 8_000, 'it should not wait for the message box on the sign-in page');
  } finally {
    await other.close();
    await loggedOut.close();
  }
});

test('without a user to log in, open() fails at once on the sign-in page and says what to do', async (t) => {
  if (!adapter) return t.skip('no browser available');
  const loggedOut = await startMockSite(() => ({ body: '', html: '' }));
  loggedOut.signedOut = true;
  const other = new DeepSeekWebAdapter(options(loggedOut.url, 'unattended-profile'));
  try {
    const started = Date.now();
    const error = await other.open().then(
      () => undefined,
      (failure: unknown) => failure,
    );
    assert.ok(error instanceof AdapterError, `expected an AdapterError, got ${String(error)}`);
    assert.equal(error.kind, 'provider');
    assert.match(error.message, /sign-in page/);
    assert.match(error.message, /npm run chat/);
    assert.ok(Date.now() - started < 8_000, 'it should not wait for a login nobody can do');
  } finally {
    await other.close();
    await loggedOut.close();
  }
});

test('a session that expires between messages fails fast too', async (t) => {
  if (!adapter || !site) return t.skip('no browser available');
  site.signedOut = true;
  try {
    await assert.rejects(adapter.newChat(), (error: unknown) => error instanceof AdapterError && /sign-in page/.test(error.message));
  } finally {
    site.signedOut = false;
  }
  await adapter.newChat();
});

test('a busy toast on the page ends the wait with a busy error', async (t) => {
  if (!adapter) return t.skip('no browser available');
  turns.set('toast on page', { body: '', html: '', notice: 'Il server è occupato. Riprova più tardi.' });
  const started = Date.now();
  const error = await adapter.send('toast on page').then(
    () => undefined,
    (failure: unknown) => failure,
  );
  assert.ok(error instanceof AdapterError, `expected an AdapterError, got ${String(error)}`);
  assert.equal(error.kind, 'busy');
  assert.ok(Date.now() - started < 8_000, 'the toast should end the wait');
});

test('a refused request explains itself from its JSON body', async (t) => {
  if (!adapter) return t.skip('no browser available');
  turns.set('403', { status: 403, contentType: 'application/json', body: '{"code":40002,"msg":"Missing Token","data":null}', html: '' });
  await assert.rejects(adapter.send('403'), (error: unknown) => error instanceof AdapterError && /log in again/i.test(error.message));
  turns.set('500', { status: 500, contentType: 'text/plain', body: 'oops', html: '' });
  await assert.rejects(
    adapter.send('500'),
    (error: unknown) => error instanceof AdapterError && error.kind === 'provider' && /HTTP 500/.test(error.message),
  );
});

test('a finished stream the parser cannot read is taken from the page', async (t) => {
  if (!adapter) return t.skip('no browser available');
  turns.set('opaque', { body: 'data: {"something":"else"}\n\n', html: replyHtml({ text: 'Shown on the page only.' }) });
  const reply = await adapter.send('opaque');
  assert.equal(reply.source, 'dom');
  assert.equal(reply.text, 'Shown on the page only.');
});
