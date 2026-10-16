/**
 * Reads the reply out of DeepSeek's completion stream.
 *
 * The stream is server-sent events whose data are JSON patches {p: path, o: op, v: value},
 * with SET, APPEND and BATCH ops; an event carrying only "v" continues the text field
 * written last. The reply sits in response.fragments (typed THINK, RESPONSE, ...) or, in
 * older builds, in response.content and response.thinking_content. Errors come as
 * "toast", "error" or "hint" events, or as a plain JSON body ({code, msg}) instead of a
 * stream. The format is not documented and has not been captured from a logged-in
 * session yet (docs/calibration.md), so anything unexpected is skipped and the caller
 * falls back to the page.
 */

export interface StreamReply {
  content: string;
  thinking: string;
  status: string | undefined;
  /** The provider swapped the answer for a canned one (content filter). */
  filtered: boolean;
  /** Error or toast messages sent in the stream. */
  errors: string[];
}

type JsonObject = Record<string, unknown>;

const TEXT_FIELD = /(?:^|\/)(?:content|thinking_content)$/;
/** Statuses after which DeepSeek writes nothing more into the reply. */
const DONE_STATUSES: ReadonlySet<string> = new Set(['FINISHED', 'CONTENT_FILTER']);
/** Named events that carry a notice for the user instead of a patch. */
const NOTICE_EVENTS: ReadonlySet<string> = new Set(['toast', 'error', 'hint']);

/**
 * True when the stream stopped while the reply was still marked in progress (WIP) or
 * cut short (INCOMPLETE): the page may go on showing more than the stream carried, for
 * example after an automatic "continue". A stream without a status counts as complete.
 */
export function endedEarly(reply: StreamReply): boolean {
  return reply.status !== undefined && !DONE_STATUSES.has(reply.status);
}

export function parseCompletionStream(body: string): StreamReply {
  const root: JsonObject = {};
  const errors: string[] = [];
  /** Where bare {"v": "..."} continuations are appended. */
  let textPath: string | undefined;

  const apply = (path: string, op: string | undefined, value: unknown): void => {
    if (op === 'BATCH') {
      if (!Array.isArray(value)) return;
      for (const sub of value) {
        if (isObject(sub) && typeof sub.p === 'string') {
          apply(`${path}/${sub.p}`, typeof sub.o === 'string' ? sub.o : 'SET', sub.v);
        }
      }
      return;
    }
    const effective = op ?? (typeof value === 'string' && TEXT_FIELD.test(path) ? 'APPEND' : 'SET');
    const target = getPath(root, path);
    if (effective === 'APPEND' && Array.isArray(value)) {
      const list: unknown[] = Array.isArray(target) ? target : [];
      list.push(...value);
      if (!Array.isArray(target)) setPath(root, path, list);
      const newest = list.at(-1);
      if (isObject(newest) && typeof newest.content === 'string') textPath = `${path}/-1/content`;
      return;
    }
    if (effective === 'APPEND' && Array.isArray(target)) {
      target.push(value);
      return;
    }
    if (effective === 'APPEND' && typeof value === 'string') {
      setPath(root, path, (typeof target === 'string' ? target : '') + value);
      textPath = path;
      return;
    }
    setPath(root, path, value);
    if (typeof value === 'string' && TEXT_FIELD.test(path)) textPath = path;
  };

  for (const { event, data } of readEvents(body)) {
    if (!isObject(data)) continue;
    if (NOTICE_EVENTS.has(event)) {
      const notice = noticeOf(event, data);
      if (notice !== undefined) errors.push(notice);
      continue;
    }
    if (!('v' in data)) {
      // Not a patch: "ready", "title", "close"... or an error envelope instead of a stream.
      const failure = envelopeError(data);
      if (failure !== undefined) errors.push(failure);
      continue;
    }
    const path = typeof data.p === 'string' ? data.p : undefined;
    const op = typeof data.o === 'string' ? data.o : undefined;
    if (path === undefined && op === undefined && isObject(data.v)) {
      // A snapshot of the whole state, usually the first event.
      deepMerge(root, data.v);
      textPath ??= initialTextPath(root);
      continue;
    }
    const target = path ?? textPath;
    if (target === undefined) continue;
    apply(target, op ?? (path === undefined ? 'APPEND' : undefined), data.v);
  }

  return extract(root, errors);
}

function* readEvents(body: string): Generator<{ event: string; data: unknown }> {
  let events = 0;
  for (const block of body.split(/\r?\n\r?\n/)) {
    let event = 'message';
    const lines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''));
    }
    if (lines.length === 0) continue;
    events += 1;
    try {
      yield { event, data: JSON.parse(lines.join('\n')) };
    } catch {
      // Keep-alives and plain text carry nothing to apply.
    }
  }
  // Refused requests (logged out, bad request) answer with plain JSON, not a stream.
  const trimmed = body.trim();
  if (events === 0 && trimmed.startsWith('{')) {
    try {
      yield { event: 'message', data: JSON.parse(trimmed) };
    } catch {
      // Not JSON either: nothing to read.
    }
  }
}

/** The message of a toast, error or hint event; a hint counts only when it is an error. */
function noticeOf(event: string, data: JsonObject): string | undefined {
  if (event === 'hint' && !/error|warn|fail/i.test(String(data.type ?? ''))) return undefined;
  const message = firstText(data.content, data.message, data.msg);
  if (message === undefined) return undefined;
  const reason = firstText(data.finish_reason);
  return reason === undefined ? message : `${message} (${reason})`;
}

/** DeepSeek's API envelopes: {code, msg} at the top, or {data: {biz_code, biz_msg}}. */
function envelopeError(data: JsonObject): string | undefined {
  if (typeof data.code === 'number' && data.code !== 0) return firstText(data.msg, data.message) ?? `error code ${data.code}`;
  const inner = data.data;
  if (isObject(inner) && typeof inner.biz_code === 'number' && inner.biz_code !== 0) {
    return firstText(inner.biz_msg) ?? `error code ${inner.biz_code}`;
  }
  return undefined;
}

function extract(root: JsonObject, errors: string[]): StreamReply {
  const response = isObject(root.response) ? root.response : root;
  let content = '';
  let thinking = '';
  let canned = '';
  if (Array.isArray(response.fragments)) {
    for (const fragment of response.fragments) {
      if (!isObject(fragment) || typeof fragment.content !== 'string') continue;
      const type = typeof fragment.type === 'string' ? fragment.type.toUpperCase() : 'RESPONSE';
      if (type === 'THINK' || type === 'THINKING') {
        thinking += fragment.content;
      } else if (type === 'RESPONSE' || type === 'ANSWER') {
        content += fragment.content;
      } else if (type === 'TEMPLATE_RESPONSE') {
        canned += fragment.content;
      }
      // TIP, WARNING, SEARCH and other fragments decorate the page; they are not the answer.
    }
  } else {
    if (typeof response.content === 'string') content = response.content;
    if (typeof response.thinking_content === 'string') thinking = response.thinking_content;
  }
  // The canned answer replaces whatever was streamed before it, as it does on the page.
  if (canned !== '') content = canned;
  let status = typeof response.status === 'string' ? response.status : undefined;
  const quasi = typeof response.quasi_status === 'string' ? response.quasi_status : undefined;
  if (quasi !== undefined && (status === undefined || (!DONE_STATUSES.has(status) && DONE_STATUSES.has(quasi)))) {
    status = quasi;
  }
  const filtered = canned !== '' || status === 'CONTENT_FILTER';
  return { content, thinking, status, filtered, errors };
}

function initialTextPath(root: JsonObject): string | undefined {
  const response = root.response;
  if (!isObject(response)) return undefined;
  if (Array.isArray(response.fragments) && response.fragments.length > 0) return 'response/fragments/-1/content';
  if (typeof response.content === 'string') return 'response/content';
  return undefined;
}

function getPath(root: JsonObject, path: string): unknown {
  let node: unknown = root;
  for (const key of path.split('/').filter(Boolean)) {
    if (Array.isArray(node)) node = node[key === '-1' ? node.length - 1 : Number(key)];
    else if (isObject(node)) node = node[key];
    else return undefined;
  }
  return node;
}

function setPath(root: JsonObject, path: string, value: unknown): void {
  const keys = path.split('/').filter(Boolean);
  let node: JsonObject | unknown[] = root;
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i] ?? '';
    const isLast = i === keys.length - 1;
    if (Array.isArray(node)) {
      const index = key === '-1' ? Math.max(node.length - 1, 0) : Number(key);
      if (isLast) {
        node[index] = value;
        return;
      }
      const next: unknown = node[index];
      if (isObject(next) || Array.isArray(next)) {
        node = next;
      } else {
        const fresh: JsonObject = {};
        node[index] = fresh;
        node = fresh;
      }
    } else {
      if (isLast) {
        node[key] = value;
        return;
      }
      const next: unknown = node[key];
      if (isObject(next) || Array.isArray(next)) {
        node = next;
      } else {
        const fresh: JsonObject = {};
        node[key] = fresh;
        node = fresh;
      }
    }
  }
}

function deepMerge(target: JsonObject, source: JsonObject): void {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    if (isObject(current) && isObject(value)) deepMerge(current, value);
    else target[key] = value;
  }
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === 'string' && value.trim() !== '') return value;
  return undefined;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
