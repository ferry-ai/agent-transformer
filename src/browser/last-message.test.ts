import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright';
import { deepseek } from '../adapters/deepseek/selectors.js';
import { loadFixtures } from '../adapters/deepseek/testing/fixtures.js';

// Runs the page script on a local copy of DeepSeek's message structure: no network involved.
const script = readFileSync(new URL('./last-message.js', import.meta.url), 'utf8');
const selectors = JSON.stringify({ message: '[data-message-id]', markdown: '.ds-markdown' });

interface PageMessage {
  text: string;
  thinking: string;
  html: string;
  messages: number;
}

let browser: Browser | undefined;

before(async () => {
  for (const channel of ['chrome', 'msedge', undefined] as const) {
    try {
      browser = await chromium.launch({ channel, headless: true });
      return;
    } catch {
      // Try the next browser.
    }
  }
});

after(async () => {
  await browser?.close();
});

async function lastMessage(html: string, options: string = selectors): Promise<PageMessage | undefined> {
  if (!browser) return undefined;
  const page = await browser.newPage();
  try {
    await page.route('**/*', (route) => route.abort());
    await page.setContent(html);
    return (await page.evaluate(`(${script})(${options})`)) as PageMessage;
  } finally {
    await page.close();
  }
}

const REPLY = `
<div data-message-id="1"><div class="user">Scrivi una funzione</div></div>
<div data-message-id="2">
  <div class="thinking"><div class="ds-markdown"><p>Devo scrivere una funzione.</p></div></div>
  <div class="ds-markdown">
    <h3>Funzione</h3>
    <p>Ecco <strong>la</strong> funzione con <code>sum</code>:</p>
    <div class="md-code-block">
      <div class="md-code-block-banner-wrap"><div class="md-code-block-banner">
        <div class="md-code-block-infostring">python</div>
        <div class="md-code-block-action"><div role="button">Copy</div><div role="button">Download</div></div>
      </div></div>
      <pre><div class="overflow-x"><span class="token keyword">def</span> sum(a, b):
    return a + b</div></pre>
    </div>
    <ul><li>primo</li><li>secondo<ul><li>annidato</li></ul></li></ul>
    <ol><li>uno</li><li>due</li></ol>
    <p>Formula: <span class="katex"><span class="katex-mathml"><math><semantics><annotation encoding="application/x-tex">a^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">a2</span></span></p>
    <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
  </div>
  <div class="actions"><div role="button">Copy</div></div>
</div>`;

const EXPECTED = [
  '### Funzione',
  '',
  'Ecco **la** funzione con `sum`:',
  '',
  '```python',
  'def sum(a, b):',
  '    return a + b',
  '```',
  '',
  '- primo',
  '- secondo',
  '  - annidato',
  '',
  '1. uno',
  '2. due',
  '',
  'Formula: $a^2$',
  '',
  '| A | B |',
  '| --- | --- |',
  '| 1 | 2 |',
].join('\n');

test('renders the last message as Markdown and splits off the reasoning', async (t) => {
  const result = await lastMessage(REPLY);
  if (!result) return t.skip('no browser available');
  assert.equal(result.messages, 2);
  assert.equal(result.thinking, 'Devo scrivere una funzione.');
  assert.equal(result.text, EXPECTED);
});

test('without Markdown blocks, falls back to the plain text of the message', async (t) => {
  const result = await lastMessage('<div data-message-id="7"><p>Server busy.</p></div>');
  if (!result) return t.skip('no browser available');
  assert.equal(result.text, 'Server busy.');
  assert.equal(result.thinking, '');
});

test('an empty page yields no message', async (t) => {
  const result = await lastMessage('<main></main>');
  if (!result) return t.skip('no browser available');
  assert.equal(result.messages, 0);
  assert.equal(result.text, '');
});

test('when the message selector lists several guesses, nested matches are one message', async (t) => {
  const both = JSON.stringify({ message: '[data-message-id], .ds-message', markdown: '.ds-markdown' });
  const html =
    '<div class="ds-message"><div data-message-id="1">Question</div></div>' +
    '<div class="ds-message"><div data-message-id="2"><div class="ds-markdown"><p>Answer</p></div></div></div>';
  const result = await lastMessage(html, both);
  if (!result) return t.skip('no browser available');
  assert.equal(result.messages, 2);
  assert.equal(result.text, 'Answer');
});

// Replays of captured messages (scripts/deepseek/capture.ts, then sanitize.ts), read
// with the adapter's own selectors. The expectations were recorded at capture time.
const captured = loadFixtures().filter((fixture) => fixture.html !== undefined && fixture.expect.page !== undefined);
if (captured.length === 0) {
  test('captured messages render as recorded', (t) => {
    t.skip('no captured fixtures yet: see docs/calibration.md');
  });
}
for (const fixture of captured) {
  test(`captured message "${fixture.name}" renders as recorded`, async (t) => {
    const args = JSON.stringify({ message: deepseek.message, markdown: deepseek.markdown });
    const result = await lastMessage(`<main>${fixture.html ?? ''}</main>`, args);
    if (!result) return t.skip('no browser available');
    assert.deepEqual({ text: result.text, thinking: result.thinking }, fixture.expect.page);
  });
}
