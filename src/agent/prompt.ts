import type { JsonSchema, Tool } from '../tools/types.js';
import { fenceFor } from './protocol.js';
import { TASK_TOOL, type RolloverReason, type TaskState } from './state.js';

/**
 * What the chat is told. A web chat has no system prompt, so the instructions travel
 * in the first message of each conversation, followed by the task.
 */

export interface PromptContext {
  tools: Tool[];
  /** The workspace folder, as the model should picture it. */
  root: string;
  maxIterations: number;
  /** Extra rules, after the numbered ones. */
  notes?: string[];
}

/** The rule added when the model can keep its plan with update_task. */
export const TASK_TOOL_NOTE =
  `Keep your plan current with ${TASK_TOOL}. A long task may move to a new chat: the runner then gives you back ` +
  'the task, your checklist and decisions, the files you read and changed, and the latest results, nothing else.';

export function firstMessage(context: PromptContext, task: string): string {
  return `${instructions(context)}\n\n# Task\n\n${task.trim()}`;
}

/** A new task in a conversation that already has the instructions. */
export function followUpMessage(context: PromptContext, task: string): string {
  return [
    'New task from the user. The tools and rules are the same as before: tool calls go in ```tool blocks, ' +
      'and a reply without tool blocks ends the task.',
    `You have at most ${context.maxIterations} replies for it.`,
    `# Task\n\n${task.trim()}`,
  ].join('\n\n');
}

/** Closes every results message, so the protocol stays fresh in a long conversation. */
export function resultsFooter(iteration: number, maxIterations: number, malformed: boolean): string {
  const fix = malformed ? 'Some tool blocks were malformed: send them again, fixed. ' : '';
  return (
    `${fix}Reply ${iteration} of ${maxIterations} used. Continue with more tool blocks, ` +
    'or reply without any tool block when the task is done.'
  );
}

/** Sent when a reply arrived but could not be read: nothing was run, so the model can repeat it. */
export const REPEAT_REQUEST = 'Your last reply did not reach me. Please send it again, unchanged.';

/** Sent when a reply has no tool block but tries to call a tool anyway: nothing was run. */
export function offProtocolMessage(found: string, iteration: number, maxIterations: number): string {
  return [
    `Nothing was run: your reply has ${found}, but no \`\`\`tool block. The runner only reads calls written as in the ` +
      'instructions: a fenced block tagged tool, whose first line is {"tool": "name", "args": {...}}.',
    'If you meant to call a tool, send the call again in that format. If the task is done, reply without any call.',
    `Reply ${iteration} of ${maxIterations} used.`,
  ].join('\n\n');
}

export type EnvelopeReason = RolloverReason | 'resume';

/** Says where the last results are when an envelope has none to carry. */
export const NO_LAST_RESULTS = 'None in this chat yet: the recent calls in the task state show what happened last.';

/**
 * The rollover envelope: the first message of a new chat that continues a task. The
 * instructions again, the task, then its state as JSON (the "busta"); the caller adds
 * the last results. Nothing else of the earlier chat comes along.
 */
export function envelopeMessage(
  context: PromptContext,
  state: TaskState,
  options: { reason: EnvelopeReason; repliesLeft: number; previousChars?: number; stopped?: TaskState['status'] },
): string {
  const stopped = options.stopped ?? state.status;
  const files = (list: string[]): string[] => list.slice(-30);
  const busta = {
    replies_used: state.iterations,
    replies_left: options.repliesLeft,
    checklist: state.checklist.map((item) => `[${item.done ? 'x' : ' '}] ${item.text}`),
    decisions: state.decisions,
    files_read: files(state.files.read),
    files_changed: files(state.files.changed),
    recent_calls: state.recent,
  };
  const json = JSON.stringify(busta, null, 2);
  const fence = fenceFor(json);
  const why: Record<EnvelopeReason, string> = {
    budget: `The previous chat grew too long (${options.previousChars ?? 0} characters), so the runner moved the task to this new one.`,
    drift: 'Your previous replies did not follow the tool protocol, so the runner moved the task to this new chat. Follow the format above exactly.',
    limit: "The previous chat reached the provider's length limit, so the runner moved the task to this new one.",
    resume: `The task stopped earlier (${stopped === 'running' ? 'interrupted' : stopped}) and is resumed in this new chat.`,
  };
  const reread =
    state.files.read.length > 0 || state.files.changed.length > 0
      ? '\n\nThe files you read before are not in this chat any more: read a file again before you edit it.'
      : '';
  return [
    instructions({ ...context, maxIterations: options.repliesLeft }),
    `# Task\n\n${state.goal}`,
    `# Task state\n\n${why[options.reason]} The runner kept this state outside the chat: trust it over what you remember.` +
      `\n\n${fence}json\n${json}\n${fence}${reread}`,
  ].join('\n\n');
}

export function instructions(context: PromptContext): string {
  return `You are the mind of a coding agent working on the user's computer. You cannot act on it directly: a local runner reads your replies, runs the tool calls written in them and sends you the results in the next message. There is no function calling here: tool calls are plain text in the format below.

# Calling tools

Write a fenced code block tagged \`tool\`. Its first line is a JSON object with the tool name and its arguments:

\`\`\`tool
{"tool": "read_file", "args": {"path": "src/main.py"}}
\`\`\`

Long or multi-line text (file contents, edits, shell scripts) goes after the JSON line, exactly as it is: no quotes, no escaping. It fills the parameter marked "text after the JSON line" in the list of tools:

\`\`\`tool
{"tool": "write_file", "args": {"path": "hello.py"}}
print("Hello")
\`\`\`

If that text has lines starting with \`\`\`, open and close the tool block with four backticks (\`\`\`\`tool … \`\`\`\`).

# Rules

1. You may write several tool blocks in one reply: they run in order and the results come back together. Only call a tool once its arguments no longer depend on a result you have not seen.
2. After your tool blocks, stop and wait for the results. Never write results yourself.
3. Everything in a tool block runs: never use one for an example.
4. Paths are relative to the workspace folder, ${context.root}. Nothing outside it can be reached.
5. The user approves each shell command and may refuse it. If they add a note, follow it.
6. Read a file before editing it, and prefer edit_file to rewriting a whole file.
7. When the task is done, or you need an answer from the user, reply with no tool block at all: that reply is your final answer. Summarise what you did.
8. You have at most ${context.maxIterations} replies for this task.${(context.notes ?? []).map((note, i) => `\n${i + 9}. ${note}`).join('')}

# Tools

${context.tools.map(describeTool).join('\n\n')}`;
}

export function describeTool(tool: Tool): string {
  const properties = tool.params.properties ?? {};
  const required = new Set(tool.params.required ?? []);
  const lines = [`## ${tool.name}`];
  if (tool.description.trim() !== '') lines.push(tool.description.trim());
  const names = Object.keys(properties);
  if (names.length === 0) {
    lines.push('No arguments.');
    return lines.join('\n');
  }
  lines.push('Arguments:');
  for (const name of names) {
    const schema = properties[name] ?? {};
    const notes = [typeName(schema), required.has(name) ? 'required' : 'optional'];
    if (tool.body === name) notes.push('text after the JSON line');
    if (Array.isArray(schema.enum)) notes.push(`one of ${schema.enum.map((value) => JSON.stringify(value)).join(', ')}`);
    if (schema.default !== undefined) notes.push(`default ${JSON.stringify(schema.default)}`);
    const description = schema.description ? `: ${oneLine(schema.description)}` : '';
    lines.push(`- ${name} (${notes.join(', ')})${description}`);
  }
  return lines.join('\n');
}

function typeName(schema: JsonSchema): string {
  const type = Array.isArray(schema.type) ? schema.type.join(' | ') : schema.type;
  if (type === 'array' && schema.items) return `list of ${typeName(schema.items)}`;
  return type ?? 'any';
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
