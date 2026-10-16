import { chromium, type BrowserContext } from 'playwright';

export type BrowserChoice = 'auto' | 'chrome' | 'msedge' | 'chromium';

type InstalledBrowser = Exclude<BrowserChoice, 'auto'>;

export interface LaunchOptions {
  browser: BrowserChoice;
  /** Persistent profile: the user logs in once by hand and the session is kept. */
  profileDir: string;
  /**
   * Only for local test pages (the DeepSeek adapter refuses it on the real site): DeepSeek
   * is always driven in a visible window the user can take over.
   */
  headless?: boolean;
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
        headless: options.headless === true,
        viewport: null,
      });
      return { context, browser };
    } catch (error) {
      // Another browser has the profile open: the next browser on the same profile cannot help.
      if (PROFILE_IN_USE.test(error instanceof Error ? error.message : String(error))) {
        throw new Error(
          `The browser profile ${options.profileDir} is already open in another browser window. ` +
            'Close that window (only one browser can use a profile at a time) and try again.',
        );
      }
      failures.push(`${browser}: ${firstLine(error)}`);
    }
  }
  throw new Error(
    `Could not start a browser.\n  ${failures.join('\n  ')}\n` +
      'If the profile is already open in another window, close it. ' +
      'Otherwise install Chrome or Edge, or run "npx playwright install chromium".',
  );
}

/**
 * What Chromium says when another process holds the profile (ProcessSingleton and
 * SingletonLock on Linux and macOS). On Windows a second Chrome hands the profile over
 * to the first one and exits, which Playwright reports as a closed browser: that case
 * ends in the generic message above, which names it too.
 */
const PROFILE_IN_USE = /ProcessSingleton|SingletonLock|(?:profile|user data) directory is already in use/i;

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? message;
}
