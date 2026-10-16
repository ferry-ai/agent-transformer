/**
 * Everything that depends on DeepSeek's page lives here, so a UI change means editing
 * one file. Most of it comes from public userscripts (2025–2026), not from a logged-in
 * session yet: docs/calibration.md lists what was observed and what is still a guess,
 * and "npm run check" and "--debug" show what still matches.
 */
export const deepseek = {
  url: 'https://chat.deepseek.com/',
  /**
   * A logged-out profile lands here (observed: https://chat.deepseek.com/sign_in, page
   * title in Italian). Matched against the page URL.
   */
  signIn: /\/(?:sign_in|sign-in|login)(?:[/?#]|$)/,
  /** The message box. The page renders a single textarea. */
  input:
    'textarea#chat-input, textarea[placeholder*="DeepSeek"], textarea[placeholder*="essage"], textarea[placeholder*="essaggio"], textarea[placeholder*="消息"]',
  /**
   * One element per message, user and assistant alike. Two guesses: the first from the
   * userscripts, the second from the class names of DeepSeek's design system. When both
   * match, nested matches are folded into the outermost one.
   */
  message: '[data-message-id], .ds-message',
  /** Rendered Markdown in a message: the last block is the answer, earlier ones the reasoning. */
  markdown: '.ds-markdown',
  fileInput: 'input[type="file"]',
  /**
   * The toggle that turns visible reasoning on: a button whose text is the feature name.
   * The name is a brand ("DeepThink"), so it is not translated in the Italian UI; the
   * Chinese label covers the other UI language seen in the userscripts.
   */
  deepThinkButton: 'button, [role="button"]',
  deepThinkLabel: /DeepThink|深度思考/i,
  /** The streaming request that carries the reply. */
  completionUrl: /\/api\/v0\/chat\/completion(?:\?|$)/,
  /**
   * Toasts and alerts, where the page may say "server busy" or "too many requests"
   * instead of answering. Only texts matching the patterns below count. A guess: the
   * ARIA role is standard, the class follows the design system's "ds-" prefix.
   */
  notice: '[role="alert"], .ds-toast',
  /** Third-party verification widgets. When one shows up, the user takes over. */
  verification:
    'iframe[src*="captcha"], iframe[src*="challenge"], iframe[src*="turnstile"], iframe[src*="hcaptcha"], iframe[src*="recaptcha"]',
  /**
   * Notices the page or the stream shows instead of an answer, in the UI languages seen
   * so far (the page follows the browser language: Italian here). None is confirmed yet.
   * "busy" covers an overloaded server and rate limiting (retried with backoff); "limit"
   * covers usage and conversation-length limits (the user has to act).
   */
  busyText: [
    /server is busy/i,
    /server.{0,20}occupato/i,
    /服务器繁忙/,
    /too many requests/i,
    /too frequent/i,
    /rate.?limit/i,
    /troppe richieste/i,
    /troppo (?:frequent|spesso)/i,
    /请求过于频繁/,
  ],
  limitText: [/length limit/i, /limite di lunghezza/i, /lunghezza massima/i, /达到.*上限/],
  /** The session expired: the completion request is refused and the page goes to sign_in. */
  signedOutText: [/missing token/i, /invalid token/i, /authori[sz]ation failed/i, /not logged in/i, /login required/i],
  /**
   * The canned answer the content filter puts in place of a reply. The English text is
   * from public reports; the Italian one has not been seen yet.
   */
  filteredText: [/beyond my current scope/i, /超出了我目前的能力范围/, /我暂时无法回答/],
} as const;
