import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { endedEarly, parseCompletionStream } from '../stream.js';

/**
 * Recorded replies the tests replay: src/adapters/deepseek/fixtures/<name>.json, with
 * the stream body in <name>.sse and the message HTML in <name>.html when there is one.
 * They come from scripts/deepseek/sanitize.ts, which writes them from a capture session
 * without ids, tokens or personal text. docs/calibration.md has the recipe.
 *
 * The expectations are what the parser and the page script read at capture time, once
 * a person checked them against the browser window: the tests keep them from drifting.
 */

export interface StreamExpectation {
  content: string;
  thinking: string;
  /** null when the stream sets no status. */
  status: string | null;
  filtered: boolean;
  errors: string[];
  endedEarly: boolean;
}

export interface PageExpectation {
  text: string;
  thinking: string;
}

export interface Fixture {
  name: string;
  /** "captured <date> ...": where the data comes from. */
  origin: string;
  prompt?: string;
  stream?: string;
  html?: string;
  expect: { stream?: StreamExpectation; page?: PageExpectation };
}

export const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));

export function loadFixtures(dir: string = FIXTURES_DIR): Fixture[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      const name = file.slice(0, -'.json'.length);
      const meta = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
        origin?: unknown;
        prompt?: unknown;
        stream?: StreamExpectation;
        page?: PageExpectation;
      };
      const read = (extension: string): string | undefined => {
        const path = join(dir, `${name}${extension}`);
        return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
      };
      return {
        name,
        origin: typeof meta.origin === 'string' ? meta.origin : 'unknown',
        prompt: typeof meta.prompt === 'string' ? meta.prompt : undefined,
        stream: read('.sse'),
        html: read('.html'),
        expect: { stream: meta.stream, page: meta.page },
      };
    });
}

/** Every file in the fixtures folder, for the leak check. */
export function fixtureFiles(dir: string = FIXTURES_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file !== '.gitattributes')
    .sort()
    .map((file) => join(dir, file));
}

/** Files in the fixtures folder that no <name>.json describes. */
export function strayFixtureFiles(dir: string = FIXTURES_DIR): string[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir);
  const described = new Set(files.filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -'.json'.length)));
  return files.filter((file) => {
    const match = /^(.*)\.(?:sse|html)$/.exec(file);
    return file !== '.gitattributes' && !file.endsWith('.json') && !(match && described.has(match[1] ?? ''));
  });
}

/** What the parser reads from a stream, in the shape fixtures store. */
export function streamExpectation(stream: string): StreamExpectation {
  const reply = parseCompletionStream(stream);
  return {
    content: reply.content,
    thinking: reply.thinking,
    status: reply.status ?? null,
    filtered: reply.filtered,
    errors: reply.errors,
    endedEarly: endedEarly(reply),
  };
}

/** Letters and digits only: the stream's Markdown and the page's rendering compared loosely. */
export function sameWords(a: string, b: string): boolean {
  const letters = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return letters(a) === letters(b);
}
