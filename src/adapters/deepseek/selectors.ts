/**
 * Everything that depends on DeepSeek's page lives here, so a UI change means editing
 * one file. Taken from public userscripts (2025–2026), not from a logged-in session yet:
 * "npm run check" and "--debug" show what still matches.
 */
export const deepseek = {
  url: 'https://chat.deepseek.com/',
  /** The message box. The page renders a single textarea. */
  input:
    'textarea#chat-input, textarea[placeholder*="DeepSeek"], textarea[placeholder*="essage"], textarea[placeholder*="消息"]',
  /** One element per message, user and assistant alike. */
  message: '[data-message-id]',
  /** Rendered Markdown in a message: the last block is the answer, earlier ones the reasoning. */
  markdown: '.ds-markdown',
  fileInput: 'input[type="file"]',
  /** The streaming request that carries the reply. */
  completionUrl: /\/api\/v0\/chat\/completion(?:\?|$)/,
  /** Third-party verification widgets. When one shows up, the user takes over. */
  verification:
    'iframe[src*="captcha"], iframe[src*="challenge"], iframe[src*="turnstile"], iframe[src*="hcaptcha"], iframe[src*="recaptcha"]',
  /**
   * Notices the page shows instead of an answer, in the UI languages seen so far
   * (the page follows the browser language: Italian here). Not all are confirmed yet.
   */
  busyText: [/server is busy/i, /server.{0,20}occupato/i, /服务器繁忙/],
  limitText: [/length limit/i, /too many requests/i, /troppe richieste/i, /达到.*上限/, /请求过于频繁/],
} as const;
