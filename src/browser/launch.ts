import { chromium, type BrowserContext } from 'playwright';

export type BrowserChoice = 'auto' | 'chrome' | 'msedge' | 'chromium';

type InstalledBrowser = Exclude<BrowserChoice, 'auto'>;

export interface LaunchOptions {
  browser: BrowserChoice;
  /** Persistent profile: the user logs in once by hand and the session is kept. */
  profileDir: string;
}

export interface LaunchedBrowser {
  context: BrowserContext;
  browser: InstalledBrowser;
}

/**
 * Opens a visible browser on a persistent profile. On "auto" it tries the installed
 * Chrome, then Edge, then Playwright's own Chromium.
 *
 * No stealth tweaks on purpose: the browser keeps Playwright's default automation
 * flags (see "What it will never do" in the README).
 */
export async function launchBrowser(options: LaunchOptions): Promise<LaunchedBrowser> {
  const choice = options.browser;
  const candidates: InstalledBrowser[] = choice === 'auto' ? ['chrome', 'msedge', 'chromium'] : [choice];
  const failures: string[] = [];
  for (const browser of candidates) {
    try {
      const context = await chromium.launchPersistentContext(options.profileDir, {
        channel: browser === 'chromium' ? undefined : browser,
        headless: false,
        viewport: null,
      });
      return { context, browser };
    } catch (error) {
      failures.push(`${browser}: ${firstLine(error)}`);
    }
  }
  throw new Error(
    `Could not start a browser.\n  ${failures.join('\n  ')}\n` +
      'If the profile is already open in another window, close it. ' +
      'Otherwise install Chrome or Edge, or run "npx playwright install chromium".',
  );
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? message;
}
