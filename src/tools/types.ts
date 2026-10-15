/** The subset of JSON Schema the agent reads to describe and check tool arguments. */
export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  default?: unknown;
  [key: string]: unknown;
}

/** A tool as the model sees it. Native tools and MCP tools look the same from here on. */
export interface Tool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema of the arguments: an object schema. */
  readonly params: JsonSchema;
  /**
   * The parameter that receives the free text written after the JSON line of a call
   * (file contents, commands). Without it, the text goes to the only missing required
   * string parameter, if there is exactly one.
   */
  readonly body?: string;
  /** Changes files in the workspace, even when it needs no approval (write_file, edit_file). */
  readonly mutates?: boolean;
  /**
   * What to show the user before running, or undefined when no approval is needed.
   * It may look at the disk first (and throw a ToolError to refuse the call outright).
   */
  approval?(args: Record<string, unknown>): ApprovalSpec | string | undefined | Promise<ApprovalSpec | string | undefined>;
  run(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutput>;
}

export interface ToolOutput {
  ok: boolean;
  text: string;
}

export interface ToolContext {
  signal?: AbortSignal;
  /** Asks the user in the middle of a run; throws a ToolError when they refuse. */
  confirm(spec: ApprovalSpec): Promise<void>;
}

/** What a call is about to do, as the user sees it before allowing it. */
export interface ApprovalSpec {
  /** One line, in words the user can judge: "write src/app.py (120 characters)". */
  summary: string;
  /** The whole command or the full arguments, shown as they are under the summary. */
  detail?: string;
  /** Where it runs, such as "[sandbox: docker, network off]" or "[HOST, not sandboxed]". */
  where?: string;
  /** Reasons to look twice, one line each. */
  warnings?: string[];
}

export interface ApprovalRequest extends ApprovalSpec {
  tool: string;
  /** Invisible or control characters in the raw arguments: they are shown escaped and deserve a warning. */
  hidden: number;
}

export interface ApprovalDecision {
  approved: boolean;
  /** A note from the user, passed on to the model. */
  note?: string;
}

export type Approve = (request: ApprovalRequest) => Promise<ApprovalDecision>;

/** Thrown by tools for an expected failure: the message goes back to the model as is. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}
