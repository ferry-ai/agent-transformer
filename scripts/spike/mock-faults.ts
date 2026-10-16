/**
 * The failures of faults.ts as the local copy of DeepSeek's page plays them: HTTP 429,
 * an error event in the stream, a "server busy" toast, a stream that stops before
 * FINISHED, a canned content-filter answer, a reply the page never shows... So the
 * real DeepSeek adapter classifies each one, and the agent and the meter see what they
 * would see live. The mock copies the page structure the adapter expects; it says
 * nothing about the real site (docs/calibration.md).
 */
import { fragmentStream, replyHtml, type MockTurn } from '../../src/adapters/deepseek/testing/mock-site.js';
import { CANNED_FILTER_ANSWER, faultStep, type Fault, type FaultKind } from './faults.js';

/** A normal reply: streamed in fragments, then shown on the page. */
export function answer(text: string, status?: string): MockTurn {
  return { body: fragmentStream(status === undefined ? { text } : { text, status }), html: replyHtml({ text }) };
}

/** The ideal script with the faults put in, as mock turns: one per completion request. */
export function mockTurns(script: readonly string[], faults: readonly Fault[]): MockTurn[] {
  for (const fault of faults) {
    if (fault.before > script.length) throw new Error(`Fault ${fault.kind}@${fault.before}: the script has ${script.length} replies.`);
  }
  const turns: MockTurn[] = [];
  for (const [i, reply] of script.entries()) {
    for (const fault of faults) if (fault.before === i + 1) turns.push(mockFault(fault.kind, reply));
    turns.push(answer(reply));
  }
  return turns;
}

const event = (name: string, data: object): string => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

export function mockFault(kind: FaultKind, reply: string): MockTurn {
  switch (kind) {
    case 'busy':
      return { status: 429, contentType: 'application/json', body: JSON.stringify({ code: 42900, msg: 'Too many requests' }), html: '' };
    case 'notice':
      // No reply on the page, a toast instead.
      return { body: '', html: '', notice: 'The server is busy. Please try again later.' };
    case 'limit':
      return { body: event('error', { message: 'The length limit of this conversation has been reached.' }), html: '' };
    case 'provider':
      return { status: 500, contentType: 'application/json', body: JSON.stringify({ code: 50000, msg: 'Internal error' }), html: '' };
    case 'timeout':
      // Each event comes 4 s after the previous one: the stream outlasts a short --timeout.
      return { body: fragmentStream({ text: 'This reply takes far too long to arrive.' }), html: '', delayMs: 4_000 };
    case 'empty':
      // A stream the parser cannot read, and nothing on the page.
      return { body: 'data: not json\n\n', html: '' };
    case 'filter':
      return answer(CANNED_FILTER_ANSWER, 'CONTENT_FILTER');
    case 'blank':
      return answer(' ');
    case 'cutoff':
      // The stream stops before FINISHED, and the page shows no more than it carried.
      return answer(faultStep('cutoff', reply) as string, 'INCOMPLETE');
    case 'send_failed':
      throw new Error('send_failed cannot be played on the mock page: its message box always empties.');
    default: {
      // The model's own slips: malformed, unfenced, tag, unknown.
      const step = faultStep(kind, reply);
      if (typeof step !== 'string') throw new Error(`${kind} is not a reply.`);
      return answer(step);
    }
  }
}
