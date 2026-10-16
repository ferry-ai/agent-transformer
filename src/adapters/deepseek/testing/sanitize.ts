/**
 * Turns raw captures into fixtures without ids, tokens or personal data, and checks
 * fixtures for anything that slipped through. Used by scripts/deepseek/sanitize.ts and
 * check-fixtures.ts, and by the tests, which fail when a committed fixture does not
 * pass checkText. See docs/calibration.md for the whole recipe.
 */

/** Placeholders: numeric ids become 1001, 1002...; string ids "id-1", "id-2"...; UUIDs 00000000-...-000000000001. */
export const NUMBER_PLACEHOLDERS = { first: 1001, last: 1999 } as const;

/** Keys whose values identify a message, chat, session, user, file or request. */
const ID_KEYS = new Set([
  'message_id',
  'parent_id',
  'request_message_id',
  'response_message_id',
  'chat_session_id',
  'session_id',
  'chat_id',
  'conversation_id',
  'user_id',
  'file_id',
  'file_ids',
  'ref_file_ids',
  'request_id',
  'trace_id',
  'biz_id',
]);
/** Keys holding a time: they could tie a fixture to an account's history. */
const TIME_KEYS = /(?:^|_)(?:at|time|timestamp)$/;
/** Keys that hold an account's details, should one ever show up in a stream. */
const PERSONAL_KEYS = /^(?:email|mobile|phone(?:_number)?|nickname|user_?name|display_name|avatar(?:_url)?|token|access_token|refresh_token)$/i;

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g;
const LONG_HEX = /\b[0-9a-f]{32,}\b/gi;
/** Long runs of token characters with both letters and digits: API keys, session tokens. */
const LONG_TOKEN = /(?<![A-Za-z0-9_+/=-])(?=[A-Za-z0-9_+/=-]*\d)(?=[A-Za-z0-9_+/=-]*[A-Za-z])[A-Za-z0-9_+/=-]{40,}(?![A-Za-z0-9_+/=-])/g;
const USER_PATH = /[A-Za-z]:[\\/]+Users[\\/]+[^\\/"'<>\s]+|\/(?:Users|home)\/[^/"'<>\s]+/g;
/** HTML attributes naming a message, chat, session, user or file (data-message-id...), not data-testid. */
const ID_ATTRIBUTE = /\b(data-[\w-]*(?:message|msg|chat|session|user|file|conversation)[\w-]*(?:id|key))="([^"]*)"/gi;

/** One per capture session: the same id gets the same placeholder in the stream and in the HTML. */
export class IdMap {
  private readonly numbers = new Map<number, number>();
  private readonly strings = new Map<string, string>();
  private readonly uuids = new Map<string, string>();

  number(value: number): number {
    let placeholder = this.numbers.get(value);
    if (placeholder === undefined) {
      placeholder = NUMBER_PLACEHOLDERS.first + this.numbers.size;
      if (placeholder > NUMBER_PLACEHOLDERS.last) throw new Error('Too many ids in one session.');
      this.numbers.set(value, placeholder);
    }
    return placeholder;
  }

  string(value: string): string {
    if (/^\d+$/.test(value)) return String(this.number(Number(value)));
    let placeholder = this.strings.get(value);
    if (placeholder === undefined) {
      placeholder = `id-${this.strings.size + 1}`;
      this.strings.set(value, placeholder);
    }
    return placeholder;
  }

  uuid(value: string): string {
    const key = value.toLowerCase();
    let placeholder = this.uuids.get(key);
    if (placeholder === undefined) {
      placeholder = `00000000-0000-0000-0000-${String(this.uuids.size + 1).padStart(12, '0')}`;
      this.uuids.set(key, placeholder);
    }
    return placeholder;
  }
}

/** Replaces emails, UUIDs, tokens and user folders inside free text. */
export function scrubText(text: string, ids: IdMap): string {
  return text
    .replace(JWT, '<redacted-token>')
    .replace(UUID, (match) => (match.startsWith('00000000-0000-0000-0000-') ? match : ids.uuid(match)))
    .replace(EMAIL, (match) => (/@example\.(?:com|org|net)$/i.test(match) ? match : 'user@example.com'))
    .replace(LONG_HEX, '<redacted-hex>')
    .replace(LONG_TOKEN, '<redacted-token>')
    .replace(USER_PATH, '<user-folder>');
}

function scrubValue(value: unknown, ids: IdMap, key?: string): unknown {
  if (key !== undefined && ID_KEYS.has(key)) {
    if (typeof value === 'number') return ids.number(value);
    if (typeof value === 'string') return value === '' ? value : ids.string(value);
    if (Array.isArray(value)) return value.map((item) => scrubValue(item, ids, key));
  }
  if (key !== undefined && PERSONAL_KEYS.test(key) && typeof value === 'string' && value !== '') return '<redacted>';
  // Fragment ids are small counters; a string "id" (a file, a request) is not.
  if (key === 'id' && typeof value === 'string' && value !== '') return ids.string(value);
  if (key !== undefined && TIME_KEYS.test(key) && (typeof value === 'number' || typeof value === 'string')) {
    return typeof value === 'number' ? 0 : '1970-01-01T00:00:00Z';
  }
  if (typeof value === 'string') return scrubText(value, ids);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, ids));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubValue(v, ids, k)]));
  }
  return value;
}

/**
 * Sanitizes a completion stream: every JSON payload is walked (ids to placeholders,
 * times to zero, free text scrubbed) and written back compact; other lines are scrubbed.
 */
export function sanitizeStream(stream: string, ids: IdMap): string {
  const json = (text: string): string | undefined => {
    try {
      return JSON.stringify(scrubValue(JSON.parse(text), ids));
    } catch {
      return undefined;
    }
  };
  const lines = stream.replace(/\r\n/g, '\n').split('\n');
  const whole = stream.trim();
  // A refused request answers with plain JSON instead of events.
  if (whole.startsWith('{') && !lines.some((line) => line.startsWith('data:'))) return `${json(whole) ?? scrubText(whole, ids)}\n`;
  return lines
    .map((line) => {
      if (!line.startsWith('data:')) return scrubText(line, ids);
      const payload = line.slice(5).replace(/^ /, '');
      const clean = json(payload);
      return `data: ${clean ?? scrubText(payload, ids)}`;
    })
    .join('\n');
}

/** Sanitizes a message's HTML: id attributes, chat links, inline images and free text. */
export function sanitizeHtml(html: string, ids: IdMap): string {
  return scrubText(
    html
      .replace(ID_ATTRIBUTE, (_, name: string, value: string) => `${name}="${value === '' ? '' : ids.string(value)}"`)
      .replace(/\/a\/chat\/s\/([^"'?#/\s<]+)/g, (_, id: string) => `/a/chat/s/${ids.string(id)}`)
      .replace(/\b(src|srcset)="data:[^"]*"/gi, '$1=""'),
    ids,
  );
}

export interface Finding {
  file: string;
  line: number;
  rule: string;
  excerpt: string;
}

const PLACEHOLDER_STRING = /^(?:id-\d+|\d+|)$/;

/** Looks for anything a fixture must not carry. `deny` adds literal words (a name, an email). */
export function checkText(file: string, text: string, deny: string[] = []): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split(/\r?\n/);
  const rules: Array<[string, RegExp, (match: RegExpMatchArray) => boolean]> = [
    ['header', /^\s*(?:cookie|set-cookie|authorization)\s*:/gi, () => true],
    ['header', /"(?:cookie|set-cookie|authorization|x-ds-pow-response|x-hif-\w+)"\s*:/gi, () => true],
    ['bearer token', /bearer\s+[A-Za-z0-9._~+/-]{8,}/gi, () => true],
    ['jwt', new RegExp(JWT.source, 'g'), () => true],
    ['email', new RegExp(EMAIL.source, 'g'), (m) => !/@example\.(?:com|org|net)$/i.test(m[0])],
    ['uuid', new RegExp(UUID.source, 'gi'), (m) => !m[0].startsWith('00000000-0000-0000-0000-')],
    ['long hex', new RegExp(LONG_HEX.source, 'gi'), () => true],
    ['long token', new RegExp(LONG_TOKEN.source, 'g'), () => true],
    ['user folder', new RegExp(USER_PATH.source, 'g'), () => true],
    [
      'personal field',
      /"(?:email|mobile|phone(?:_number)?|nickname|user_?name|display_name|avatar(?:_url)?|token|access_token|refresh_token)"\s*:\s*"([^"]*)"/gi,
      (m) => m[1] !== '' && m[1] !== '<redacted>',
    ],
    [
      'numeric id',
      /"(?:message_id|parent_id|request_message_id|response_message_id|chat_id|user_id|file_id)"\s*:\s*(\d+)/g,
      (m) => !isPlaceholderNumber(Number(m[1])),
    ],
    [
      'string id',
      /"(?:chat_session_id|session_id|chat_id|conversation_id|user_id|file_id|request_id|trace_id|biz_id)"\s*:\s*"([^"]*)"/g,
      (m) => !PLACEHOLDER_STRING.test(m[1] ?? ''),
    ],
    ['id attribute', new RegExp(ID_ATTRIBUTE.source, 'gi'), (m) => !placeholderAttribute(m[2] ?? '')],
    ['chat link', /\/a\/chat\/s\/([^"'?#/\s<]+)/g, (m) => !/^id-\d+$/.test(m[1] ?? '')],
  ];
  lines.forEach((line, index) => {
    for (const [rule, pattern, bad] of rules) {
      for (const match of line.matchAll(pattern)) {
        if (bad(match)) findings.push({ file, line: index + 1, rule, excerpt: excerpt(line, match.index ?? 0) });
      }
    }
    for (const word of deny) {
      if (word.trim() === '') continue;
      const at = line.toLowerCase().indexOf(word.toLowerCase());
      if (at >= 0) findings.push({ file, line: index + 1, rule: 'denied word', excerpt: excerpt(line, at) });
    }
  });
  return findings;
}

function isPlaceholderNumber(value: number): boolean {
  return value >= NUMBER_PLACEHOLDERS.first && value <= NUMBER_PLACEHOLDERS.last;
}

function placeholderAttribute(value: string): boolean {
  return value === '' || /^id-\d+$/.test(value) || isPlaceholderNumber(Number(value));
}

function excerpt(line: string, at: number): string {
  // Never print a whole secret back: a short window, the middle masked.
  const window = line.slice(Math.max(0, at - 20), at + 40);
  return window.length > 24 ? `${window.slice(0, 20)}…${window.slice(-4)}` : window;
}
