/**
 * Turns the replies of a capture session (scripts/deepseek/capture.ts) into test
 * fixtures: ids become placeholders, times zero, tokens and emails are masked. It writes
 * nothing when a check still finds something that looks private. See docs/calibration.md.
 *
 *   npx tsx scripts/deepseek/sanitize.ts "<session folder>"
 *   npx tsx scripts/deepseek/sanitize.ts "<session folder>" --only short,code --deny "<your name>"
 *
 * It reads only the session folder and writes only to the fixtures folder (or --out).
 * A --mock session never goes into the fixtures folder, whatever --out says.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { FIXTURES_DIR, MOCK_ORIGIN, sameFolder, sameWords, streamExpectation, type PageExpectation } from '../../src/adapters/deepseek/testing/fixtures.js';
import { PageRenderer } from '../../src/adapters/deepseek/testing/render.js';
import { checkText, IdMap, sanitizeHtml, sanitizeStream, scrubText, type Finding } from '../../src/adapters/deepseek/testing/sanitize.js';

const USAGE = `Usage: npx tsx scripts/deepseek/sanitize.ts <session folder> [options]

  --out <dir>      where the fixtures go (default: src/adapters/deepseek/fixtures)
  --only <ids>     only these capture ids (default: every captured reply)
  --deny <words>   comma-separated words that must not appear (a name, an email)
  --dry-run        check and summarize, write nothing`;

interface Capture {
  id: string;
  covers: string;
  turn: number;
  prompt: string;
  source?: string;
  filtered?: boolean;
  error?: string;
}

interface Output {
  name: string;
  files: Map<string, string>;
  summary: string;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      only: { type: 'string' },
      deny: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help || positionals.length !== 1) {
    console.log(USAGE);
    if (!values.help) process.exitCode = 2;
    return;
  }
  const session = resolve(positionals[0] ?? '');
  const out = resolve(values.out ?? FIXTURES_DIR);
  const deny = (values.deny ?? '').split(',').map((word) => word.trim()).filter(Boolean);
  const only = values.only?.split(',').map((id) => id.trim()).filter(Boolean);

  const { captures, date, mock } = readTranscript(session);
  // Whatever --out says: mock fixtures in the fixtures folder would replay as captures.
  if (mock && sameFolder(out, FIXTURES_DIR) && !values['dry-run']) {
    throw new Error(
      'This session is a --mock dry run, not a capture of DeepSeek: it never goes into the fixtures folder. Give --out <another folder>.',
    );
  }
  const chosen = captures.filter((capture) => only === undefined || only.includes(capture.id));
  if (chosen.length === 0) throw new Error('No captured replies in this session (or none matching --only).');

  const ids = new IdMap();
  const renderer = await PageRenderer.start();
  if (!renderer) console.log('No browser to render the HTML: page expectations are left out.');
  const outputs: Output[] = [];
  const findings: Finding[] = [];
  try {
    for (const capture of chosen) {
      if (capture.error !== undefined) {
        console.log(`${capture.id.padEnd(14)} skipped: the capture failed (${capture.error})`);
        continue;
      }
      const number = String(capture.turn).padStart(3, '0');
      const rawStream = readIfThere(join(session, `turn-${number}-stream.txt`));
      const rawHtml = readIfThere(join(session, `turn-${number}-message.html`));
      if (rawStream === undefined && rawHtml === undefined) {
        console.log(`${capture.id.padEnd(14)} skipped: no raw stream or HTML (was --debug on?)`);
        continue;
      }
      const stream = rawStream === undefined ? undefined : sanitizeStream(rawStream, ids);
      const html = rawHtml === undefined ? undefined : sanitizeHtml(rawHtml, ids);
      const streamSeen = stream === undefined ? undefined : streamExpectation(stream);
      const pageSeen: PageExpectation | undefined = html !== undefined && renderer ? await renderer.render(html) : undefined;
      const meta = {
        origin: mock
          ? `${MOCK_ORIGIN}, not a calibration: capture.ts --mock against the local stand-in page, ${date}: ${capture.covers}`
          : `captured ${date} from chat.deepseek.com with scripts/deepseek/capture.ts: ${capture.covers}`,
        prompt: scrubText(capture.prompt, ids),
        adapter: { source: capture.source ?? null, filtered: capture.filtered ?? false },
        stream: streamSeen,
        page: pageSeen,
        pageMatchesStream: streamSeen && pageSeen ? sameWords(streamSeen.content, pageSeen.text) : null,
      };
      const files = new Map<string, string>();
      files.set(`${capture.id}.json`, `${JSON.stringify(meta, null, 2)}\n`);
      if (stream !== undefined) files.set(`${capture.id}.sse`, stream);
      if (html !== undefined) files.set(`${capture.id}.html`, `${html}\n`);
      for (const [file, text] of files) findings.push(...checkText(file, text, deny));
      outputs.push({
        name: capture.id,
        files,
        summary:
          `${capture.id.padEnd(14)} adapter ${capture.source ?? '?'}, stream status ${streamSeen?.status ?? 'none'}` +
          `${streamSeen?.endedEarly ? ' (ended early)' : ''}, ${streamSeen?.content.length ?? 0} chars` +
          `${streamSeen?.thinking ? ` + ${streamSeen.thinking.length} reasoning` : ''}` +
          `${streamSeen?.filtered ? ', FILTERED' : ''}, page ${meta.pageMatchesStream === null ? 'n/a' : meta.pageMatchesStream ? 'matches' : 'DIFFERS'}`,
      });
    }
  } finally {
    await renderer?.close();
  }

  for (const output of outputs) console.log(output.summary);
  if (findings.length > 0) {
    console.log(`\nNot written: ${findings.length} finding(s) that look private.`);
    for (const finding of findings) console.log(`  ${finding.file}:${finding.line} ${finding.rule}: ${finding.excerpt}`);
    console.log('Extend the sanitizer (src/adapters/deepseek/testing/sanitize.ts) or leave these captures out with --only.');
    process.exitCode = 1;
    return;
  }
  if (values['dry-run']) {
    console.log('\nDry run: nothing written.');
    return;
  }
  await mkdir(out, { recursive: true });
  for (const output of outputs) {
    for (const [file, text] of output.files) await writeFile(join(out, file), text);
  }
  console.log(`\nWrote ${outputs.length} fixture(s) to ${out}. Check them, then: npx tsx scripts/deepseek/check-fixtures.ts`);
}

/** Pairs every "capture" event with the turn that follows it. */
function readTranscript(session: string): { captures: Capture[]; date: string; mock: boolean } {
  const path = join(session, 'transcript.jsonl');
  if (!existsSync(path)) throw new Error(`No transcript.jsonl in ${session}.`);
  const captures: Capture[] = [];
  let pending: { id: string; covers: string } | undefined;
  let date = '';
  let mock = false;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const entry = JSON.parse(line) as Record<string, unknown>;
    if (date === '' && typeof entry.at === 'string') date = entry.at.slice(0, 10);
    if (entry.event === 'capture_start' && entry.mock === true) mock = true;
    if (entry.event === 'capture' && typeof entry.id === 'string') {
      pending = { id: entry.id, covers: typeof entry.covers === 'string' ? entry.covers : '' };
      continue;
    }
    if (typeof entry.turn !== 'number' || !pending) continue;
    const reply = entry.reply as { source?: unknown; filtered?: unknown } | undefined;
    const error = entry.error as { kind?: unknown; message?: unknown } | undefined;
    captures.push({
      ...pending,
      turn: entry.turn,
      prompt: typeof entry.prompt === 'string' ? entry.prompt : '',
      source: typeof reply?.source === 'string' ? reply.source : undefined,
      filtered: reply?.filtered === true,
      error: error === undefined ? undefined : `${String(error.kind)}: ${String(error.message)}`,
    });
    pending = undefined;
  }
  return { captures, date: date || 'unknown date', mock };
}

function readIfThere(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
