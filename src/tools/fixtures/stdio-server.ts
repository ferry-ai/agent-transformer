import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createTestServer } from './mcp-server.js';

await createTestServer().connect(new StdioServerTransport());
