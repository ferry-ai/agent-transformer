/**
 * Failure injection for the FakeAdapter: each fault is a scripted reply (or adapter
 * error) put before one reply of the ideal script, so the run goes on as it would
 * after the agent recovers. "malformed@3" puts a malformed block before the third
 * reply of the script, counted over the whole run from 1.
 */
import type { FakeStep } from '../../src/adapters/fake/index.js';
import { AdapterError, type AdapterErrorKind } from '../../src/core/adapter.js';

export const FAULT_KINDS = [
  'malformed', // a tool block whose JSON line is broken
  'cutoff', // the reply stops inside its last tool block
  'timeout', // AdapterError timeout
  'filter', // the content filter's canned answer
  'busy', // AdapterError busy (retried by the agent); on the mock page, HTTP 429
  'notice', // a toast saying the server is busy, as the page shows it; the adapter turns it into busy
  'limit', // AdapterError limit (the chat is full: a rollover)
  'provider', // AdapterError provider
  'send_failed', // AdapterError send_failed
  'empty', // AdapterError empty: a reply that could not be read
  'blank', // a reply whose text is blank
  'unfenced', // protocol forgotten: the reply's tool calls written without their fences
  'tag', // protocol forgotten: a native function-calling tag instead of a tool block
  'unknown', // a call to a tool that does not exist
] as const;

export type FaultKind = (typeof FAULT_KINDS)[number];

export interface Fault {
  kind: FaultKind;
  /** Inserted before this reply of the ideal script, from 1. */
  before: number;
}

export const CANNED_FILTER_ANSWER = "Sorry, that's beyond my current scope. Let's talk about something else.";

/** Parses "malformed@3,busy@5". */
export function parseFaults(list: string): Fault[] {
  return list
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const match = /^([a-z_]+)@(\d+)$/.exec(item);
      const kind = FAULT_KINDS.find((known) => known === match?.[1]);
      if (!match || kind === undefined || Number(match[2]) < 1) {
        throw new Error(`Unknown fault "${item}": write kind@reply, with kind one of ${FAULT_KINDS.join(', ')}.`);
      }
      return { kind, before: Number(match[2]) };
    });
}

/** The ideal script with the faults put in. Faults at the same reply go in the order given. */
export function injectFaults(script: readonly string[], faults: readonly Fault[]): FakeStep[] {
  const steps: FakeStep[] = [];
  for (const [i, reply] of script.entries()) {
    for (const fault of faults) if (fault.before === i + 1) steps.push(faultStep(fault.kind, reply));
    steps.push(reply);
  }
  for (const fault of faults) {
    if (fault.before > script.length) throw new Error(`Fault ${fault.kind}@${fault.before}: the script has ${script.length} replies.`);
  }
  return steps;
}

/** One fault, made from the reply it comes before when it needs one. */
export function faultStep(kind: FaultKind, reply: string): FakeStep {
  switch (kind) {
    case 'malformed':
      return 'Reading it now.\n```tool\n{"tool": "read_file", "args": {"path": "README.md"}\n```';
    case 'cutoff':
      return cutOff(reply);
    case 'filter':
      return { text: CANNED_FILTER_ANSWER, filtered: true };
    case 'blank':
      return { text: ' \n' };
    case 'unfenced':
      return unfenced(reply);
    case 'tag':
      return 'Let me look at the file.\n<tool_call>{"name": "read_file", "arguments": {"path": "README.md"}}</tool_call>';
    case 'unknown':
      return '```tool\n{"tool": "search_files", "args": {"pattern": "subtract"}}\n```';
    case 'notice':
      return new AdapterError('busy', 'DeepSeek: The server is busy. Please try again later.');
    default:
      return new AdapterError(kind as AdapterErrorKind, `Injected ${kind}.`);
  }
}

/** The reply without the fence that closes its last tool block: what a reply cut off by the provider looks like. */
function cutOff(reply: string): string {
  const lines = reply.split('\n');
  const close = lines.lastIndexOf('```');
  if (close <= 0) return '```tool\n{"tool": "write_file", "args": {"path": "notes/draft.md"}}\n# Draft\n\nThe first line, and then';
  return lines.slice(0, close).join('\n');
}

/** The reply with the fences of its tool blocks dropped: the JSON lines stand in the prose. */
function unfenced(reply: string): string {
  const kept = reply.split('\n').filter((line) => !/^`{3,}(tool)?\s*$/.test(line));
  const text = kept.join('\n');
  return text.includes('{"tool"') ? text : 'I will read the file now.\n{"tool": "read_file", "args": {"path": "README.md"}}';
}
