import { statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { DeepSeekWebAdapter, type InspectReport } from './adapters/deepseek/index.js';
import type { BrowserChoice } from './browser/launch.js';
import { defaultDataDir } from './config.js';
import { AdapterError, type ChatReply } from './core/adapter.js';
import { Transcript } from './core/transcript.js';

const USAGE = `Usage: npm run chat -- [options]

Options:
  --browser <name>   chrome | msedge | chromium (default: the first one found)
  --timeout <sec>    longest wait for a reply (default: 300)
  --show-thinking    print the model's reasoning when it is visible
  --debug            save the raw stream and HTML of every reply in the session folder
  --check            open DeepSeek, report what the connector sees, and exit
  --data-dir <path>  where browser profiles and sessions are kept
  -h, --help         show this help`;

const COMMANDS = `Commands:
  /new             start a new chat
  /attach <file>   attach a file to the next message (repeat for more files)
  """              start or end a message on several lines
  /help            show this list
  /quit            exit`;

const NOTICE =
  "Web mode drives chat.deepseek.com in a real browser. DeepSeek's Terms of Use forbid automated use: use it at your own risk (see README).";

const tty = process.stdout.isTTY === true;
const dim = (text: string): string => (tty ? `\x1b[2m${text}\x1b[22m` : text);
const red = (text: string): string => (tty ? `\x1b[31m${text}\x1b[39m` : text);

type Ask = (prompt: string) => Promise<string | null>;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      browser: { type: 'string', default: 'auto' },
      timeout: { type: 'string', default: '300' },
      'show-thinking': { type: 'boolean', default: false },
      debug: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      'data-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }

  const timeoutSec = Number(values.timeout);
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    throw new Error(`--timeout must be a positive number of seconds, got "${values.timeout}".`);
  }
  const dataDir = resolve(values['data-dir'] ?? defaultDataDir());
  const adapter = new DeepSeekWebAdapter({
    profileDir: join(dataDir, 'profiles', 'deepseek'),
    browser: parseBrowser(values.browser),
    replyTimeoutMs: timeoutSec * 1000,
    debug: values.debug === true,
    notify: (message) => console.log(dim(message)),
  });

  console.log(dim(NOTICE));
  if (values.check) {
    try {
      printReport(await adapter.inspect());
    } finally {
      await adapter.close();
    }
    return;
  }
  await chat(adapter, dataDir, values['show-thinking'] === true);
}

async function chat(adapter: DeepSeekWebAdapter, dataDir: string, showThinking: boolean): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const closed = new Promise<null>((done) => rl.once('close', () => done(null)));
  const ask: Ask = (prompt) => Promise.race([rl.question(prompt).catch(() => null), closed]);
  // Ctrl+C closes everything, even while a reply is on its way.
  rl.on('SIGINT', () => {
    rl.close();
    void adapter.close();
  });

  try {
    await adapter.open();
    const transcript = await Transcript.create(dataDir, adapter.name);
    console.log(dim(`Session log: ${transcript.dir}`));
    console.log(dim('Ready. Type a message, or /help for the commands.'));
    const attachments: string[] = [];

    for (;;) {
      const line = await ask(attachments.length > 0 ? `[+${attachments.length} file] > ` : '> ');
      if (line === null) break;
      const input = line.trim();
      if (input === '') continue;
      if (input === '/quit' || input === '/exit') break;
      if (input === '/help') {
        console.log(COMMANDS);
        continue;
      }
      if (input === '/new') {
        try {
          await adapter.newChat();
          await transcript.event('new_chat');
          console.log(dim('New chat.'));
        } catch (error) {
          if (error instanceof AdapterError && error.kind === 'closed') throw error;
          console.log(red(`✖ ${errorMessage(error)}`));
        }
        continue;
      }
      if (input === '/attach' || input.startsWith('/attach ')) {
        const file = input.slice('/attach'.length).trim().replace(/^"(.*)"$/, '$1');
        if (file === '') {
          console.log(dim('Usage: /attach <file>'));
        } else if (!isFile(resolve(file))) {
          console.log(red(`Not a file: ${resolve(file)}`));
        } else {
          attachments.push(resolve(file));
          console.log(dim(`${basename(file)} will go with the next message.`));
        }
        continue;
      }
      if (input.startsWith('/')) {
        console.log(dim('Unknown command: /help lists them.'));
        continue;
      }

      const message = input === '"""' ? await readBlock(ask) : line;
      if (message === null) break;
      if (message.trim() === '') continue;

      const sent = attachments.splice(0);
      const stop = ticker('DeepSeek is answering');
      try {
        const reply = await adapter.send(message, { attachments: sent });
        stop();
        printReply(reply, showThinking);
        await transcript.turn({ prompt: message, attachments: sent, reply });
      } catch (error) {
        stop();
        await transcript.turn({ prompt: message, attachments: sent, error });
        if (error instanceof AdapterError && error.kind === 'closed') throw error;
        console.log(red(`✖ ${errorMessage(error)}`));
      }
    }
  } finally {
    rl.close();
    await adapter.close();
  }
}

async function readBlock(ask: Ask): Promise<string | null> {
  const lines: string[] = [];
  for (;;) {
    const line = await ask('… ');
    if (line === null) return null;
    if (line.trim() === '"""') return lines.join('\n');
    lines.push(line);
  }
}

function printReply(reply: ChatReply, showThinking: boolean): void {
  if (showThinking && reply.thinking) console.log(`${dim(reply.thinking)}\n`);
  console.log(reply.text);
  const notes = [reply.source, `${(reply.durationMs / 1000).toFixed(1)}s`];
  if (reply.thinking && !showThinking) notes.push('reasoning hidden: --show-thinking');
  if (reply.filtered) notes.push('answer replaced by DeepSeek');
  console.log(dim(`(${notes.join(' · ')})`));
}

function printReport(report: InspectReport): void {
  const yesNo = (value: boolean): string => (value ? 'yes' : 'no');
  console.log(
    [
      `Browser:       ${report.browser}`,
      `Page:          ${report.url}  (${report.title})`,
      `Message box:   ${yesNo(report.inputVisible)}`,
      `Messages:      ${report.messages}`,
      `Markdown:      ${report.markdownBlocks}`,
      `File input:    ${yesNo(report.fileInputs > 0)}`,
      `Verification:  ${report.verificationFrames > 0 ? 'shown' : 'none'}`,
    ].join('\n'),
  );
  if (!report.inputVisible) {
    console.log(dim('No message box: probably not logged in yet. Run "npm run chat" and log in in the browser window.'));
  }
}

/** A one-line elapsed-time counter; returns the function that clears it. */
function ticker(label: string): () => void {
  if (!tty) return () => undefined;
  const started = Date.now();
  const draw = (): void => {
    process.stdout.write(`\r${dim(`${label}… ${Math.round((Date.now() - started) / 1000)}s`)}`);
  };
  draw();
  const timer = setInterval(draw, 1000);
  return () => {
    clearInterval(timer);
    process.stdout.write('\r\x1b[2K');
  };
}

function parseBrowser(value: string | undefined): BrowserChoice {
  const choices: readonly BrowserChoice[] = ['auto', 'chrome', 'msedge', 'chromium'];
  const match = choices.find((choice) => choice === value);
  if (!match) throw new Error(`--browser must be one of: ${choices.join(', ')}.`);
  return match;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error: unknown) => {
  if (error instanceof AdapterError && error.kind === 'closed') {
    console.log(dim('The browser was closed.'));
    return;
  }
  console.error(red(errorMessage(error)));
  process.exitCode = 1;
});
