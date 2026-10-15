import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTestServer } from './fixtures/mcp-server.js';
import { connectMcpServer, connectMcpServers, loadMcpConfig, parseMcpConfig, toOutput, type McpServerConfig } from './mcp.js';
import { Toolbox } from './toolbox.js';

async function inMemory(config: Partial<McpServerConfig> = {}) {
  const [client, server] = InMemoryTransport.createLinkedPair();
  await createTestServer().connect(server);
  return connectMcpServer({ name: 'test', command: 'unused', autoApprove: false, ...config }, client);
}

test('config: the mcpServers shape, disabled servers, env expansion', () => {
  process.env.AGENT_TEST_TOKEN = 'secret';
  const configs = parseMcpConfig(
    {
      mcpServers: {
        fs: { command: 'npx', args: ['-y', 'server'], env: { TOKEN: '${AGENT_TEST_TOKEN}' }, cwd: 'sub', autoApprove: ['read'] },
        web: { url: 'https://example.com/mcp', type: 'streamable-http', autoApprove: true, timeout: 5 },
        off: { command: 'x', disabled: true },
      },
    },
    '/base',
  );
  assert.deepEqual(configs, [
    {
      name: 'fs',
      command: 'npx',
      args: ['-y', 'server'],
      env: { TOKEN: 'secret' },
      cwd: join('/base', 'sub'),
      autoApprove: ['read'],
    },
    { name: 'web', url: 'https://example.com/mcp', type: 'http', autoApprove: true, timeoutMs: 5000 },
  ]);
});

test('config: mistakes are explained', () => {
  assert.throws(() => parseMcpConfig({}, '/'), /mcpServers/);
  assert.throws(() => parseMcpConfig({ mcpServers: { a: {} } }, '/'), /needs "command"/);
  assert.throws(() => parseMcpConfig({ mcpServers: { a: { command: 'x', args: 'y' } } }, '/'), /list of strings/);
  assert.throws(() => parseMcpConfig({ mcpServers: { 'a.b': { command: 'x' } } }, '/'), /server names/);
});

test('config: a broken file names itself', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-mcp-'));
  const file = join(dir, 'mcp.json');
  await writeFile(file, '{ nope');
  await assert.rejects(loadMcpConfig(file), /mcp\.json is not valid JSON/);
  await rm(dir, { recursive: true });
});

test('tools are listed with the server name in front and their schema', async () => {
  const connection = await inMemory();
  try {
    assert.deepEqual(
      connection.tools.map((tool) => tool.name),
      ['test.echo', 'test.fail', 'test.picture'],
    );
    assert.deepEqual(connection.tools[0]?.params.required, ['text']);
    assert.equal(connection.tools[0]?.description, 'Returns the text it gets.');
  } finally {
    await connection.close();
  }
});

test('calls go through the toolbox: approval, body, errors, images', async () => {
  const connection = await inMemory({ autoApprove: ['echo'] });
  const asked: string[] = [];
  const box = new Toolbox(connection.tools, {
    approve: async (request) => {
      asked.push(request.summary);
      return { approved: true };
    },
  });
  try {
    // "text" is the only required string, so the free text fills it.
    assert.deepEqual(await box.call({ index: 1, tool: 'test.echo', args: {}, body: 'hi\n' }), { ok: true, text: 'echo: hi\n' });
    assert.deepEqual(asked, []);
    assert.deepEqual(await box.call({ index: 2, tool: 'test.fail', args: {} }), { ok: false, text: 'it went wrong' });
    assert.deepEqual(asked, ['call test.fail {}']);
    assert.deepEqual(await box.call({ index: 3, tool: 'test.picture', args: {} }), {
      ok: true,
      text: '[image image/png, 3 bytes, not shown]',
    });
  } finally {
    await connection.close();
  }
});

test('a real stdio server is started, used and stopped', async () => {
  const script = fileURLToPath(new URL('./fixtures/stdio-server.ts', import.meta.url));
  const { connections, close } = await connectMcpServers(
    [{ name: 'local', command: process.execPath, args: ['--import', 'tsx', script], autoApprove: true }],
    (message) => assert.fail(message),
  );
  try {
    const box = new Toolbox(connections.flatMap((connection) => connection.tools));
    assert.deepEqual(await box.call({ index: 1, tool: 'local.echo', args: { text: 'over stdio' } }), {
      ok: true,
      text: 'echo: over stdio',
    });
  } finally {
    await close();
  }
});

test('a server that does not start is reported and skipped', async () => {
  const warnings: string[] = [];
  const { connections } = await connectMcpServers(
    [{ name: 'broken', command: process.execPath, args: ['-e', 'console.error("bad config"); process.exit(1)'], autoApprove: false }],
    (message) => warnings.push(message),
  );
  assert.equal(connections.length, 0);
  assert.match(warnings[0] ?? '', /"broken" did not start/);
});

test('results without content fall back to structured content', () => {
  assert.deepEqual(toOutput({ content: [], structuredContent: { a: 1 } }), { ok: true, text: '{\n  "a": 1\n}' });
  assert.deepEqual(toOutput({ content: [{ type: 'resource', resource: { uri: 'file:///a', text: 'body' } }] }), {
    ok: true,
    text: 'body',
  });
});
