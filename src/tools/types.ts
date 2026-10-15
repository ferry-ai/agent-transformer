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
  /** Returns what to show the user before running, or undefined when no approval is needed. */
  approval?(args: Record<string, unknown>): string | undefined;
  run(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutput>;
}

export interface ToolOutput {
  ok: boolean;
  text: string;
}

export interface ToolContext {
  signal?: AbortSignal;
}

export interface ApprovalRequest {
  tool: string;
  /** What the call is about to do, in words the user can judge. */
  summary: string;
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
