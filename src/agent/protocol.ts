/**
 * The text protocol that stands in for function calling. A web chat only writes
 * Markdown, so a tool call is a fenced block tagged "tool": a JSON line with the name
 * and arguments, then optional free text (file contents, commands) that needs no
 * escaping. Results go back to the chat as an ordinary message.
 *
 *   ```tool
 *   {"tool": "write_file", "args": {"path": "hello.py"}}
 *   print("hello")
 *   ```
 *
 * The parser is lenient on purpose: it accepts the slips models make (raw newlines in
 * JSON strings, trailing commas, OpenAI-style "name"/"arguments", unlabeled blocks when
 * the page lost the language tag) and reports the rest as errors the model can fix.
 */

export interface ToolCall {
  /** Position in the reply, from 1, counting malformed blocks too. */
  index: number;
  tool: string;
  args: Record<string, unknown>;
  /** The free text after the JSON line, when there is some. */
  body?: string;
}

export interface CallError {
  index: number;
  tool?: string;
  message: string;
}

export type ParsedBlock = { kind: 'call'; call: ToolCall } | { kind: 'error'; error: CallError };

export interface ParseOptions {
  /** Lets an unlabeled ``` or ```json block count as a call when it names a known tool. */
  isTool?: (name: string) => boolean;
}

/** Info strings that mark a tool block. The first word is compared, ignoring case. */
const TOOL_INFO = new Set(['tool', 'tool_call', 'tool-call', 'toolcall', 'tool_use']);
/** Info strings of blocks that may be a tool call whose tag got lost. */
const MAYBE_INFO = new Set(['', 'json', 'json5', 'jsonc']);
const NAME_KEYS = ['tool', 'name', 'tool_name'] as const;
const ARGS_KEYS = ['args', 'arguments', 'parameters', 'params', 'input'] as const;

/** Finds the tool calls in a reply, in order. Prose and other code blocks are ignored. */
export function parseToolCalls(text: string, options: ParseOptions = {}): ParsedBlock[] {
  return scan(text, options).map((found) => found.block);
}

/** The reply without its tool blocks: what the model says to the user around the calls. */
export function proseOf(text: string, options: ParseOptions = {}): string {
  const lines = text.split(/\r?\n/);
  for (const { fence } of scan(text, options).reverse()) lines.splice(fence.start, fence.end - fence.start + 1);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function scan(text: string, options: ParseOptions): { block: ParsedBlock; fence: Fence }[] {
  const found: { block: ParsedBlock; fence: Fence }[] = [];
  const push = (block: ParsedBlock, fence: Fence): number => found.push({ block, fence });
  for (const fence of fences(text)) {
    const [first = '', hint] = fence.info.split(/\s+/);
    const tagged = TOOL_INFO.has(first.toLowerCase());
    if (!tagged && !MAYBE_INFO.has(first.toLowerCase())) continue;

    const index = found.length + 1;
    const parsed = parseBlock(fence.content, tagged ? hint : undefined);
    if (!tagged) {
      // Untagged: only a well-formed call to a known tool counts, everything else is just code.
      if ('call' in parsed && parsed.explicitName && options.isTool?.(parsed.call.tool)) {
        push({ kind: 'call', call: { ...parsed.call, index } }, fence);
      }
      continue;
    }
    if (!fence.closed) {
      push({ kind: 'error', error: { index, tool: toolName(parsed), message: NOT_CLOSED } }, fence);
    } else if ('error' in parsed) {
      push({ kind: 'error', error: { index, tool: parsed.tool, message: parsed.error } }, fence);
    } else {
      push({ kind: 'call', call: { ...parsed.call, index } }, fence);
    }
  }
  return found;
}

/** Tags of native function calling (other chat UIs, model special tokens), which this runner does not read. */
const CALL_TAGS = /<\/?\s*(tool_call|tool_calls|tool_use|function_call|function_calls|invoke)\b|<[|｜]\s*tool[▁_]/i;
/** The name field of a JSON line that calls a tool. */
const JSON_CALL = /"(?:tool|name|tool_name)"\s*:\s*"([^"\\]+)"/;

/**
 * For a reply with no tool block: does it try to call a tool anyway? A JSON call line
 * outside any fence (or in an untagged or json fence it broke), or a function-calling
 * tag. Says what it found, or undefined. Prose that only names a tool does not count.
 */
export function looksLikeUnfencedCall(text: string, isTool: (name: string) => boolean): string | undefined {
  const lines = text.split(/\r?\n/);
  const hidden = new Set<number>();
  for (const fence of fences(text)) {
    // Untagged and json blocks stay visible: a call whose tag got lost is still a call.
    if (MAYBE_INFO.has((fence.info.split(/\s+/)[0] ?? '').toLowerCase())) continue;
    for (let i = fence.start; i <= fence.end; i += 1) hidden.add(i);
  }
  const visible = lines.filter((_, i) => !hidden.has(i));
  const tag = CALL_TAGS.exec(visible.join('\n'));
  if (tag) return `a function-calling tag (${tag[0].trim()}…)`;
  for (const line of visible) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    const name = JSON_CALL.exec(trimmed)?.[1]?.trim();
    if (name !== undefined && isTool(name)) return `a JSON line that calls ${name}`;
  }
  return undefined;
}

export interface CallResult {
  index: number;
  tool: string;
  ok: boolean;
  text: string;
}

/** The message that carries results back: one fenced block per call, then a footer. */
export function formatResults(results: CallResult[], footer: string): string {
  const parts = results.map((result) => {
    const status = result.ok ? 'ok' : 'error';
    const fence = fenceFor(result.text);
    return `[${result.index}] ${result.tool}: ${status}\n${fence}text\n${result.text}\n${fence}`;
  });
  return [`Tool results:`, ...parts, footer].join('\n\n');
}

/** A backtick fence longer than any run of backticks in the text, so it cannot close early. */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

const NOT_CLOSED =
  'The tool block is not closed: the reply may have been cut off. Send the call again, complete, in a new reply.';

interface Fence {
  info: string;
  content: string;
  closed: boolean;
  /** First and last line of the block, fences included. */
  start: number;
  end: number;
}

/**
 * Fenced blocks as CommonMark reads them, with one tolerance for tool blocks: a line
 * like ```python inside them opens a nested block whose bare ``` does not close the
 * tool block. Models often forget to lengthen the outer fence when writing Markdown.
 */
function fences(text: string): Fence[] {
  const lines = text.split(/\r?\n/);
  const found: Fence[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(lines[i] ?? '');
    if (!open) continue;
    const [, indent = '', marker = '', rest = ''] = open;
    if (marker.startsWith('`') && rest.includes('`')) continue; // ```inline``` on one line
    const start = i;
    const info = rest.trim();
    const tolerant = TOOL_INFO.has((info.split(/\s+/)[0] ?? '').toLowerCase());
    const body: string[] = [];
    let closed = false;
    let nested = 0;
    for (i += 1; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        const [, run = '', after = ''] = fence;
        const sameKind = run[0] === marker[0];
        if (after.trim() === '' && sameKind && run.length >= marker.length) {
          if (nested === 0) {
            closed = true;
            break;
          }
          nested -= 1;
        } else if (tolerant && sameKind && after.trim() !== '' && !after.includes('`')) {
          nested += 1;
        }
      }
      body.push(dedent(line, indent.length));
    }
    found.push({ info, content: body.join('\n'), closed, start, end: Math.min(i, lines.length - 1) });
  }
  return found;
}

function dedent(line: string, width: number): string {
  let cut = 0;
  while (cut < width && line[cut] === ' ') cut += 1;
  return line.slice(cut);
}

type BlockParse = { call: ToolCall; explicitName: boolean } | { error: string; tool?: string };

function toolName(parsed: BlockParse): string | undefined {
  return 'call' in parsed ? parsed.call.tool : parsed.tool;
}

function parseBlock(content: string, nameHint: string | undefined): BlockParse {
  const source = content.replace(/^\s+/, '');
  let header: Record<string, unknown>;
  let rest: string;
  let explicitName = true;

  if (source.startsWith('{')) {
    const end = objectEnd(source);
    if (end < 0) return { error: 'The JSON line is not closed: check its braces and quotes.' };
    const value = parseLenientJson(source.slice(0, end));
    if ('error' in value) return { error: `The JSON line is not valid JSON (${value.error}).${ESCAPE_HINT}` };
    if (!isRecord(value.value)) return { error: 'The JSON line must be an object: {"tool": "name", "args": {...}}.' };
    header = value.value;
    rest = source.slice(end);
  } else {
    // Tolerated shorthand: the tool name, then its arguments as JSON.
    const named = /^([A-Za-z_][\w.-]*)[ \t]*/.exec(source);
    if (!named?.[1]) return { error: 'A tool block starts with a JSON line: {"tool": "name", "args": {...}}.' };
    explicitName = false;
    rest = source.slice(named[0].length);
    let args: unknown = {};
    if (rest.startsWith('{')) {
      const end = objectEnd(rest);
      if (end < 0) return { error: 'The JSON arguments are not closed: check their braces and quotes.', tool: named[1] };
      const value = parseLenientJson(rest.slice(0, end));
      if ('error' in value) {
        return { error: `The arguments are not valid JSON (${value.error}).${ESCAPE_HINT}`, tool: named[1] };
      }
      args = value.value;
      rest = rest.slice(end);
    }
    header = { tool: named[1], args };
  }

  // What follows the JSON on its line must be blank; the body starts on the next line.
  const newline = rest.indexOf('\n');
  const tail = newline < 0 ? rest : rest.slice(0, newline);
  const name = headerName(header) ?? nameHint;
  if (tail.trim() !== '') {
    return { error: `Unexpected text after the JSON line: "${tail.trim().slice(0, 40)}".`, tool: name };
  }
  if (name === undefined) return { error: 'The JSON line has no "tool" field with the tool name.' };

  const args = headerArgs(header);
  if (typeof args === 'string') return { error: args, tool: name };
  const raw = newline < 0 ? '' : rest.slice(newline + 1);
  const body = raw.trim() === '' ? undefined : raw.endsWith('\n') ? raw : `${raw}\n`;
  const call: ToolCall = { index: 0, tool: name, args };
  if (body !== undefined) call.body = body;
  return { call, explicitName: explicitName && headerName(header) !== undefined };
}

const ESCAPE_HINT = ' Long or multi-line text goes after the JSON line, where it needs no escaping.';

function headerName(header: Record<string, unknown>): string | undefined {
  // OpenAI style: {"function": {"name": ..., "arguments": ...}}
  const source = isRecord(header.function) ? header.function : header;
  for (const key of NAME_KEYS) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/** The arguments object, or an error message. Without an "args" key the other fields are the arguments. */
function headerArgs(header: Record<string, unknown>): Record<string, unknown> | string {
  const source = isRecord(header.function) ? header.function : header;
  for (const key of ARGS_KEYS) {
    if (!(key in source)) continue;
    let value = source[key];
    if (typeof value === 'string') {
      // Arguments sent as a JSON string, as in OpenAI's API.
      const parsed = parseLenientJson(value);
      if ('error' in parsed) return `"${key}" must be an object of arguments.`;
      value = parsed.value;
    }
    if (value === null || value === undefined) return {};
    if (!isRecord(value)) return `"${key}" must be an object of arguments.`;
    return value;
  }
  const flat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!(NAME_KEYS as readonly string[]).includes(key) && key !== 'function') flat[key] = value;
  }
  return flat;
}

/** Index just past the object that opens the text, or -1 when its braces never close. */
function objectEnd(text: string): number {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === '\\') i += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** JSON.parse, and on failure a second try after fixing the usual model slips. */
export function parseLenientJson(text: string): { value: unknown } | { error: string } {
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    try {
      return { value: JSON.parse(repairJson(text)) };
    } catch {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
}

/** Escapes raw control characters and stray backslashes in strings, drops trailing commas. */
function repairJson(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? '';
    if (inString) {
      if (char === '\\') {
        const next = text[i + 1] ?? '';
        if (/["\\/bfnrt]/.test(next) || (next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6)))) {
          out += char + next;
          i += 1;
        } else {
          out += '\\\\'; // e.g. a Windows path: C:\Users
        }
      } else if (char === '"') {
        inString = false;
        out += char;
      } else if (char === '\n') out += '\\n';
      else if (char === '\r') out += '\\r';
      else if (char === '\t') out += '\\t';
      else out += char;
      continue;
    }
    if (char === '"') inString = true;
    if (char === ',' && /^\s*[}\]]/.test(text.slice(i + 1))) continue;
    out += char;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
