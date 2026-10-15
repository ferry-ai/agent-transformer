import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright';

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

async function lastMessage(html: string): Promise<PageMessage | undefined> {
  if (!browser) return undefined;
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    return (await page.evaluate(`(${script})(${selectors})`)) as PageMessage;
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
