import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fenceFor,
  formatResults,
  parseLenientJson,
  parseToolCalls,
  proseOf,
  type ParsedBlock,
  type ToolCall,
} from './protocol.js';

const known = new Set(['read_file', 'write_file', 'run_command']);
const parse = (text: string): ParsedBlock[] => parseToolCalls(text, { isTool: (name) => known.has(name) });
const calls = (text: string): ToolCall[] =>
  parse(text).flatMap((block) => (block.kind === 'call' ? [block.call] : []));
const errors = (text: string): string[] =>
  parse(text).flatMap((block) => (block.kind === 'error' ? [block.error.message] : []));

test('a single call with prose around it', () => {
  const reply = 'Let me look at the file first.\n\n```tool\n{"tool": "read_file", "args": {"path": "src/a.ts"}}\n```\n\nThen I will fix it.';
  assert.deepEqual(calls(reply), [{ index: 1, tool: 'read_file', args: { path: 'src/a.ts' } }]);
});

test('several calls run in reply order, other code blocks are ignored', () => {
  const reply = [
    '```ts',
    'const x = 1;',
    '```',
    '```tool',
    '{"tool": "read_file", "args": {"path": "a"}}',
    '```',
    'and',
    '```tool',
    '{"tool": "read_file", "args": {"path": "b"}}',
    '```',
  ].join('\n');
  assert.deepEqual(
    calls(reply).map((call) => [call.index, call.args.path]),
    [
      [1, 'a'],
      [2, 'b'],
    ],
  );
});

test('the text after the JSON line is the body, kept verbatim', () => {
  const reply = '```tool\n{"tool": "write_file", "args": {"path": "x.py"}}\nprint("a \\"quoted\\" \\\\ thing")\n\n    indented\n```';
  const [call] = calls(reply);
  assert.equal(call?.body, 'print("a \\"quoted\\" \\\\ thing")\n\n    indented\n');
});

test('a longer outer fence lets the body contain ``` lines', () => {
  const reply = '````tool\n{"tool": "write_file", "args": {"path": "README.md"}}\n# Title\n```\ncode\n```\n````';
  assert.equal(calls(reply)[0]?.body, '# Title\n```\ncode\n```\n');
});

test('a nested ```lang block does not close a three-backtick tool block', () => {
  const reply = '```tool\n{"tool": "write_file", "args": {"path": "README.md"}}\nUsage:\n```bash\nnpm test\n```\nDone.\n```\nAfter.';
  const [call] = calls(reply);
  assert.equal(call?.body, 'Usage:\n```bash\nnpm test\n```\nDone.\n');
});

test('tilde fences and indented blocks (inside a list) are read', () => {
  const reply = '1. First:\n   ~~~tool\n   {"tool": "read_file", "args": {"path": "a"}}\n   ~~~';
  assert.deepEqual(calls(reply)[0]?.args, { path: 'a' });
});

test('model slips are repaired: raw newlines, trailing commas, Windows paths', () => {
  const reply = '```tool\n{"tool": "write_file", "args": {"path": "C:\\Users\\me\\a.txt", "content": "line 1\nline 2",},}\n```';
  assert.deepEqual(calls(reply)[0]?.args, { path: 'C:\\Users\\me\\a.txt', content: 'line 1\nline 2' });
});

test('OpenAI-style name/arguments, string arguments and flat arguments are accepted', () => {
  const reply = [
    '```tool',
    '{"name": "read_file", "arguments": "{\\"path\\": \\"a\\"}"}',
    '```',
    '```tool',
    '{"function": {"name": "read_file", "arguments": {"path": "b"}}}',
    '```',
    '```tool',
    '{"tool": "read_file", "path": "c"}',
    '```',
  ].join('\n');
  assert.deepEqual(
    calls(reply).map((call) => [call.tool, call.args.path]),
    [
      ['read_file', 'a'],
      ['read_file', 'b'],
      ['read_file', 'c'],
    ],
  );
});

test('shorthand: the tool name, then its JSON arguments', () => {
  assert.deepEqual(calls('```tool\nread_file {"path": "a"}\n```')[0], { index: 1, tool: 'read_file', args: { path: 'a' } });
  assert.deepEqual(calls('```tool\nrun_command\nls -la\n```')[0], { index: 1, tool: 'run_command', args: {}, body: 'ls -la\n' });
});

test('an untagged block counts only when it names a known tool', () => {
  // The page fallback can lose the language tag of a code block.
  assert.equal(calls('```\n{"tool": "read_file", "args": {"path": "a"}}\n```').length, 1);
  assert.equal(calls('```json\n{"tool": "read_file", "args": {"path": "a"}}\n```').length, 1);
  assert.equal(calls('```json\n{"tool": "rm_rf", "args": {}}\n```').length, 0);
  assert.equal(calls('```json\n{"name": "John", "age": 3}\n```').length, 0);
  assert.equal(calls('```\nread_file {"path": "a"}\n```').length, 0);
  assert.deepEqual(errors('```json\n{"tool": "read_file", broken\n```'), []);
});

test('malformed tool blocks become errors and keep their place', () => {
  const reply = [
    '```tool',
    '{"tool": "read_file", "args": {"path": "a"}}',
    '```',
    '```tool',
    '{"tool": "read_file", "args": {"path": "b"}',
    '```',
    '```tool',
    'just some words',
    '```',
    '```tool',
    '{"args": {"path": "c"}}',
    '```',
    '```tool',
    '{"tool": "read_file", "args": ["a"]}',
    '```',
  ].join('\n');
  const blocks = parse(reply);
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ['call', 'error', 'error', 'error', 'error'],
  );
  assert.deepEqual(
    blocks.map((block) => (block.kind === 'call' ? block.call.index : block.error.index)),
    [1, 2, 3, 4, 5],
  );
  assert.match(errors(reply)[0] ?? '', /not closed/);
  assert.match(errors(reply)[2] ?? '', /no "tool" field/);
});

test('invalid JSON is reported with a hint', () => {
  const [message] = errors('```tool\n{"tool": "run_command", "args": {"command": "echo "hi""}}\n```');
  assert.match(message ?? '', /not valid JSON.*after the JSON line/s);
});

test('text after the JSON on the same line is an error', () => {
  assert.match(errors('```tool\n{"tool": "read_file", "args": {}}} extra\n```')[0] ?? '', /Unexpected text/);
});

test('a tool block cut off at the end of the reply is an error', () => {
  const [message] = errors('Writing it now:\n```tool\n{"tool": "write_file", "args": {"path": "a"}}\nhalf a fi');
  assert.match(message ?? '', /not closed/);
});

test('no tool blocks: no calls', () => {
  assert.deepEqual(parse('All done. The tests pass.\n\n```bash\nnpm test\n```'), []);
  assert.deepEqual(parse('Inline ```tool {"tool": "read_file"}``` is not a block.'), []);
});

test('CRLF line endings', () => {
  assert.deepEqual(calls('```tool\r\n{"tool": "read_file", "args": {"path": "a"}}\r\n```\r\n')[0]?.args, { path: 'a' });
});

test('lenient JSON keeps valid escapes and fails on hopeless input', () => {
  assert.deepEqual(parseLenientJson('{"a": "x\\ny\\u0041"}'), { value: { a: 'x\nyA' } });
  assert.ok('error' in parseLenientJson('{"a": '));
});

test('results are fenced so their content cannot break out', () => {
  assert.equal(fenceFor('no ticks'), '```');
  assert.equal(fenceFor('has ``` inside'), '````');
  const message = formatResults(
    [
      { index: 1, tool: 'read_file', ok: true, text: 'a ``` b' },
      { index: 2, tool: 'run_command', ok: false, text: 'exit 1' },
    ],
    'Continue.',
  );
  assert.equal(
    message,
    'Tool results:\n\n[1] read_file: ok\n````text\na ``` b\n````\n\n[2] run_command: error\n```text\nexit 1\n```\n\nContinue.',
  );
});

test('prose: the reply without its tool blocks, other code kept', () => {
  const reply = [
    'Reading two files.',
    '',
    '```tool',
    '{"tool": "read_file", "args": {"path": "a"}}',
    '```',
    '',
    '```ts',
    'const kept = true;',
    '```',
    '```',
    '{"tool": "read_file", "args": {"path": "b"}}',
    '```',
    '',
    '',
    'Then I fix them.',
  ].join('\n');
  assert.equal(proseOf(reply, { isTool: (name) => known.has(name) }), 'Reading two files.\n\n```ts\nconst kept = true;\n```\n\nThen I fix them.');
  assert.equal(proseOf('Cut off:\n```tool\n{"tool": "x"'), 'Cut off:');
});
