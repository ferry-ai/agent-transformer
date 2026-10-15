import { readFileSync } from 'node:fs';
import type { BrowserContext, Locator, Page, Response } from 'playwright';
import { launchBrowser, type BrowserChoice } from '../../browser/launch.js';
import { AdapterError, type ChatAdapter, type ChatReply, type SendOptions } from '../../core/adapter.js';
import { deepseek } from './selectors.js';
import { parseCompletionStream } from './stream.js';

/** Page-side function that renders the last message as Markdown. */
const LAST_MESSAGE = readFileSync(new URL('../../browser/last-message.js', import.meta.url), 'utf8');

/** How long the reply stream may take to start before we fall back to watching the page. */
const STREAM_START_MS = 30_000;
/** When watching the page, a reply is complete once its text has been still this long. */
const PAGE_STILL_MS = 5_000;
/** Silent wait for the chat to show up before asking the user to step in. */
const READY_GRACE_MS = 10_000;

export interface DeepSeekOptions {
  profileDir: string;
  browser: BrowserChoice;
  /** Longest wait for a complete reply. */
  replyTimeoutMs: number;
  /** Keep the raw stream and HTML of each reply, to recalibrate parser and selectors. */
  debug: boolean;
  /** Messages for the user: browser opened, login needed, verification shown. */
  notify: (message: string) => void;
}

export interface InspectReport {
  browser: string;
  url: string;
  title: string;
  inputVisible: boolean;
  messages: number;
  markdownBlocks: number;
  fileInputs: number;
  verificationFrames: number;
}

interface PageMessage {
  text: string;
  thinking: string;
  html: string;
  messages: number;
}

/**
 * Talks to chat.deepseek.com through a real, visible browser. The reply is read from
 * the completion stream when its format is understood, otherwise from the page.
 */
export class DeepSeekWebAdapter implements ChatAdapter {
  readonly name = 'deepseek-web';
  private readonly options: DeepSeekOptions;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private browser = '';
  private closed = false;

  constructor(options: DeepSeekOptions) {
    this.options = options;
  }

  async open(): Promise<void> {
    await this.guard(async () => {
      await this.launch();
      await this.waitUntilReady();
    });
  }

  /** Opens the page and reports what the connector sees, without waiting for a login. */
  async inspect(): Promise<InspectReport> {
    return this.guard(async () => {
      await this.launch();
      const page = this.requirePage();
      const inputVisible = await this.input()
        .waitFor({ state: 'visible', timeout: READY_GRACE_MS })
        .then(
          () => true,
          () => false,
        );
      return {
        browser: this.browser,
        url: page.url(),
        title: await page.title(),
        inputVisible,
        messages: await page.locator(deepseek.message).count(),
        markdownBlocks: await page.locator(deepseek.markdown).count(),
        fileInputs: await page.locator(deepseek.fileInput).count(),
        verificationFrames: await page.locator(deepseek.verification).count(),
      };
    });
  }

  async newChat(): Promise<void> {
    await this.guard(async () => {
      await this.requirePage().goto(deepseek.url, { waitUntil: 'domcontentloaded' });
      await this.waitUntilReady();
    });
  }

  async send(message: string, options: SendOptions = {}): Promise<ChatReply> {
    return this.guard(() => this.exchange(message, options.attachments ?? []));
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.context?.close().catch(() => undefined);
  }

  private async launch(): Promise<void> {
    const { context, browser } = await launchBrowser({
      browser: this.options.browser,
      profileDir: this.options.profileDir,
    });
    this.context = context;
    this.browser = browser;
    context.on('close', () => {
      this.closed = true;
    });
    this.page = context.pages()[0] ?? (await context.newPage());
    this.options.notify(`Opened ${browser} with the profile in ${this.options.profileDir}`);
    await this.page.goto(deepseek.url, { waitUntil: 'domcontentloaded' });
  }

  private async exchange(message: string, attachments: string[]): Promise<ChatReply> {
    const page = this.requirePage();
    await this.waitUntilReady();
    const started = Date.now();
    const before = await page.locator(deepseek.message).count();

    if (attachments.length > 0) {
      await page.locator(deepseek.fileInput).first().setInputFiles(attachments);
    }

    // Listen before sending, so the reply stream cannot slip past.
    const streamStart = page
      .waitForResponse((r) => deepseek.completionUrl.test(r.url()) && r.request().method() === 'POST', {
        timeout: STREAM_START_MS,
      })
      .catch(() => undefined);

    const input = this.input();
    await input.fill(message);
    await this.submit(input, attachments.length > 0 ? 120_000 : 15_000);

    const response = await streamStart;
    const stream = response ? await this.readStream(response, started) : undefined;
    const parsed = stream === undefined ? undefined : parseCompletionStream(stream);
    if (parsed && parsed.content === '' && parsed.errors.length > 0) throw classify(parsed.errors.join(' '));

    let reply: Omit<ChatReply, 'durationMs' | 'raw'>;
    let shown: PageMessage | undefined;
    if (parsed && parsed.content !== '') {
      reply = {
        text: parsed.content,
        thinking: parsed.thinking || undefined,
        source: 'network',
        filtered: parsed.filtered,
      };
    } else {
      // No readable stream: read the reply from the page instead.
      if (response) await page.waitForTimeout(500);
      else await this.waitForPageReply(before, message, started);
      shown = await this.lastMessage();
      if (shown.text === '' || same(shown.text, message)) {
        throw new AdapterError('empty', 'The reply could not be read. Run with --debug and look at the session folder.');
      }
      const notice = providerNotice(shown.text);
      if (notice) throw notice;
      reply = { text: shown.text, thinking: shown.thinking || undefined, source: 'dom' };
    }

    const durationMs = Date.now() - started;
    if (!this.options.debug) return { ...reply, durationMs };
    if (!shown) {
      await page.waitForTimeout(500);
      shown = await this.lastMessage();
    }
    return { ...reply, durationMs, raw: { stream, html: shown.html } };
  }

  private async readStream(response: Response, started: number): Promise<string> {
    const left = Math.max(this.options.replyTimeoutMs - (Date.now() - started), 1_000);
    if ((await withTimeout(response.finished(), left)) === TIMED_OUT) {
      throw new AdapterError('timeout', `No complete reply after ${Math.round(this.options.replyTimeoutMs / 1000)}s.`);
    }
    const status = response.status();
    if (status === 429) throw new AdapterError('busy', 'DeepSeek is rate limiting requests (HTTP 429).');
    if (status >= 400) throw new AdapterError('provider', `DeepSeek answered HTTP ${status}.`);
    return response.text().catch(() => '');
  }

  /** Presses Enter until the box empties: at first an upload may still be processing. */
  private async submit(input: Locator, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    do {
      await input.press('Enter');
      if (await poll(async () => (await input.inputValue()) === '', 3_000)) return;
    } while (Date.now() < deadline);
    throw new AdapterError('send_failed', 'The message did not leave the input box. Look at the browser window.');
  }

  /** Fallback when no stream was seen: wait until a new reply stops changing on the page. */
  private async waitForPageReply(before: number, sent: string, started: number): Promise<void> {
    const page = this.requirePage();
    const deadline = started + this.options.replyTimeoutMs;
    let seen = '';
    let stillSince = Date.now();
    while (Date.now() < deadline) {
      const shown = await this.lastMessage();
      const isReply = shown.messages > before && shown.text !== '' && !same(shown.text, sent);
      if (isReply && shown.text !== seen) {
        seen = shown.text;
        stillSince = Date.now();
      } else if (isReply && Date.now() - stillSince >= PAGE_STILL_MS) {
        return;
      }
      await page.waitForTimeout(500);
    }
    throw new AdapterError('timeout', `No complete reply after ${Math.round(this.options.replyTimeoutMs / 1000)}s.`);
  }

  /** Returns once the message box shows; meanwhile the user logs in or passes a verification. */
  private async waitUntilReady(): Promise<void> {
    const page = this.requirePage();
    const input = this.input();
    const visible = (ms: number): Promise<boolean> =>
      input.waitFor({ state: 'visible', timeout: ms }).then(
        () => true,
        () => false,
      );
    if (await visible(READY_GRACE_MS)) return;
    let told = '';
    for (;;) {
      if (this.closed || page.isClosed()) throw new AdapterError('closed', 'The browser was closed.');
      const verifying = (await page.locator(deepseek.verification).count().catch(() => 0)) > 0;
      const notice = verifying
        ? 'DeepSeek is asking for a verification: complete it in the browser window and I will continue.'
        : 'Waiting for the DeepSeek chat. If you see the login page, log in in the browser window: the profile keeps the session, so it is needed only once.';
      if (notice !== told) {
        this.options.notify(notice);
        told = notice;
      }
      if (await visible(3_000)) return;
    }
  }

  private input(): Locator {
    const page = this.requirePage();
    return page.locator(deepseek.input).or(page.locator('textarea')).first();
  }

  private async lastMessage(): Promise<PageMessage> {
    const args = JSON.stringify({ message: deepseek.message, markdown: deepseek.markdown });
    return (await this.requirePage().evaluate(`(${LAST_MESSAGE})(${args})`)) as PageMessage;
  }

  private requirePage(): Page {
    if (this.closed || !this.page || this.page.isClosed()) {
      throw new AdapterError('closed', 'The browser was closed.');
    }
    return this.page;
  }

  /** Turns "target closed" failures into a clean 'closed' error. */
  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof AdapterError) && (this.closed || this.page?.isClosed() === true)) {
        throw new AdapterError('closed', 'The browser was closed.');
      }
      throw error;
    }
  }
}

const TIMED_OUT = Symbol('timed out');

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function poll(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check().catch(() => false)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function same(a: string, b: string): boolean {
  const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();
  return squash(a) === squash(b);
}

function classify(text: string): AdapterError {
  if (deepseek.limitText.some((pattern) => pattern.test(text))) return new AdapterError('limit', `DeepSeek: ${text}`);
  if (deepseek.busyText.some((pattern) => pattern.test(text))) return new AdapterError('busy', `DeepSeek: ${text}`);
  return new AdapterError('provider', `DeepSeek: ${text}`);
}

/** A short message on the page that is a notice ("server is busy", limits), not an answer. */
function providerNotice(text: string): AdapterError | undefined {
  if (text.length > 300) return undefined;
  const known = [...deepseek.busyText, ...deepseek.limitText].some((pattern) => pattern.test(text));
  return known ? classify(text) : undefined;
}
