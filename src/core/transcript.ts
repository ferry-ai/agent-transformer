import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AdapterError, type ChatReply } from './adapter.js';

export interface TurnRecord {
  prompt: string;
  attachments: string[];
  reply?: ChatReply;
  error?: unknown;
}

/**
 * One folder per session: transcript.jsonl, plus the raw stream and HTML of each
 * reply when the adapter runs in debug mode. These logs feed the replay tests later.
 */
export class Transcript {
  readonly dir: string;
  private turns = 0;

  private constructor(dir: string) {
    this.dir = dir;
  }

  static async create(dataDir: string, adapter: string): Promise<Transcript> {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const dir = join(dataDir, 'sessions', `${stamp}-${adapter}`);
    await mkdir(dir, { recursive: true });
    return new Transcript(dir);
  }

  async turn(record: TurnRecord): Promise<void> {
    this.turns += 1;
    const id = String(this.turns).padStart(3, '0');
    const { reply, error } = record;
    if (reply?.raw?.stream !== undefined) {
      await writeFile(join(this.dir, `turn-${id}-stream.txt`), reply.raw.stream);
    }
    if (reply?.raw?.html !== undefined) {
      await writeFile(join(this.dir, `turn-${id}-message.html`), reply.raw.html);
    }
    await this.append({
      turn: this.turns,
      prompt: record.prompt,
      attachments: record.attachments,
      reply: reply && {
        text: reply.text,
        thinking: reply.thinking,
        source: reply.source,
        filtered: reply.filtered,
        durationMs: reply.durationMs,
      },
      error: error === undefined ? undefined : describe(error),
    });
  }

  async event(name: string): Promise<void> {
    await this.append({ event: name });
  }

  private async append(entry: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    await appendFile(join(this.dir, 'transcript.jsonl'), `${line}\n`);
  }
}

function describe(error: unknown): { kind: string; message: string } {
  if (error instanceof AdapterError) return { kind: error.kind, message: error.message };
  return { kind: 'unexpected', message: error instanceof Error ? error.message : String(error) };
}
