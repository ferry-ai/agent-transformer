import type { McpConnection } from './tools/mcp.js';
import { comparePin, loadPins, pinOf, savePins, type PinCheck, type Pins } from './tools/mcp-trust.js';
import { safeLine } from './tools/sanitize.js';

export interface ReviewIO {
  print: (text: string) => void;
  warn: (text: string) => void;
  /** Asks yes or no; resolves false without a terminal. */
  confirm: (question: string) => Promise<boolean>;
}

/**
 * What the user learns about the MCP servers at startup: what runs, which tools the
 * model gets, which run without asking (from the user's config only), and whether the
 * definitions changed since they were accepted. A changed server asks before every call
 * until the user accepts it, here or later with /mcp accept <server>.
 */
export class McpReview {
  private readonly connections: McpConnection[];
  private readonly file: string;
  private readonly io: ReviewIO;
  private pins: Pins = { version: 1, servers: {} };

  constructor(connections: McpConnection[], file: string, io: ReviewIO) {
    this.connections = connections;
    this.file = file;
    this.io = io;
  }

  async start(): Promise<void> {
    this.pins = await loadPins(this.file);
    let recorded = false;
    for (const connection of this.connections) {
      this.describe(connection);
      const now = pinOf(connection.target, connection.definitions);
      const check = comparePin(this.pins.servers[connection.name], now);
      if (check.state === 'new') {
        this.pins.servers[connection.name] = now;
        recorded = true;
        this.io.print(`  first connection: its tool definitions are recorded, and you will be told when they change`);
        continue;
      }
      if (check.state === 'same') continue;
      const what = describeChange(check);
      connection.trust.accepted = false;
      connection.trust.warning = `${connection.name} changed its tool definitions (${what}) and you have not accepted them (/mcp accept ${connection.name}).`;
      this.io.warn(`  ⚠ ${connection.name} changed its tool definitions since you accepted them: ${what}.`);
      if (await this.io.confirm(`Accept the new definitions of ${connection.name}? Until you do, every call to it asks first.`)) {
        this.pins.servers[connection.name] = now;
        connection.trust.accepted = true;
        recorded = true;
      }
    }
    if (recorded) await savePins(this.file, this.pins);
  }

  /** /mcp: the servers, their tools and their state. */
  list(): void {
    if (this.connections.length === 0) this.io.print('No MCP servers.');
    for (const connection of this.connections) this.describe(connection);
  }

  /** /mcp accept <server>. */
  async accept(name: string): Promise<void> {
    const connection = this.connections.find((known) => known.name === name);
    if (!connection) {
      this.io.print(`No MCP server named "${safeLine(name)}".`);
      return;
    }
    this.pins.servers[name] = pinOf(connection.target, connection.definitions);
    connection.trust.accepted = true;
    delete connection.trust.warning;
    await savePins(this.file, this.pins);
    this.io.print(`Accepted the tool definitions of ${name}.`);
  }

  private describe(connection: McpConnection): void {
    const names = connection.definitions.map((tool) => tool.name);
    this.io.print(`MCP ${connection.name} (${safeLine(connection.target)}): ${names.length} tool${names.length === 1 ? '' : 's'}`);
    if (names.length > 0) this.io.print(`  tools: ${names.join(', ')}`);
    const auto = connection.autoApproved;
    this.io.print(
      auto.length === 0
        ? '  every call asks first'
        : `  run without asking (your autoApprove): ${auto.length === names.length ? `all ${names.length}` : auto.join(', ')}`,
    );
    if (!connection.trust.accepted) this.io.warn('  ⚠ definitions changed and not accepted: every call asks first');
    if (connection.unknownAutoApprove.length > 0) {
      this.io.warn(`  ⚠ autoApprove names tools ${connection.name} does not have: ${connection.unknownAutoApprove.map(safeLine).join(', ')}`);
    }
    if (connection.skipped.length > 0) {
      this.io.warn(`  ⚠ left out, their names are not valid tool names: ${connection.skipped.map(safeLine).join(', ')}`);
    }
  }
}

function describeChange(check: PinCheck): string {
  const parts: string[] = [];
  if (check.target) parts.push(`it now runs ${safeLine(check.target.now)} instead of ${safeLine(check.target.before)}`);
  if (check.added.length > 0) parts.push(`new tools ${check.added.join(', ')}`);
  if (check.removed.length > 0) parts.push(`removed ${check.removed.join(', ')}`);
  if (check.changed.length > 0) parts.push(`changed ${check.changed.join(', ')}`);
  return parts.join('; ');
}
