import { readFileSync } from 'node:fs';
import type { BrowserContext, Locator, Page, Response } from 'playwright';
import { launchBrowser, type BrowserChoice } from '../../browser/launch.js';
import { AdapterError, type ChatAdapter, type ChatReply, type SendOptions } from '../../core/adapter.js';
import { deepseek } from './selectors.js';
import { endedEarly, parseCompletionStream } from './stream.js';

/** Page-side function that renders the last message as Markdown. */
const LAST_MESSAGE = readFileSync(new URL('../../browser/last-message.js', import.meta.url), 'utf8');

/** How long the reply stream may take to start before we fall back to watching the page. */
const STREAM_START_MS = 30_000;
/** When watching the page, a reply is complete once its text has been still this long. */
const PAGE_STILL_MS = 5_000;
/** After a finished stream the page needs only a moment to show the reply. */
const AFTER_STREAM_MS = 10_000;
const AFTER_STREAM_STILL_MS = 1_000;
/** Silent wait for the chat to show up before asking the user to step in. */
const READY_GRACE_MS = 10_000;
/** With nobody to step in, the longest wait for the message box on a page that is still loading. */
const READY_UNATTENDED_MS = 30_000;
/** Debug captures wait until the rendered message has been still this long (at most SETTLE_MAX_MS). */
const SETTLE_STILL_MS = 1_000;
const SETTLE_MAX_MS = 10_000;

export interface DeepSeekOptions {
  profileDir: string;
  browser: BrowserChoice;
  /** Longest wait for a complete reply. */
  replyTimeoutMs: number;
  /** Keep the raw stream and HTML of each reply, to recalibrate parser and selectors. */
  debug: boolean;
  /** Messages for the user: browser opened, login needed, verification shown. */
  notify: (message: string) => void;
  /**
   * On the sign-in page or a verification, wait for the user to deal with it in the
   * browser window (true), or fail at once with an error that says what to do (false).
   * Default: wait only when stdin and stdout are a terminal, so that a script or a
   * --task run without one never hangs on a login nobody is there to do.
   */
  waitForUser?: boolean;
  /** The chat page. Only tests change it, to point at a local copy of the site. */
  url?: string;
  /** Only for a local test page: DeepSeek itself is always driven in a visible window. */
  headless?: boolean;
}

export interface InspectReport {
  browser: string;
  url: string;
  title: string;
  inputVisible: boolean;
  /** The page is DeepSeek's sign-in page: the profile is not logged in. */
  signInPage: boolean;
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

/** What keeps the message box from showing. */
type Blocker = 'sign-in' | 'verification' | 'loading';

/**
 * Talks to chat.deepseek.com through a real, visible browser. The reply is read from
 * the completion stream when its format is understood, otherwise from the page.
 */
export class DeepSeekWebAdapter implements ChatAdapter {
  readonly name = 'deepseek-web';
  private readonly options: DeepSeekOptions;
  private readonly url: string;
  private readonly waitForUser: boolean;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private browser = '';
  private closed = false;

  constructor(options: DeepSeekOptions) {
    this.url = options.url ?? deepseek.url;
    if (options.headless === true && /(?:^|\.)deepseek\.com$/i.test(new URL(this.url).hostname)) {
      throw new Error('DeepSeek is only driven in a visible browser window: headless is for local test pages.');
    }
    this.waitForUser = options.waitForUser ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
    this.options = options;
  }

  async open(): Promise<void> {
    await this.guard(async () => {
      await this.launch();
      await this.waitUntilReady();
    });
  }

  /**
   * Opens the page and reports what the connector sees, without waiting for a login.
   * The browser stays open: close() the adapter, or go on and send() with it.
   */
  async inspect(): Promise<InspectReport> {
    return this.guard(async () => {
      await this.launch();
      const page = this.requirePage();
      const inputVisible = await this.readyWithin(READY_GRACE_MS);
      const signInPage = deepseek.signIn.test(page.url());
      if (signInPage) this.options.notify(SIGN_IN_HELP);
      return {
        browser: this.browser,
        url: page.url(),
        title: await page.title(),
        inputVisible,
        signInPage,
        messages: (await this.lastMessage()).messages,
        markdownBlocks: await page.locator(deepseek.markdown).count(),
        fileInputs: await page.locator(deepseek.fileInput).count(),
        verificationFrames: await page.locator(deepseek.verification).count(),
      };
    });
  }

  async newChat(): Promise<void> {
    await this.guard(async () => {
      await this.requirePage().goto(this.url, { waitUntil: 'domcontentloaded' });
      await this.waitUntilReady();
    });
  }

  async send(message: string, options: SendOptions = {}): Promise<ChatReply> {
    return this.guard(() => this.exchange(message, options.attachments ?? []));
  }

  /**
   * Turns DeepThink (visible reasoning) on or off for the next messages. Returns the
   * state the page shows afterwards, or undefined when there is no toggle or its state
   * cannot be read (then it clicks once when asked to turn it on). DeepSeek only: not
   * part of ChatAdapter.
   */
  async setDeepThink(enabled: boolean): Promise<boolean | undefined> {
    return this.guard(async () => {
      const page = this.requirePage();
      await this.waitUntilReady();
      const button = page.locator(deepseek.deepThinkButton).filter({ hasText: deepseek.deepThinkLabel }).first();
      if ((await button.count()) === 0) return undefined;
      const before = await toggleState(button);
      if (before === enabled || (before === undefined && !enabled)) return before;
      await button.click();
      await page.waitForTimeout(300);
      return toggleState(button);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.context?.close().catch(() => undefined);
  }

  private async launch(): Promise<void> {
    const { context, browser } = await launchBrowser({
      browser: this.options.browser,
      profileDir: this.options.profileDir,
      headless: this.options.headless === true,
    });
    this.context = context;
    this.browser = browser;
    context.on('close', () => {
      this.closed = true;
    });
    this.page = context.pages()[0] ?? (await context.newPage());
    this.options.notify(`Opened ${browser} with the profile in ${this.options.profileDir}`);
    await this.page.goto(this.url, { waitUntil: 'domcontentloaded' });
  }

  private async exchange(message: string, attachments: string[]): Promise<ChatReply> {
    const page = this.requirePage();
    await this.waitUntilReady();
    const started = Date.now();
    // Counted like lastMessage() counts, nested matches folded into one message.
    const before = (await this.lastMessage()).messages;
    const noticesBefore = new Set(await this.notices());

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
    await this.submit(input, attachments.length > 0 ? 120_000 : 15_000, noticesBefore);

    const response = await streamStart;
    const stream = response ? await this.readStream(response, started) : undefined;
    const parsed = stream === undefined ? undefined : parseCompletionStream(stream);
    if (parsed && parsed.content === '' && parsed.errors.length > 0) throw classify(parsed.errors.join(' '));

    const wait: PageWait = { before, sent: message, started, noticesBefore };
    let reply: Omit<ChatReply, 'durationMs' | 'raw'>;
    if (parsed && parsed.content !== '') {
      reply = {
        text: parsed.content,
        thinking: parsed.thinking || undefined,
        source: 'network',
        filtered: parsed.filtered,
      };
      if (endedEarly(parsed)) {
        // The stream stopped before DeepSeek marked the reply finished: if the page goes
        // on (an automatic "continue"), the page has the whole reply.
        const shown = await this.pageAfterEarlyEnd(wait);
        if (shown && goesBeyond(shown.text, parsed.content)) {
          reply = { ...reply, text: shown.text, thinking: shown.thinking || reply.thinking, source: 'dom' };
        }
      }
    } else {
      // No readable stream: read the reply from the page instead. After a finished
      // stream the page shows it almost at once; without one, wait until it is still.
      if (response) await this.waitForPageReply(wait, AFTER_STREAM_STILL_MS, Date.now() + AFTER_STREAM_MS).catch(unlessTimeout);
      else await this.waitForPageReply(wait, PAGE_STILL_MS, started + this.options.replyTimeoutMs);
      const shown = await this.lastMessage();
      if (shown.text === '' || same(shown.text, message)) {
        throw new AdapterError('empty', 'The reply could not be read. Run with --debug and look at the session folder.');
      }
      const notice = providerNotice(shown.text);
      if (notice) throw notice;
      reply = { text: shown.text, thinking: shown.thinking || undefined, source: 'dom', filtered: cannedAnswer(shown.text) };
    }

    const durationMs = Date.now() - started;
    if (!this.options.debug) return { ...reply, durationMs };
    // For calibration, keep the message as the page shows it once it has stopped changing.
    const settled = await this.settledMessage();
    return { ...reply, durationMs, raw: { stream, html: settled.html } };
  }

  private async readStream(response: Response, started: number): Promise<string> {
    const left = Math.max(this.options.replyTimeoutMs - (Date.now() - started), 1_000);
    if ((await withTimeout(response.finished(), left)) === TIMED_OUT) {
      throw new AdapterError('timeout', `No complete reply after ${Math.round(this.options.replyTimeoutMs / 1000)}s.`);
    }
    const status = response.status();
    if (status === 429) throw new AdapterError('busy', 'DeepSeek is rate limiting requests (HTTP 429).');
    if (status === 401) throw signedOut('HTTP 401');
    if (status >= 400) {
      // The body of a refused request often says why ({code, msg}).
      const body = await response.text().catch(() => '');
      const why = parseCompletionStream(body).errors.join(' ');
      throw why === '' ? new AdapterError('provider', `DeepSeek answered HTTP ${status}.`) : classify(`${why} (HTTP ${status})`);
    }
    return response.text().catch(() => '');
  }

  /** Presses Enter until the box empties: at first an upload may still be processing. */
  private async submit(input: Locator, timeoutMs: number, noticesBefore: ReadonlySet<string>): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    do {
      await input.press('Enter');
      if (await poll(async () => (await input.inputValue()) === '', 3_000)) return;
      // A notice ("server busy", "too many requests") explains why the message stays.
      const notice = await this.newNotice(noticesBefore);
      if (notice) throw notice;
    } while (Date.now() < deadline);
    throw new AdapterError('send_failed', 'The message did not leave the input box. Look at the browser window.');
  }

  /**
   * Waits until a new reply on the page has stopped changing for stillMs. A notice the
   * page pops up meanwhile (busy, rate limit, logged out) ends the wait with its error.
   */
  private async waitForPageReply(wait: PageWait, stillMs: number, deadline: number): Promise<void> {
    const page = this.requirePage();
    let seen = '';
    let stillSince = Date.now();
    while (Date.now() < deadline) {
      const shown = await this.lastMessage();
      const isReply = shown.messages > wait.before && shown.text !== '' && !same(shown.text, wait.sent);
      if (isReply && shown.text !== seen) {
        seen = shown.text;
        stillSince = Date.now();
      } else if (isReply && Date.now() - stillSince >= stillMs) {
        return;
      } else if (!isReply) {
        const notice = await this.newNotice(wait.noticesBefore);
        if (notice) throw notice;
      }
      await page.waitForTimeout(Math.min(500, stillMs / 2));
    }
    throw new AdapterError('timeout', `No complete reply after ${Math.round((deadline - wait.started) / 1000)}s.`);
  }

  /** After a stream that ended early: the reply on the page once still, if the page shows one. */
  private async pageAfterEarlyEnd(wait: PageWait): Promise<PageMessage | undefined> {
    await this.requirePage().waitForTimeout(500);
    const first = await this.lastMessage();
    if (first.messages <= wait.before || first.text === '' || same(first.text, wait.sent)) return undefined;
    try {
      await this.waitForPageReply(wait, PAGE_STILL_MS, wait.started + this.options.replyTimeoutMs);
    } catch (error) {
      if (error instanceof AdapterError && error.kind === 'timeout') return undefined;
      throw error;
    }
    return this.lastMessage();
  }

  /** The last message once its text has been still for a moment: what a debug capture keeps. */
  private async settledMessage(): Promise<PageMessage> {
    const page = this.requirePage();
    const deadline = Date.now() + SETTLE_MAX_MS;
    let last = await this.lastMessage();
    let stillSince = Date.now();
    while (Date.now() - stillSince < SETTLE_STILL_MS && Date.now() < deadline) {
      await page.waitForTimeout(250);
      const next = await this.lastMessage();
      if (next.text !== last.text || next.thinking !== last.thinking || next.messages !== last.messages) stillSince = Date.now();
      last = next;
    }
    return last;
  }

  /** Waits up to ms for the message box, giving up at once on the sign-in page or a verification. */
  private async readyWithin(ms: number): Promise<boolean> {
    const page = this.requirePage();
    const input = this.input();
    const deadline = Date.now() + ms;
    for (;;) {
      if (await input.isVisible().catch(() => false)) return true;
      if (Date.now() >= deadline || (await this.blocker()) !== 'loading') return false;
      await page.waitForTimeout(250);
    }
  }

  private async blocker(): Promise<Blocker> {
    const page = this.requirePage();
    if (deepseek.signIn.test(page.url())) return 'sign-in';
    const verifying = (await page.locator(deepseek.verification).count().catch(() => 0)) > 0;
    return verifying ? 'verification' : 'loading';
  }

  /**
   * Returns once the message box shows. With a user at the terminal it waits while they
   * log in or pass a verification in the browser window; without one it fails at once.
   */
  private async waitUntilReady(): Promise<void> {
    const page = this.requirePage();
    const input = this.input();
    const visible = (ms: number): Promise<boolean> =>
      input.waitFor({ state: 'visible', timeout: ms }).then(
        () => true,
        () => false,
      );
    if (await this.readyWithin(this.waitForUser ? READY_GRACE_MS : READY_UNATTENDED_MS)) return;
    let told = '';
    for (;;) {
      if (this.closed || page.isClosed()) throw new AdapterError('closed', 'The browser was closed.');
      const blocker = await this.blocker();
      if (!this.waitForUser) throw unattended(blocker);
      const notice =
        blocker === 'verification'
          ? 'DeepSeek is asking for a verification: complete it in the browser window and I will continue.'
          : blocker === 'sign-in'
            ? 'DeepSeek shows its sign-in page: log in in the browser window and I will continue. The profile keeps the session, so it is needed only once.'
            : 'Waiting for the DeepSeek chat. If you see the login page, log in in the browser window: the profile keeps the session, so it is needed only once.';
      if (notice !== told) {
        this.options.notify(notice);
        told = notice;
      }
      if (await visible(3_000)) return;
    }
  }

  /** Short texts of the toasts and alerts on the page. */
  private async notices(): Promise<string[]> {
    const texts = await this.requirePage()
      .locator(deepseek.notice)
      .allInnerTexts()
      .catch(() => [] as string[]);
    return texts.map((text) => text.trim()).filter((text) => text !== '' && text.length <= 300);
  }

  /** A known provider notice that was not on the page before the message was sent. */
  private async newNotice(before: ReadonlySet<string>): Promise<AdapterError | undefined> {
    for (const text of await this.notices()) {
      if (before.has(text)) continue;
      const error = providerNotice(text);
      if (error) return error;
    }
    return undefined;
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

interface PageWait {
  /** Messages on the page before this one was sent. */
  before: number;
  sent: string;
  started: number;
  noticesBefore: ReadonlySet<string>;
}

const SIGN_IN_HELP =
  'DeepSeek shows its sign-in page: this browser profile is not logged in. Run "npm run chat" and log in in the browser window; the profile keeps the session.';

/** The message box is not there and nobody is at the terminal to fix it. */
function unattended(blocker: Blocker): AdapterError {
  switch (blocker) {
    case 'sign-in':
      return new AdapterError('provider', SIGN_IN_HELP);
    case 'verification':
      return new AdapterError(
        'provider',
        'DeepSeek is asking for a verification. Run "npm run chat" in a terminal and complete it in the browser window.',
      );
    default:
      return new AdapterError(
        'timeout',
        `The DeepSeek chat did not show its message box within ${READY_UNATTENDED_MS / 1000}s. Run "npm run check" to see what the page shows.`,
      );
  }
}

/** Lets a 'timeout' AdapterError pass and rethrows anything else. */
function unlessTimeout(error: unknown): void {
  if (!(error instanceof AdapterError) || error.kind !== 'timeout') throw error;
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

/** The state of a toggle button, from ARIA or from its class names; undefined when neither says. */
async function toggleState(button: Locator): Promise<boolean | undefined> {
  const state = await button
    .evaluate((element) => {
      const aria = element.getAttribute('aria-pressed') ?? element.getAttribute('aria-checked');
      if (aria === 'true' || aria === 'false') return aria;
      const classes = typeof element.className === 'string' ? element.className : '';
      if (/(?:^|[\s_-])(?:selected|active|checked)(?:$|[\s_-])/i.test(classes)) return 'true';
      if (/toggle/i.test(classes)) return 'false';
      return 'unknown';
    })
    .catch(() => 'unknown');
  return state === 'unknown' ? undefined : state === 'true';
}

function same(a: string, b: string): boolean {
  const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();
  return squash(a) === squash(b);
}

/** True when the page text is the streamed text and more (letters and digits compared only). */
function goesBeyond(page: string, streamed: string): boolean {
  const letters = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const shown = letters(page);
  const sent = letters(streamed);
  return shown.length > sent.length && shown.startsWith(sent.slice(0, 40));
}

function signedOut(detail: string): AdapterError {
  return new AdapterError(
    'provider',
    `DeepSeek refused the message (${detail}): the session has probably expired. Log in again in the browser window ("npm run chat").`,
  );
}

function classify(text: string): AdapterError {
  if (deepseek.signedOutText.some((pattern) => pattern.test(text))) return signedOut(text);
  if (deepseek.limitText.some((pattern) => pattern.test(text))) return new AdapterError('limit', `DeepSeek: ${text}`);
  if (deepseek.busyText.some((pattern) => pattern.test(text))) return new AdapterError('busy', `DeepSeek: ${text}`);
  return new AdapterError('provider', `DeepSeek: ${text}`);
}

/** A short text on the page that is a notice (busy, limits, logged out), not an answer. */
function providerNotice(text: string): AdapterError | undefined {
  if (text.length > 300) return undefined;
  const known = [...deepseek.busyText, ...deepseek.limitText, ...deepseek.signedOutText].some((pattern) => pattern.test(text));
  return known ? classify(text) : undefined;
}

/** A short reply that is the content filter's canned answer. */
function cannedAnswer(text: string): boolean | undefined {
  return text.length <= 300 && deepseek.filteredText.some((pattern) => pattern.test(text)) ? true : undefined;
}
