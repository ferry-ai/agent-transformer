/**
 * The throwaway project the spike works on, the tasks it gives the agent, and the
 * replies a well-behaved model would write for them (the FakeAdapter script). Every
 * text here goes to the chat provider in a live run: it is neutral and holds no
 * personal data.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentResult } from '../../src/agent/loop.js';

/** Lines of data/server.log that say ERROR, by line number (from 1). */
export const LOG_ERRORS: Readonly<Record<number, string>> = {
  41: 'ERROR cache warm-up failed: timeout after 30 s',
  157: 'ERROR database connection lost, retrying',
  268: 'ERROR disk usage above 95 % on /var',
};
const LOG_LINES = 270;

/**
 * data/access.log: about 18 000 characters too, and every request to /api/orders sits
 * in the middle of the file, the part the inline summary leaves out (the summary keeps
 * the first and last 6 400 characters). Counting them needs the attached full text:
 * the task that asks for it tells whether the model reads attachments.
 */
export const ACCESS_ORDERS = { from: 150, to: 250 } as const;
const ACCESS_LINES = 400;

export const PROJECT_FILES: Readonly<Record<string, string>> = {
  'README.md': [
    '# Tiny utils',
    '',
    'A small JavaScript library used to try a coding agent. It has no dependencies.',
    '',
    '- src/math.js: add() and subtract()',
    '- src/strings.js: capitalize() and reverse()',
    '- test/math.test.js: tests for src/math.js, run with `node --test test/`',
    '- notes/todo.md: what is left to do',
    '- data/server.log, data/access.log: sample log files',
    '',
  ].join('\n'),
  'package.json': `${JSON.stringify({ name: 'tiny-utils', version: '1.0.0', type: 'module', scripts: { test: 'node --test test/' } }, null, 2)}\n`,
  'src/math.js': 'export function add(a, b) {\n  return a + b;\n}\n\nexport function subtract(a, b) {\n  return a + b;\n}\n',
  'src/strings.js':
    'export function capitalize(text) {\n  return text.charAt(0).toUpperCase() + text.slice(1);\n}\n\n' +
    "export function reverse(text) {\n  return [...text].reverse().join('');\n}\n",
  'test/math.test.js': [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "import { add, subtract } from '../src/math.js';",
    '',
    "test('add', () => {",
    '  assert.equal(add(2, 3), 5);',
    '});',
    '',
    "test('subtract', () => {",
    '  assert.equal(subtract(5, 3), 2);',
    '});',
    '',
  ].join('\n'),
  'notes/todo.md': '# To do\n\n- [ ] Fix subtract()\n- [ ] Document the string helpers\n- [ ] Add multiply()\n',
  'data/server.log': serverLog(),
  'data/access.log': accessLog(),
};

/**
 * About 18 000 characters: more than the agent shows inline for read_file (16 000),
 * less than the toolbox's cut (20 000). So reading it sends a summary plus the whole
 * file as an attachment, and the answer is in both: the summary keeps the ERROR lines.
 */
function serverLog(): string {
  const lines: string[] = [];
  for (let i = 1; i <= LOG_LINES; i += 1) {
    const minute = String(i % 60).padStart(2, '0');
    const hour = String(Math.floor(i / 60)).padStart(2, '0');
    const at = `2026-10-01T${hour}:${minute}:00Z`;
    lines.push(`${at} ${LOG_ERRORS[i] ?? `INFO request ${1000 + i} served in ${10 + ((i * 7) % 90)} ms by worker ${1 + (i % 4)}`}`);
  }
  return `${lines.join('\n')}\n`;
}

function accessLog(): string {
  const others = ['/api/items', '/api/users', '/health', '/metrics'];
  const lines: string[] = [];
  for (let i = 1; i <= ACCESS_LINES; i += 1) {
    const at = `2026-10-02T00:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`;
    const path = i >= ACCESS_ORDERS.from && i <= ACCESS_ORDERS.to ? '/api/orders' : others[i % others.length];
    lines.push(`${at} GET ${path} 200 ${5 + ((i * 13) % 60)} ms`);
  }
  return `${lines.join('\n')}\n`;
}

export async function writeProject(root: string): Promise<void> {
  for (const [path, text] of Object.entries(PROJECT_FILES)) {
    const file = join(root, ...path.split('/'));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}

export interface SpikeTask {
  id: string;
  /** What the user types. */
  prompt: string;
  /** The replies of a model that does the task right, in order: the FakeAdapter script. */
  replies: string[];
  /** Whether the task got done, judged on the workspace and the answer; says what is wrong. */
  check(root: string, result: AgentResult): Promise<string | undefined>;
  /** The user stops the task (Ctrl+C) as the first reply that calls this tool arrives: that reply's calls stay unrun. */
  stopAt?: string;
  /** Continue the task saved last in this workspace, as /resume does, instead of starting a new one. */
  resume?: boolean;
}

const tool = (header: object, body?: string): string =>
  `\`\`\`tool\n${JSON.stringify(header)}${body === undefined ? '' : `\n${body.replace(/\n$/, '')}`}\n\`\`\``;
const edit = (search: string, replace: string): string => `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;

async function text(root: string, path: string): Promise<string | undefined> {
  return readFile(join(root, ...path.split('/')), 'utf8').catch(() => undefined);
}

function expect(ok: boolean, problem: string): string | undefined {
  return ok ? undefined : problem;
}

const SUBTRACT_FIXED = 'export function subtract(a, b) {\n  return a - b;\n}';
const MULTIPLY = 'export function multiply(a, b) {\n  return a * b;\n}';
const MATH_DOC = '# Math\n\n- add(a, b) returns the sum of a and b.\n- subtract(a, b) returns a minus b.\n';

export const TASKS: readonly SpikeTask[] = [
  {
    id: 'explore',
    prompt: 'List the files of this project with list_dir (depth 3), then read README.md. Reply with a two-sentence summary of the project.',
    replies: [
      `I'll list the project and read the README.\n${tool({ tool: 'list_dir', args: { path: '.', depth: 3 } })}\n${tool({ tool: 'read_file', args: { path: 'README.md' } })}`,
      'Tiny utils is a small JavaScript library with math and string helpers, tests and a todo list. It has no dependencies and its tests run with node --test.',
    ],
    check: async (_root, result) => expect(result.answer.trim().length > 20, 'no summary in the answer'),
  },
  {
    id: 'fix-subtract',
    prompt:
      'src/math.js has a bug: subtract() adds instead of subtracting. Read the file, fix it with edit_file, then read it again to check the change. Reply with the corrected line.',
    replies: [
      tool({ tool: 'read_file', args: { path: 'src/math.js' } }),
      tool({ tool: 'edit_file', args: { path: 'src/math.js' } }, edit('export function subtract(a, b) {\n  return a + b;\n}', SUBTRACT_FIXED)),
      tool({ tool: 'read_file', args: { path: 'src/math.js' } }),
      'Fixed. The corrected line is `return a - b;` in subtract().',
    ],
    check: async (root) => expect((await text(root, 'src/math.js'))?.includes('return a - b;') === true, 'subtract() still adds'),
  },
  {
    id: 'log',
    prompt: 'Read data/server.log. How many lines contain ERROR, and what does the first of them say? Reply in two lines.',
    replies: [
      tool({ tool: 'read_file', args: { path: 'data/server.log' } }),
      '3 lines contain ERROR.\nThe first: "cache warm-up failed: timeout after 30 s".',
    ],
    check: async (_root, result) => expect(/\b3\b|three/i.test(result.answer), 'the answer does not say 3'),
  },
  {
    id: 'run-tests',
    prompt:
      'Check that the tests pass: run `node --test test/` with run_command. If the command is refused, read src/math.js and test/math.test.js instead and say whether the tests should pass.',
    replies: [
      tool({ tool: 'run_command', args: {} }, 'node --test test/'),
      `The command was refused, so I'll read the code.\n${tool({ tool: 'read_file', args: { path: 'src/math.js' } })}\n${tool({ tool: 'read_file', args: { path: 'test/math.test.js' } })}`,
      'The command was refused. From the code, both tests (add and subtract) should pass.',
    ],
    check: async (_root, result) => expect(/pass/i.test(result.answer), 'no verdict on the tests'),
  },
  {
    id: 'math-doc',
    prompt: 'Read src/math.js, then create docs/math.md with write_file: one line per exported function, saying what it returns. Reply with the file name.',
    // The user stops it (Ctrl+C) as the reply with write_file arrives: the call stays unrun, and the next task resumes it.
    stopAt: 'write_file',
    replies: [
      tool({ tool: 'read_file', args: { path: 'src/math.js' } }),
      tool({ tool: 'write_file', args: { path: 'docs/math.md' } }, MATH_DOC),
    ],
    check: async (root, result) =>
      expect(
        result.status === 'aborted' && result.pending >= 1 && (await text(root, 'docs/math.md')) === undefined,
        'not stopped with its write_file unrun',
      ),
  },
  {
    id: 'math-doc-resume',
    prompt: '/resume',
    resume: true,
    replies: [
      tool({ tool: 'read_file', args: { path: 'src/math.js' } }),
      tool({ tool: 'write_file', args: { path: 'docs/math.md' } }, MATH_DOC),
      'Created docs/math.md.',
    ],
    check: async (root) => {
      const doc = await text(root, 'docs/math.md');
      return expect(doc !== undefined && /add/.test(doc) && /subtract/.test(doc), 'docs/math.md is missing or incomplete');
    },
  },
  {
    id: 'access-log',
    prompt: 'Read data/access.log. How many requests went to /api/orders? Count them in the whole file and reply with the number.',
    replies: [
      tool({ tool: 'read_file', args: { path: 'data/access.log' } }),
      `${ACCESS_ORDERS.to - ACCESS_ORDERS.from + 1} requests went to /api/orders.`,
    ],
    // Only the attached full text has them: a wrong count says the model saw the summary alone.
    check: async (_root, result) =>
      expect(
        new RegExp(`\\b${ACCESS_ORDERS.to - ACCESS_ORDERS.from + 1}\\b`).test(result.answer),
        'wrong count: the model did not read the attached file (or could not)',
      ),
  },
  // Spares, for a model that needs fewer replies than the scripted one.
  {
    id: 'usage-doc',
    prompt:
      'Read src/strings.js, then create docs/usage.md with write_file: one short section per exported function, each with a one-line example. Reply with the list of sections.',
    replies: [
      `${tool({ tool: 'update_task', args: {} }, '- [ ] Read src/strings.js\n- [ ] Write docs/usage.md')}\n${tool({ tool: 'read_file', args: { path: 'src/strings.js' } })}`,
      tool(
        { tool: 'write_file', args: { path: 'docs/usage.md' } },
        "# Usage\n\n## capitalize(text)\n\n`capitalize('hello')` returns `'Hello'`.\n\n## reverse(text)\n\n`reverse('abc')` returns `'cba'`.\n",
      ),
      'Created docs/usage.md with two sections: capitalize(text) and reverse(text).',
    ],
    check: async (root) => {
      const doc = await text(root, 'docs/usage.md');
      return expect(doc !== undefined && /capitalize/.test(doc) && /reverse/.test(doc), 'docs/usage.md is missing or incomplete');
    },
  },
  {
    id: 'multiply',
    prompt:
      'Add a function multiply(a, b) to src/math.js and a test for it in test/math.test.js. Read both files first, then change them with edit_file. Reply with what you changed.',
    replies: [
      `${tool({ tool: 'read_file', args: { path: 'src/math.js' } })}\n${tool({ tool: 'read_file', args: { path: 'test/math.test.js' } })}`,
      [
        tool({ tool: 'edit_file', args: { path: 'src/math.js' } }, edit(SUBTRACT_FIXED, `${SUBTRACT_FIXED}\n\n${MULTIPLY}`)),
        tool(
          { tool: 'edit_file', args: { path: 'test/math.test.js' } },
          [
            edit("import { add, subtract } from '../src/math.js';", "import { add, multiply, subtract } from '../src/math.js';"),
            edit(
              "test('subtract', () => {\n  assert.equal(subtract(5, 3), 2);\n});",
              "test('subtract', () => {\n  assert.equal(subtract(5, 3), 2);\n});\n\ntest('multiply', () => {\n  assert.equal(multiply(4, 3), 12);\n});",
            ),
          ].join('\n'),
        ),
      ].join('\n'),
      'Added multiply(a, b) to src/math.js and a multiply test to test/math.test.js.',
    ],
    check: async (root) => {
      const math = await text(root, 'src/math.js');
      const test = await text(root, 'test/math.test.js');
      return expect(math?.includes('function multiply') === true && test?.includes('multiply(') === true, 'multiply() or its test is missing');
    },
  },
  {
    id: 'todo',
    prompt:
      'In notes/todo.md, mark the first and the third items as done and add the item "- [ ] Write a changelog" at the end. Read the file first, then use edit_file. Reply with the new list.',
    replies: [
      tool({ tool: 'read_file', args: { path: 'notes/todo.md' } }),
      tool(
        { tool: 'edit_file', args: { path: 'notes/todo.md' } },
        [edit('- [ ] Fix subtract()', '- [x] Fix subtract()'), edit('- [ ] Add multiply()', '- [x] Add multiply()\n- [ ] Write a changelog')].join('\n'),
      ),
      '- [x] Fix subtract()\n- [ ] Document the string helpers\n- [x] Add multiply()\n- [ ] Write a changelog',
    ],
    check: async (root) => {
      const todo = (await text(root, 'notes/todo.md')) ?? '';
      const ok = /- \[x\] Fix subtract\(\)/i.test(todo) && /- \[x\] Add multiply\(\)/i.test(todo) && /Write a changelog/.test(todo);
      return expect(ok, 'notes/todo.md is not updated');
    },
  },
  {
    id: 'changelog',
    prompt:
      'Create CHANGELOG.md with write_file: a "## Unreleased" heading and one bullet per change made to this project so far (look at the files if you need to). Then list the files of the project with list_dir (depth 2) and reply with that list.',
    replies: [
      tool(
        { tool: 'write_file', args: { path: 'CHANGELOG.md' } },
        '# Changelog\n\n## Unreleased\n\n- Fixed subtract(), which added instead of subtracting.\n- Added docs/usage.md and docs/math.md.\n- Added multiply() and its test.\n- Updated notes/todo.md.\n',
      ),
      tool({ tool: 'list_dir', args: { path: '.', depth: 2 } }),
      'CHANGELOG.md, README.md, package.json, data/, docs/, notes/, src/, test/',
    ],
    check: async (root) => expect(/Unreleased/.test((await text(root, 'CHANGELOG.md')) ?? ''), 'CHANGELOG.md is missing'),
  },
  {
    id: 'strings-test',
    prompt:
      'Read test/math.test.js, then add test/strings.test.js with write_file: one test for capitalize() and one for reverse(), in the same style. Reply with the name of the new file.',
    replies: [
      tool({ tool: 'read_file', args: { path: 'test/math.test.js' } }),
      tool(
        { tool: 'write_file', args: { path: 'test/strings.test.js' } },
        "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { capitalize, reverse } from '../src/strings.js';\n\n" +
          "test('capitalize', () => {\n  assert.equal(capitalize('hello'), 'Hello');\n});\n\ntest('reverse', () => {\n  assert.equal(reverse('abc'), 'cba');\n});\n",
      ),
      'Added test/strings.test.js.',
    ],
    check: async (root) => expect(/reverse/.test((await text(root, 'test/strings.test.js')) ?? ''), 'test/strings.test.js is missing'),
  },
];

/** The FakeAdapter script of a run that does every task right: the replies of all tasks in order. */
export function idealScript(tasks: readonly SpikeTask[] = TASKS): string[] {
  return tasks.flatMap((task) => task.replies);
}
