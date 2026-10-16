/**
 * Turns a spike's JSONL into Markdown: one row per cycle, the tasks, and the totals.
 *
 *   npx tsx scripts/spike/report.ts <spike.jsonl>
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { totals, type CycleRecord, type SpikeTotals, type TaskRecord } from './meter.js';

export interface SpikeLog {
  run?: Record<string, unknown>;
  cycles: CycleRecord[];
  tasks: TaskRecord[];
  summary?: Record<string, unknown>;
}

export async function readSpikeLog(file: string): Promise<SpikeLog> {
  const log: SpikeLog = { cycles: [], tasks: [] };
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (line.trim() === '') continue;
    const record = JSON.parse(line) as { type?: string };
    if (record.type === 'cycle') log.cycles.push(record as CycleRecord);
    else if (record.type === 'task') log.tasks.push(record as TaskRecord);
    else if (record.type === 'run') log.run = record as Record<string, unknown>;
    else if (record.type === 'summary') log.summary = record as Record<string, unknown>;
  }
  return log;
}

const seconds = (ms: number | undefined): string => (ms === undefined ? '–' : (ms / 1000).toFixed(1));
const count = (n: number): string => (n === 0 ? '' : String(n));

export function cycleTable(cycles: readonly CycleRecord[]): string {
  const rows = [
    '| # | task.reply | chat | message | reply s | sends | blocks | malformed | cut-off | tools run | re-asks | adapter errors | filter | chat chars | T3 and approvals | end |',
    '| ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | --- | ---: | --- | --- |',
  ];
  for (const cycle of cycles) {
    const tools = Object.entries(cycle.tools)
      .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
      .join(', ');
    const errors = Object.entries(cycle.errors)
      .map(([kind, n]) => (n > 1 ? `${kind} ×${n}` : kind))
      .join(', ');
    const notes = [
      cycle.retries > 0 ? `retries ${cycle.retries}` : '',
      cycle.drift > 0 ? `drift ${cycle.drift}` : '',
      cycle.gated > 0 ? `gated ${cycle.gated}` : '',
      cycle.unknownTools > 0 ? `unknown tool ${cycle.unknownTools}` : '',
      cycle.denied > 0 ? `denied ${cycle.denied}` : '',
      cycle.toolFailures > 0 ? `tool errors ${cycle.toolFailures}` : '',
      cycle.emptyReplies > 0 ? `blank reply ${cycle.emptyReplies}` : '',
      cycle.summarized > 0 ? `summarized ${cycle.summarized}` : '',
      cycle.attachments > 0 ? `attached ${cycle.attachments}` : '',
      cycle.attachmentsOff ? 'uploads off' : '',
      cycle.rollover ? `rollover (${cycle.rollover.reason})` : '',
      cycle.pending > 0 ? `${cycle.pending} unrun` : '',
    ]
      .filter(Boolean)
      .join(', ');
    const budget = cycle.budget ? `${cycle.budget.used}` : '–';
    const end = cycle.end === undefined ? '' : cycle.holds ? cycle.end : `**${cycle.end}**`;
    rows.push(
      `| ${cycle.cycle} | ${cycle.task}.${cycle.iteration} ${cycle.taskId} | ${cycle.chat} | ${cycle.prompt} | ${seconds(cycle.replyMs)} | ${cycle.attempts.length} | ` +
        `${cycle.blocks} | ${count(cycle.malformed)} | ${count(cycle.cutOff)} | ${tools || '–'} | ${count(cycle.reasks)} | ${errors} | ` +
        `${cycle.filtered ? 'yes' : ''} | ${budget} | ${notes} | ${end} |`,
    );
  }
  return rows.join('\n');
}

export function taskTable(tasks: readonly TaskRecord[]): string {
  const rows = ['| task | status | replies | tool calls | cycles | time s | check |', '| --- | --- | ---: | ---: | --- | ---: | --- |'];
  for (const task of tasks) {
    rows.push(
      `| ${task.task} ${task.id} | ${task.status}${task.error ? ` (${task.error.replace(/\|/g, '/').slice(0, 120)})` : ''} | ${task.iterations} | ${task.toolCalls} | ` +
        `${task.firstCycle}–${task.lastCycle} | ${seconds(task.ms)} | ${task.check} |`,
    );
  }
  return rows.join('\n');
}

export function totalsList(t: SpikeTotals): string {
  const map = (record: Record<string, number>): string =>
    Object.keys(record).length === 0
      ? 'none'
      : Object.entries(record)
          .map(([key, n]) => `${key} ${n}`)
          .join(', ');
  const time = t.replyMs
    ? `mean ${seconds(t.replyMs.mean)} s, median ${seconds(t.replyMs.median)} s, p95 ${seconds(t.replyMs.p95)} s, max ${seconds(t.replyMs.max)} s`
    : 'none';
  return [
    `- Cycles: ${t.cycles}; held in a row from the first: **${t.heldInARow}**; held: ${t.held}; clean (held at the first try): ${t.clean}`,
    `- Reply time (adapter): ${time}`,
    `- Tool blocks parsed: ${t.blocks} (${t.calls} calls, ${t.malformed} malformed); unknown tools: ${t.unknownTools}`,
    `- Cut-off replies: ${t.cutOff}; blank replies: ${t.emptyReplies}; content-filter hits: ${t.filtered}`,
    `- Re-asks: ${t.reasks}; retries: ${t.retries}; drift: ${t.drift}`,
    `- Adapter errors: ${map(t.errors)}; timeouts: ${t.timeouts}`,
    `- Tools run: ${map(t.tools)}; tool errors: ${t.toolFailures}; refused by the approver: ${t.denied}; refused by the read-before-edit gate: ${t.gated}`,
    `- T3: summarized results ${t.summarized}; attachments sent ${t.attachments}${t.attachmentsOff ? ' (uploads turned off)' : ''}; rollovers: ${map(t.rollovers)}; chats used: ${t.chats}; fullest chat: ${t.maxBudgetUsed ?? '–'} characters`,
    `- Tasks: ${t.tasks} (${map(t.taskStatuses)}); checks passed: ${t.checksPassed} of ${t.tasks}`,
  ].join('\n');
}

export function renderReport(log: SpikeLog): string {
  const t = totals(log.cycles, log.tasks);
  const stopped = typeof log.summary?.stopped === 'string' ? `\n\nStopped early: ${log.summary.stopped}` : '';
  return [`### Cycles\n\n${cycleTable(log.cycles)}`, `### Tasks\n\n${taskTable(log.tasks)}`, `### Totals\n\n${totalsList(t)}${stopped}`].join('\n\n');
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (file === undefined) throw new Error('Usage: npx tsx scripts/spike/report.ts <spike.jsonl>');
  console.log(renderReport(await readSpikeLog(file)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
