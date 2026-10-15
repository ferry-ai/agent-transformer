import type { ToolCall } from '../agent/protocol.js';
import { countHidden } from './sanitize.js';
import { ToolError, type ApprovalDecision, type ApprovalSpec, type Approve, type JsonSchema, type Tool, type ToolOutput } from './types.js';

export interface ToolboxOptions {
  /** Asks the user before a tool that needs approval runs. Without it, such calls are denied. */
  approve?: Approve;
  /** Longest result text sent back to the chat; the middle of longer ones is cut. */
  maxResultChars?: number;
  /**
   * Called before a call that may change the workspace runs: one that mutates, or one
   * the user had to approve (commands, MCP calls). It reports its own failures: the
   * call goes on even when no checkpoint could be taken.
   */
  checkpoint?: (label: string) => Promise<void>;
}

const DEFAULT_MAX_RESULT_CHARS = 20_000;

/**
 * The tools the model can call, native and MCP alike. It turns a parsed call into a
 * result: finds the tool, places the body, checks and coerces the arguments, asks for
 * approval, runs it, and catches every failure as a result the model can read.
 */
export class Toolbox {
  private readonly tools = new Map<string, Tool>();
  private readonly options: ToolboxOptions;

  constructor(tools: Tool[], options: ToolboxOptions = {}) {
    this.options = options;
    for (const tool of tools) this.add(tool);
  }

  add(tool: Tool): void {
    if (this.tools.has(tool.name)) throw new Error(`Two tools are named "${tool.name}".`);
    this.tools.set(tool.name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  async call(call: ToolCall, signal?: AbortSignal): Promise<ToolOutput> {
    const tool = this.tools.get(call.tool);
    if (!tool) {
      return { ok: false, text: `Unknown tool "${call.tool}". Available tools: ${[...this.tools.keys()].join(', ')}.` };
    }
    try {
      const args = prepareArgs(tool, call);
      // Counted on the raw arguments: the prompt shows them escaped, the count says there was something to escape.
      const hidden = countHidden(args);
      const ask = async (spec: ApprovalSpec): Promise<ApprovalDecision> =>
        this.options.approve ? this.options.approve({ ...spec, tool: tool.name, hidden }) : { approved: false };
      const requested = await tool.approval?.(args);
      const spec = typeof requested === 'string' ? { summary: requested } : requested;
      if (spec !== undefined) {
        const decision = await ask(spec);
        if (!decision.approved) return { ok: false, text: refusal(decision) };
      }
      if (tool.mutates === true || spec !== undefined) await this.options.checkpoint?.(label(tool, args)).catch(() => undefined);
      const output = await tool.run(args, {
        signal,
        confirm: async (more) => {
          const decision = await ask(more);
          if (!decision.approved) throw new ToolError(refusal(decision));
        },
      });
      return { ok: output.ok, text: truncate(output.text, this.options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS) };
    } catch (error) {
      if (error instanceof ToolError) return { ok: false, text: error.message };
      return { ok: false, text: `The tool failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}

/** "write_file src/app.py", "run_command npm test": what the checkpoint was taken before. */
function label(tool: Tool, args: Record<string, unknown>): string {
  const what = typeof args.path === 'string' ? args.path : typeof args.command === 'string' ? args.command : '';
  const line = what.split('\n').find((part) => part.trim() !== '') ?? '';
  return `${tool.name}${line === '' ? '' : ` ${line.trim().slice(0, 120)}`}`;
}

function refusal(decision: ApprovalDecision): string {
  const note = decision.note ? ` The user says: ${decision.note}` : '';
  return `The user did not allow this call.${note}`;
}

/** Puts the body in its parameter, then checks the arguments against the schema. */
function prepareArgs(tool: Tool, call: ToolCall): Record<string, unknown> {
  const args = { ...call.args };
  const properties = tool.params.properties ?? {};
  const required = tool.params.required ?? [];

  if (call.body !== undefined) {
    const target = tool.body ?? soleMissingString(properties, required, args);
    if (target === undefined) {
      throw new ToolError(`${tool.name} takes no text after the JSON line: put every argument in "args".`);
    }
    if (args[target] !== undefined) {
      throw new ToolError(`"${target}" is given twice: in "args" and as the text after the JSON line. Keep one.`);
    }
    args[target] = call.body;
  }

  const missing = required.filter((name) => args[name] === undefined || args[name] === null);
  if (missing.length > 0) {
    throw new ToolError(`Missing arguments for ${tool.name}: ${missing.join(', ')}.`);
  }
  for (const [name, value] of Object.entries(args)) {
    const schema = properties[name];
    if (!schema) continue; // Unknown arguments are left for the tool to ignore or reject.
    args[name] = coerce(name, value, schema);
  }
  return args;
}

function soleMissingString(
  properties: Record<string, JsonSchema>,
  required: string[],
  args: Record<string, unknown>,
): string | undefined {
  const candidates = required.filter((name) => args[name] === undefined && types(properties[name]).includes('string'));
  return candidates.length === 1 ? candidates[0] : undefined;
}

function types(schema: JsonSchema | undefined): string[] {
  if (!schema?.type) return [];
  return Array.isArray(schema.type) ? schema.type : [schema.type];
}

/** Light coercion of the usual mismatches ("10" for 10, "true" for true); refuses the rest. */
function coerce(name: string, value: unknown, schema: JsonSchema): unknown {
  const allowed = types(schema);
  if (allowed.length === 0 || value === null) return value;
  const actual = Array.isArray(value) ? 'array' : typeof value;
  if (allowed.includes(actual) || (actual === 'number' && allowed.includes('integer') && Number.isInteger(value))) {
    return value;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if ((allowed.includes('number') || allowed.includes('integer')) && text !== '' && Number.isFinite(Number(text))) {
      return Number(text);
    }
    if (allowed.includes('boolean') && (text === 'true' || text === 'false')) return text === 'true';
  }
  if (allowed.includes('string') && (typeof value === 'number' || typeof value === 'boolean')) return String(value);
  throw new ToolError(`"${name}" must be ${allowed.join(' or ')}, got ${actual}.`);
}

/** Keeps the head and the tail: errors tend to sit at the end of long outputs. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  const cut = text.length - head - tail;
  return `${text.slice(0, head)}\n[… ${cut} characters cut …]\n${text.slice(text.length - tail)}`;
}
