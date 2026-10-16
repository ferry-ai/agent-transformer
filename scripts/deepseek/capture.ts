/**
 * Sends a fixed set of neutral messages to DeepSeek with the adapter in debug mode, so
 * the raw stream and HTML of every reply land in a session folder, ready for
 * sanitize.ts. It never waits for a login: when the profile shows the sign-in page or
 * a verification, it closes the browser and stops. See docs/calibration.md.
 *
 *   npx tsx scripts/deepseek/capture.ts --list
 *   npx tsx scripts/deepseek/capture.ts --only short,code,tool
 *   npx tsx scripts/deepseek/capture.ts --mock          (dry run on a local copy of the page)
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DeepSeekWebAdapter } from '../../src/adapters/deepseek/index.js';
import { parseCompletionStream } from '../../src/adapters/deepseek/stream.js';
import { fragmentStream, replyHtml, startMockSite, type MockSite } from '../../src/adapters/deepseek/testing/mock-site.js';
import type { BrowserChoice } from '../../src/browser/launch.js';
import { defaultDataDir } from '../../src/config.js';
import { AdapterError } from '../../src/core/adapter.js';
import { Transcript } from '../../src/core/transcript.js';
import { preparePrivateDataDir } from '../../src/tools/data-dir.js';

export interface CaptureMessage {
  id: string;
  /** What the capture is for. */
  covers: string;
  prompt: string;
  /** Start a new chat first. */
  newChat?: boolean;
  /** Turn DeepThink on for this message (and off again after it). */
  deepThink?: boolean;
  /** A small text file created in a temp folder and attached. */
  attachment?: { name: string; content: string };
}

/** Neutral messages, written for this script: no personal data. Order matters only for "new-chat". */
export const MESSAGES: readonly CaptureMessage[] = [
  { id: 'short', covers: 'a one-word answer', prompt: 'Reply with one word: ready.' },
  {
    id: 'long',
    covers: 'a long answer with headings and lists',
    prompt: 'In about 400 words, explain how a hash table handles collisions. Use two headings and one bulleted list.',
  },
  {
    id: 'code',
    covers: 'one fenced code block',
    prompt:
      'Write a Python function is_palindrome(s) that ignores case and spaces, in a fenced code block, then show one example call.',
  },
  {
    id: 'multi-code',
    covers: 'several fenced blocks with language tags',
    prompt: 'Show "hello world" in JavaScript, Rust and Bash, each in its own fenced code block tagged with its language.',
  },
  {
    id: 'tool',
    covers: 'a fenced block tagged tool, as the agent protocol asks',
    prompt:
      'Reply with exactly one fenced code block tagged tool, and nothing outside it. Its first line is this JSON: ' +
      '{"tool": "write_file", "args": {"path": "notes.md"}}. After that line, write two short lines of Markdown.',
  },
  {
    id: 'table-math',
    covers: 'a Markdown table and a LaTeX formula',
    prompt:
      'Make a Markdown table comparing bubble sort, merge sort and quicksort by average time complexity, ' +
      'then give the formula for the sum of the first n integers in LaTeX.',
  },
  {
    id: 'italian',
    covers: 'Italian text with accented letters',
    prompt: "Rispondi in italiano, in due frasi: che cos'è un file CSV? Usa almeno una parola con l'accento.",
  },
  {
    id: 'special-chars',
    covers: 'characters that need escaping in HTML',
    prompt:
      'Show the expression a < b && c > d in inline code, then the HTML tag <br> in a fenced block tagged html, ' +
      'then a bulleted list nested two levels deep.',
  },
  {
    id: 'deepthink',
    covers: 'visible reasoning (DeepThink) next to the answer',
    prompt: 'Which is larger, 9.11 or 9.9? Explain briefly.',
    deepThink: true,
  },
  {
    id: 'new-chat',
    covers: 'a new chat: no earlier messages',
    prompt: 'Is there anything earlier in this conversation? Answer yes or no, then one sentence.',
    newChat: true,
  },
  {
    id: 'attachment',
    covers: 'an attached text file',
    prompt: 'How many lines does the attached file have, and what is on the second line?',
    attachment: { name: 'sample-notes.txt', content: 'apples\npears\nplums\n' },
  },
];

const USAGE = `Usage: npx tsx scripts/deepseek/capture.ts [options]

  --only <ids>       comma-separated message ids (default: all, in order)
  --list             print the messages and exit
  --pause <sec>      pause between two messages (default: 5)
  --timeout <sec>    longest wait for one reply (default: 300)
  --browser <name>   chrome | msedge | chromium (default: the first one found)
  --data-dir <path>  default: the real data dir, whose profile is logged in
  --mock             dry run on a local copy of the page, headless, in a temp data dir`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      only: { type: 'string' },
      list: { type: 'boolean', default: false },
      pause: { type: 'string', default: '5' },
      timeout: { type: 'string', default: '300' },
      browser: { type: 'string', default: 'auto' },
      'data-dir': { type: 'string' },
      mock: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) return console.log(USAGE);
  if (values.list) {
    for (const message of MESSAGES) console.log(`${message.id.padEnd(14)} ${message.covers}\n${' '.repeat(15)}${message.prompt}`);
    return;
  }
  const selected = select(values.only);
  const pauseMs = seconds(values.pause, '--pause') * 1000;
  const timeoutMs = seconds(values.timeout, '--timeout') * 1000;

  let site: MockSite | undefined;
  let dataDir: string;
  if (values.mock) {
    site = await startMockSite((request) => {
      const text = `Mock reply ${request.turn} to: ${request.prompt.slice(0, 60)}${request.files.length > 0 ? `\n\nFiles: ${request.files.join(', ')}` : ''}`;
      const thinking = request.thinking ? 'Mock reasoning.' : undefined;
      return { body: fragmentStream({ text, thinking }), html: replyHtml({ text, thinking }) };
    });
    dataDir = resolve(values['data-dir'] ?? (await mkdtemp(join(tmpdir(), 'deepseek-capture-mock-'))));
  } else {
    dataDir = resolve(values['data-dir'] ?? defaultDataDir());
  }
  await preparePrivateDataDir(dataDir, { isDefault: values['data-dir'] === undefined && !values.mock });

  const adapter = new DeepSeekWebAdapter({
    profileDir: join(dataDir, 'profiles', 'deepseek'),
    browser: parseBrowser(values.browser),
    replyTimeoutMs: timeoutMs,
    debug: true,
    // Never wait for a login or a verification here: report it and stop.
    waitForUser: false,
    notify: (message) => console.log(`  ${message}`),
    url: site?.url,
    headless: site !== undefined,
  });
  const files = await mkdtemp(join(tmpdir(), 'deepseek-capture-files-'));
  const stop = (): void => {
    void adapter.close().finally(() => process.exit(130));
  };
  process.once('SIGINT', stop);

  try {
    // Never wait for a login or a verification: report and stop.
    const report = await adapter.inspect();
    console.log(`Browser ${report.browser}, page ${report.url}, message box ${report.inputVisible ? 'yes' : 'no'}`);
    if (!report.inputVisible || report.verificationFrames > 0) {
      const why = report.verificationFrames > 0 ? 'a verification is shown' : report.signInPage ? 'the profile is not logged in (sign-in page)' : 'no message box';
      console.log(`Stopping: ${why}. Log in with "npm run chat" first, then run this again.`);
      process.exitCode = 2;
      return;
    }

    const transcript = await Transcript.create(dataDir, adapter.name);
    console.log(`Session folder: ${transcript.dir}`);
    await transcript.event('capture_start', { script: 'scripts/deepseek/capture.ts', ids: selected.map((m) => m.id), mock: values.mock });

    for (const [index, message] of selected.entries()) {
      if (index > 0) await new Promise((done) => setTimeout(done, pauseMs));
      if (message.newChat) {
        await adapter.newChat();
        await transcript.event('new_chat');
      }
      if (message.deepThink) {
        const state = await adapter.setDeepThink(true);
        await transcript.event('deepthink', { wanted: true, shown: state ?? 'unknown' });
        if (state !== true) console.log(`  DeepThink toggle: ${state === undefined ? 'not found or state unreadable' : 'still off'}`);
      }
      const attachments: string[] = [];
      if (message.attachment) {
        const path = join(files, message.attachment.name);
        await writeFile(path, message.attachment.content);
        attachments.push(path);
      }
      await transcript.event('capture', { id: message.id, covers: message.covers });
      try {
        const reply = await adapter.send(message.prompt, { attachments });
        await transcript.turn({ prompt: message.prompt, attachments: attachments.map((path) => path.slice(files.length + 1)), reply });
        const stream = reply.raw?.stream === undefined ? undefined : parseCompletionStream(reply.raw.stream);
        console.log(
          `${message.id.padEnd(14)} ${reply.source}, ${reply.text.length} chars` +
            `${reply.thinking ? `, reasoning ${reply.thinking.length} chars` : ''}` +
            `${reply.filtered ? ', FILTERED' : ''}, status ${stream?.status ?? 'none'}, ${(reply.durationMs / 1000).toFixed(1)}s`,
        );
      } catch (error) {
        await transcript.turn({ prompt: message.prompt, attachments: attachments.map((path) => path.slice(files.length + 1)), error });
        const what = error instanceof AdapterError ? `${error.kind}: ${error.message}` : String(error);
        // Stop at the first failure: never push on against a busy server or a limit.
        console.log(`${message.id.padEnd(14)} FAILED (${what}). Stopping.`);
        process.exitCode = 1;
        return;
      } finally {
        if (message.deepThink) await adapter.setDeepThink(false).catch(() => undefined);
      }
    }
    console.log(`Done. Next: npx tsx scripts/deepseek/sanitize.ts "${transcript.dir}"`);
  } finally {
    process.removeListener('SIGINT', stop);
    await adapter.close();
    await site?.close();
    await rm(files, { recursive: true, force: true });
  }
}

function select(only: string | undefined): CaptureMessage[] {
  if (only === undefined) return [...MESSAGES];
  const ids = only.split(',').map((id) => id.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !MESSAGES.some((message) => message.id === id));
  if (unknown.length > 0) throw new Error(`Unknown message ids: ${unknown.join(', ')}. --list shows them.`);
  return MESSAGES.filter((message) => ids.includes(message.id));
}

function seconds(value: string | undefined, flag: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${flag} must be a number of seconds, got "${value}".`);
  return number;
}

function parseBrowser(value: string | undefined): BrowserChoice {
  const choices: readonly BrowserChoice[] = ['auto', 'chrome', 'msedge', 'chromium'];
  const match = choices.find((choice) => choice === value);
  if (!match) throw new Error(`--browser must be one of: ${choices.join(', ')}.`);
  return match;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
