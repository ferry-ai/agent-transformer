import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTestServer } from './fixtures/mcp-server.js';
import { connectMcpServer } from './mcp.js';
import { nativeTools } from './native.js';
import { REDACTION_MARK, redactSecrets } from './redact.js';
import { Toolbox } from './toolbox.js';

// Built from pieces at run time: the source holds nothing a secret scanner would flag.
const fake = {
  github: ['gh', 'p_', 'Z'.repeat(36)].join(''),
  githubPat: ['github', '_pat_', 'A1'.repeat(15)].join(''),
  aws: ['AK', 'IA', 'Q'.repeat(16)].join(''),
  awsSecret: 'k'.repeat(20) + '/'.repeat(1) + 'K'.repeat(19),
  slack: ['xo', 'xb-', '1234567890-abcdefghijkl'].join(''),
  webhook: ['https://hooks.', 'slack.com/services/', 'T000/B000/XXXX'].join(''),
  key: [['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' '), 'b3BlbnNzaC1rZXktdjEAAAAA', 'QUJDREVGR0g=', ['-----END', 'OPENSSH PRIVATE KEY-----'].join(' ')].join('\n'),
};

test('obvious secrets are masked, with what they were', () => {
  const text = [
    `token=${fake.github}`,
    `pat ${fake.githubPat}`,
    `AWS_ACCESS_KEY_ID=${fake.aws}`,
    `aws_secret_access_key = ${fake.awsSecret}`,
    `SLACK=${fake.slack}`,
    `hook: ${fake.webhook}`,
    fake.key,
    'after the key',
  ].join('\n');
  const { text: out, count } = redactSecrets(text);
  assert.equal(count, 7);
  for (const secret of Object.values(fake)) assert.ok(!out.includes(secret), secret.slice(0, 12));
  assert.match(out, new RegExp(`token=\\[${REDACTION_MARK}: GitHub token\\]`));
  assert.match(out, /aws_secret_access_key = \[REDACTED by agent-transformer: AWS secret key\]/);
  assert.match(out, /\[REDACTED by agent-transformer: private key\]\nafter the key$/);
});

test('a private key cut by truncation is masked to its end', () => {
  const cut = fake.key.split('\n').slice(0, 2).join('\n');
  assert.equal(redactSecrets(`before\n${cut}`).text, `before\n[${REDACTION_MARK}: private key]`);
});

test('ordinary text is left alone', () => {
  const text = 'AKIA is a prefix; ghp_short; xoxb-; sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08\n-----BEGIN PUBLIC KEY-----';
  assert.deepEqual(redactSecrets(text), { text, count: 0 });
});

test('command output is redacted, and the redacted text can never be written back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-redact-'));
  try {
    const env = `GITHUB_TOKEN=${fake.github}\nPORT=3000\n`;
    await writeFile(join(root, '.env'), env);
    const box = new Toolbox(nativeTools({ root }), { approve: async () => ({ approved: true }) });
    const shown = await box.call({ index: 1, tool: 'run_command', args: { command: 'cat .env' } });
    assert.ok(shown.ok);
    assert.ok(!shown.text.includes(fake.github));
    const redacted = shown.text.replace(/^\[exit code 0\]\n/, '');
    assert.equal(redacted, `GITHUB_TOKEN=[${REDACTION_MARK}: GitHub token]\nPORT=3000`);

    // What a confused (or manipulated) model would do next.
    const attempts = [
      { tool: 'write_file', args: { path: '.env' }, body: `${redacted}\nDEBUG=1\n` },
      { tool: 'edit_file', args: { path: '.env' }, body: `<<<<<<< SEARCH\nPORT=3000\n=======\n${redacted}\n>>>>>>> REPLACE` },
      { tool: 'run_command', args: { command: `printf '%s\\n' '${redacted}' > .env` } },
    ];
    for (const [i, attempt] of attempts.entries()) {
      const result = await box.call({ index: i + 2, ...attempt });
      assert.equal(result.ok, false, attempt.tool);
      assert.match(result.text, /writing it back would destroy the original/, attempt.tool);
    }
    assert.equal(await readFile(join(root, '.env'), 'utf8'), env, 'the secret is still there');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP results are redacted, and MCP calls cannot carry the mark either', async () => {
  const [client, server] = InMemoryTransport.createLinkedPair();
  await createTestServer().connect(server);
  const connection = await connectMcpServer({ name: 'test', command: 'unused', autoApprove: true }, client);
  try {
    const box = new Toolbox(connection.tools);
    const echoed = await box.call({ index: 1, tool: 'test.echo', args: { text: `key ${fake.aws}` } });
    assert.equal(echoed.text, `echo: key [${REDACTION_MARK}: AWS access key]`);
    const back = await box.call({ index: 2, tool: 'test.echo', args: { text: echoed.text } });
    assert.equal(back.ok, false);
  } finally {
    await connection.close();
  }
});
