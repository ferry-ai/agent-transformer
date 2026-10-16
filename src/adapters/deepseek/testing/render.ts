import { readFileSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { deepseek } from '../selectors.js';
import type { PageExpectation } from './fixtures.js';

const LAST_MESSAGE = readFileSync(new URL('../../../browser/last-message.js', import.meta.url), 'utf8');

/**
 * Reads recorded message HTML with the page script and the selectors the adapter uses,
 * in a headless browser with every request blocked: no network, no site.
 */
export class PageRenderer {
  private readonly browser: Browser;

  private constructor(browser: Browser) {
    this.browser = browser;
  }

  /** undefined when no Chromium-based browser can start (the page tests then skip). */
  static async start(): Promise<PageRenderer | undefined> {
    for (const channel of ['chrome', 'msedge', undefined] as const) {
      try {
        return new PageRenderer(await chromium.launch({ channel, headless: true }));
      } catch {
        // Try the next browser.
      }
    }
    return undefined;
  }

  async render(html: string): Promise<PageExpectation> {
    const page = await this.browser.newPage();
    try {
      await page.route('**/*', (route) => route.abort());
      await page.setContent(`<main>${html}</main>`);
      const args = JSON.stringify({ message: deepseek.message, markdown: deepseek.markdown });
      const result = (await page.evaluate(`(${LAST_MESSAGE})(${args})`)) as { text: string; thinking: string };
      return { text: result.text, thinking: result.thinking };
    } finally {
      await page.close();
    }
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}
