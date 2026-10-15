/**
 * A tiny MCP server for the tests: "echo" returns its text, "fail" reports an error,
 * "picture" returns an image. stdio-server.ts serves it to a child process.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export function createTestServer(): Server {
  const server = new Server({ name: 'test-server', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'echo',
        description: 'Returns the text it gets.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string', description: 'What to echo.' } },
          required: ['text'],
        },
      },
      { name: 'fail', description: 'Always fails.', inputSchema: { type: 'object' } },
      { name: 'picture', description: 'Returns an image.', inputSchema: { type: 'object' } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    switch (request.params.name) {
      case 'echo':
        return { content: [{ type: 'text', text: `echo: ${String(args.text)}` }] };
      case 'fail':
        return { content: [{ type: 'text', text: 'it went wrong' }], isError: true };
      case 'picture':
        return { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] };
      default:
        throw new Error(`no tool ${request.params.name}`);
    }
  });
  return server;
}
