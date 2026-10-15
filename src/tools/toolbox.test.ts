import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Toolbox, truncate } from './toolbox.js';
import { ToolError, type ApprovalRequest, type Tool } from './types.js';

function echo(overrides: Partial<Tool> = {}): Tool {
  return {
    name: 'echo',
    description: 'Echoes its arguments.',
    params: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        count: { type: 'integer' },
        loud: { type: 'boolean' },
      },
      required: ['text'],
    },
    run: async (args) => ({ ok: true, text: JSON.stringify(args) }),
    ...overrides,
  };
}

test('unknown tools list the available ones', async () => {
  const box = new Toolbox([echo()]);
  assert.deepEqual(await box.call({ index: 1, tool: 'nope', args: {} }), {
    ok: false,
    text: 'Unknown tool "nope". Available tools: echo.',
  });
});

test('arguments are checked and lightly coerced', async () => {
  const box = new Toolbox([echo()]);
  assert.equal(
    (await box.call({ index: 1, tool: 'echo', args: { text: 5, count: '3', loud: 'true' } })).text,
    '{"text":"5","count":3,"loud":true}',
  );
  assert.deepEqual(await box.call({ index: 1, tool: 'echo', args: {} }), {
    ok: false,
    text: 'Missing arguments for echo: text.',
  });
  assert.equal((await box.call({ index: 1, tool: 'echo', args: { text: 'a', count: 1.5 } })).text, '"count" must be integer, got number.');
});

test('the body goes to the declared parameter, or to the only missing required string', async () => {
  const declared = new Toolbox([echo({ body: 'text' })]);
  assert.equal((await declared.call({ index: 1, tool: 'echo', args: {}, body: 'hi\n' })).text, '{"text":"hi\\n"}');
  assert.match((await declared.call({ index: 1, tool: 'echo', args: { text: 'a' }, body: 'b' })).text, /given twice/);

  const inferred = new Toolbox([echo()]);
  assert.equal((await inferred.call({ index: 1, tool: 'echo', args: { count: 1 }, body: 'x' })).text, '{"count":1,"text":"x"}');
  assert.match((await inferred.call({ index: 1, tool: 'echo', args: { text: 'a' }, body: 'x' })).text, /takes no text/);
});

test('tool failures become results: ToolError verbatim, others prefixed', async () => {
  const box = new Toolbox([
    echo({ name: 'a', run: async () => Promise.reject(new ToolError('expected')) }),
    echo({ name: 'b', run: async () => Promise.reject(new Error('boom')) }),
  ]);
  assert.deepEqual(await box.call({ index: 1, tool: 'a', args: { text: '' } }), { ok: false, text: 'expected' });
  assert.deepEqual(await box.call({ index: 1, tool: 'b', args: { text: '' } }), { ok: false, text: 'The tool failed: boom' });
});

test('long results keep head and tail', async () => {
  const box = new Toolbox([echo({ run: async () => ({ ok: true, text: 'x'.repeat(50) + 'END' }) })], { maxResultChars: 20 });
  const { text } = await box.call({ index: 1, tool: 'echo', args: { text: '' } });
  assert.match(text, /^x{12}\n\[… 33 characters cut …\]\nx{5}END$/);
  assert.equal(truncate('short', 10), 'short');
});

test('duplicate tool names are rejected', () => {
  assert.throws(() => new Toolbox([echo(), echo()]), /Two tools/);
});

test('approvals get the hidden characters of the raw arguments; async approvals can refuse outright', async () => {
  const asked: ApprovalRequest[] = [];
  const box = new Toolbox(
    [
      echo({ approval: async (args) => ({ summary: `echo ${String(args.text)}`, detail: String(args.text) }) }),
      echo({
        name: 'never',
        approval: async () => {
          throw new ToolError('refused before asking');
        },
      }),
    ],
    {
      approve: async (request) => {
        asked.push(request);
        return { approved: true };
      },
    },
  );
  assert.equal((await box.call({ index: 1, tool: 'echo', args: { text: 'a\u202eb\x1b' } })).ok, true);
  assert.equal(asked[0]?.hidden, 2);
  assert.equal(asked[0]?.tool, 'echo');
  assert.deepEqual(await box.call({ index: 2, tool: 'never', args: { text: 'x' } }), { ok: false, text: 'refused before asking' });
  assert.equal(asked.length, 1);
});

test('a tool can ask in the middle of a run; without an approver the answer is no', async () => {
  const asking = echo({
    run: async (args, context) => {
      await context.confirm({ summary: 'do the risky part' });
      return { ok: true, text: `did ${String(args.text)}` };
    },
  });
  const yes = new Toolbox([asking], { approve: async () => ({ approved: true }) });
  assert.deepEqual(await yes.call({ index: 1, tool: 'echo', args: { text: 'it' } }), { ok: true, text: 'did it' });
  const no = new Toolbox([asking], { approve: async () => ({ approved: false, note: 'not now' }) });
  assert.deepEqual(await no.call({ index: 1, tool: 'echo', args: { text: 'it' } }), {
    ok: false,
    text: 'The user did not allow this call. The user says: not now',
  });
  const nobody = new Toolbox([asking]);
  assert.equal((await nobody.call({ index: 1, tool: 'echo', args: { text: 'it' } })).ok, false);
});
