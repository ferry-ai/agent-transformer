/**
 * Redaction of obvious secrets in command and MCP output, before it reaches the chat:
 * private key blocks and the token formats that announce themselves (AWS, GitHub,
 * Slack). It is a safety net for a stray "cat" or "env", not a guarantee: a secret in
 * any other shape goes through.
 *
 * A redacted text must never be written back over the file it came from, or the
 * secret would be lost: every replacement carries REDACTION_MARK, and the toolbox
 * refuses any call whose arguments contain it.
 */

export const REDACTION_MARK = 'REDACTED by agent-transformer';

const PATTERNS: readonly { kind: string; pattern: RegExp; keep?: number }[] = [
  // Whole blocks, then a block cut by truncation: everything from its header on.
  { kind: 'private key', pattern: /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY( BLOCK)?-----[\s\S]*?-----END \1PRIVATE KEY\2-----/g },
  { kind: 'private key', pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[A-Za-z0-9+/=\s:,.-]*/g },
  { kind: 'AWS access key', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|AROA|APKA)[A-Z0-9]{16}\b/g },
  // The value after a name that says what it is; the name is kept.
  { kind: 'AWS secret key', pattern: /((?:aws_?secret_?access_?key|secretaccesskey)["']?\s*[:=]\s*["']?)[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/gi, keep: 1 },
  { kind: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g },
  { kind: 'Slack token', pattern: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}\b|\bxapp-\d-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'Slack webhook', pattern: /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9/_-]+/g },
];

export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const { kind, pattern, keep } of PATTERNS) {
    out = out.replace(pattern, (...match: unknown[]) => {
      count += 1;
      const kept = keep === undefined ? '' : String(match[keep] ?? '');
      return `${kept}[${REDACTION_MARK}: ${kind}]`;
    });
  }
  return { text: out, count };
}

/** Whether a value (a string, or the strings in an object or list) holds a redaction mark. */
export function holdsRedaction(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(REDACTION_MARK);
  if (Array.isArray(value)) return value.some(holdsRedaction);
  if (typeof value === 'object' && value !== null) return Object.values(value).some(holdsRedaction);
  return false;
}
