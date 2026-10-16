import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Agent } from '../../agent/loop.js';
import { createApprover } from '../../approval-prompt.js';
import { AdapterError } from '../../core/adapter.js';
import { Toolbox } from '../../tools/toolbox.js';
import type { Tool } from '../../tools/types.js';
import type { Clipboard, ClipboardChoice } from './clipboard.js';
import { ClipboardAdapter } from './index.js';
import type { InputEvent, InputSession, UserInput } from './input.js';

/** A clipboard in memory. The tests never touch the real one. */
class FakeClipboard implements Clipboard {
  readonly name = 'fake';
  text = 'something the user copied earlier';
  readonly writes: string[] = [];
  reads = 0;
  failWrite: Error | undefined;
  failRead: Error | undefined;

  async read(): Promise<string> {
    this.reads += 1;
    if (this.failRead) throw this.failRead;
    return this.text;
  }

  async write(text: string): Promise<void> {
    if (this.failWrite) throw this.failWrite;
    this.text = text;
    this.writes.push(text);
  }
}

const INTERRUPT = Symbol('Ctrl+C');
/**
 * What the user does at one prompt: type a line, paste several at once ("a\nb"), close
 * the input (null) or press Ctrl+C. A function runs first, as when the user copies the
 * reply in the browser before pressing Enter.
 */
type Step = string | null | typeof INTERRUPT | (() => string | null | typeof INTERRUPT);

/** The terminal, scripted. Lines of one step arrive together, like a paste. */
class ScriptedInput implements UserInput {
  readonly prompts: string[] = [];
  listens = 0;
  private readonly steps: Step[];

  constructor(steps: Step[]) {
    this.steps = [...steps];
  }

  get left(): number {
    return this.steps.length;
  }

  listen(): InputSession {
    this.listens += 1;
    const queue: InputEvent[] = [];
    let open = true;
    return {
      next: async (prompt) => {
        if (!open) return { kind: 'closed' };
        const queued = queue.shift();
        if (queued) return queued;
        this.prompts.push(prompt);
        let step = this.steps.shift();
        if (typeof step === 'function') step = step();
        if (step === undefined) throw new Error(`The script has no more input (prompt "${prompt}").`);
        if (step === null) return { kind: 'closed' };
        if (step === INTERRUPT) return { kind: 'interrupt' };
        const [first = '', ...rest] = step.split('\n');
        queue.push(...rest.map((text): InputEvent => ({ kind: 'line', text })));
        return { kind: 'line', text: first };
      },
      drain: async () => queue.splice(0).flatMap((event) => (event.kind === 'line' ? [event.text] : [])),
      close: () => {
        open = false;
        queue.length = 0;
      },
    };
  }
}

async function setup(steps: Step[], clipboard: FakeClipboard | ClipboardChoice = new FakeClipboard()) {
  const input = new ScriptedInput(steps);
  const printed: string[] = [];
  const choice: ClipboardChoice = clipboard instanceof FakeClipboard ? { clipboard } : clipboard;
  const adapter = new ClipboardAdapter({ clipboard: choice, input, print: (text) => printed.push(text) });
  await adapter.open();
  const out = (): string => printed.join('\n');
  return { adapter, input, printed, out };
}

/** The user copies `text` in the browser, then presses Enter. */
const copyThenEnter = (clipboard: FakeClipboard, text: string) => (): string => {
  clipboard.text = text;
  return '';
};

test('a turn: the prompt goes to the clipboard and the terminal, Enter brings the reply back', async () => {
  const clipboard = new FakeClipboard();
  const { adapter, input, out } = await setup([copyThenEnter(clipboard, 'Hello!\n\n[[end of reply 1]]\n')], clipboard);
  const reply = await adapter.send('Say hello');

  assert.equal(reply.text, 'Hello!');
  assert.equal(reply.source, 'dom');
  assert.ok(reply.durationMs >= 0);
  const copied = clipboard.writes[0] ?? '';
  assert.equal(clipboard.writes.length, 1);
  assert.match(copied, /^\[\[agent-transformer prompt 1 begin\]\]\nSay hello\n\n.*\[\[end of reply 1\]\]\)\n\[\[agent-transformer prompt 1 end\]\]$/);
  assert.ok(out().includes(copied), 'the prompt is printed whole');
  assert.match(out(), /Prompt 1 is on the clipboard: paste it into a new conversation in the chat/);
  assert.match(out(), /press Enter/);
  assert.deepEqual(input.prompts, ['reply 1> ']);
  assert.equal(clipboard.reads, 1);
});

test('the numbers go up, and only the first prompt asks for a new conversation', async () => {
  const clipboard = new FakeClipboard();
  const { adapter, out, printed } = await setup(
    [copyThenEnter(clipboard, 'One.\n[[end of reply 1]]'), copyThenEnter(clipboard, 'Two.\n[[end of reply 2]]')],
    clipboard,
  );
  assert.equal((await adapter.send('first')).text, 'One.');
  printed.length = 0;
  assert.equal((await adapter.send('second')).text, 'Two.');
  assert.match(clipboard.writes[1] ?? '', /^\[\[agent-transformer prompt 2 begin\]\]\nsecond\n/);
  assert.match(out(), /Prompt 2 is on the clipboard: paste it into the chat and send it/);
});

test('Enter with the prompt still on the clipboard asks again', async () => {
  const clipboard = new FakeClipboard();
  const { adapter, input, out } = await setup(['', copyThenEnter(clipboard, 'Hi.\n[[end of reply 1]]')], clipboard);
  const reply = await adapter.send('Say hi');
  assert.equal(reply.text, 'Hi.');
  assert.match(out(), /The clipboard still holds the prompt: copy the reply first/);
  assert.doesNotMatch(out(), /\/accept/);
  assert.equal(clipboard.reads, 2);
  assert.deepEqual(input.prompts, ['reply 1> ', 'reply 1> ']);
});

test('a truncated reply is not passed on: the user copies it again', async () => {
  const clipboard = new FakeClipboard();
  const cut = 'I will read it.\n\n```tool\n{"tool": "read_file", "args": {"path": "a.py"}}';
  const whole = `${cut}\n\`\`\`\n[[end of reply 1]]`;
  const { adapter, out } = await setup([copyThenEnter(clipboard, cut), copyThenEnter(clipboard, whole)], clipboard);
  const reply = await adapter.send('Read a.py');
  assert.equal(reply.text, `${cut}\n\`\`\``);
  assert.match(out(), /A code block is not closed: the reply looks cut off/);
  assert.match(out(), /Or type \/accept to pass this one on as it is/);
});

test('a reply without its end line can be accepted as it is', async () => {
  const clipboard = new FakeClipboard();
  const { adapter, out } = await setup([copyThenEnter(clipboard, 'All done.'), '/accept'], clipboard);
  const reply = await adapter.send('Finish');
  assert.equal(reply.text, 'All done.');
  assert.match(out(), /does not end with \[\[end of reply 1\]\]/);
});

test('/accept with nothing refused yet does nothing', async () => {
  const clipboard = new FakeClipboard();
  const { adapter, out } = await setup(['/accept', copyThenEnter(clipboard, 'Ok.\n[[end of reply 1]]')], clipboard);
  assert.equal((await adapter.send('x')).text, 'Ok.');
  assert.match(out(), /Nothing to accept/);
});

test('the prompt pasted back is refused: from the clipboard and pasted into the terminal', async () => {
  const clipboard = new FakeClipboard();
  let prompt = '';
  const { adapter, out } = await setup(
    [
      // The user copied their own message in the chat: same markers, spacing changed.
      () => {
        prompt = clipboard.writes[0] ?? '';
        clipboard.text = prompt.replace('Do it\n', 'Do it  \n').replace(/\n/g, '\r\n');
        return '';
      },
      // Then pasted the prompt into the terminal: it ends at the prompt's end line.
      () => prompt,
      copyThenEnter(clipboard, 'Done.\n[[end of reply 1]]'),
    ],
    clipboard,
  );
  assert.equal((await adapter.send('Do it')).text, 'Done.');
  assert.match(out(), /This is a prompt \(it has the agent-transformer prompt markers\), not the reply/);
  assert.match(out(), /This is the prompt, not the reply\./);
});

test('the reply to an older prompt is refused', async () => {
  const clipboard = new FakeClipboard();
  const { adapter, out } = await setup(
    [copyThenEnter(clipboard, 'One.\n[[end of reply 1]]'), copyThenEnter(clipboard, 'One.\n[[end of reply 1]]'), copyThenEnter(clipboard, 'Two.\n[[end of reply 2]]')],
    clipboard,
  );
  await adapter.send('first');
  assert.equal((await adapter.send('second')).text, 'Two.');
  assert.match(out(), /This is the reply to prompt 1, not to prompt 2: copy the latest reply/);
});

test('paste fallback: a reply pasted into the terminal ends at its end line, and the rest of the paste is dropped', async () => {
  const clipboard = new FakeClipboard();
  const pasted = 'Here is the change.\n```tool\n{"tool": "note", "args": {"text": "x"}}\n```\n[[end of reply 1]]\ny\nmore text';
  const { adapter, input, out } = await setup([pasted], clipboard);
  const reply = await adapter.send('Change it');
  assert.equal(reply.text, 'Here is the change.\n```tool\n{"tool": "note", "args": {"text": "x"}}\n```');
  assert.match(out(), /Ignored 2 more lines pasted after the reply/);
  assert.equal(clipboard.reads, 0, 'a pasted reply does not read the clipboard');
  assert.deepEqual(input.prompts, ['reply 1> ']);
});

test('paste fallback: lines typed one by one, closed with [[end]]', async () => {
  const { adapter, input } = await setup(['First line', '', '  indented', '[[end]]']);
  const reply = await adapter.send('Write something');
  assert.equal(reply.text, 'First line\n\n  indented');
  assert.deepEqual(input.prompts, ['reply 1> ', '… ', '… ', '… ']);
});

test('without a clipboard, prompts are copied from the terminal and replies pasted into it', async () => {
  const { adapter, out } = await setup(['', 'Done.\n[[end of reply 1]]'], { unavailable: 'no clipboard tool was found: install xclip or xsel.' });
  const reply = await adapter.send('Do it');
  assert.equal(reply.text, 'Done.');
  assert.match(out(), /⚠ No clipboard: no clipboard tool was found: install xclip or xsel\. Prompts and replies go through the terminal/);
  assert.match(out(), /Copy prompt 1, from its begin line to its end line, into a new conversation/);
  assert.match(out(), /There is no clipboard: paste the reply here/);
  assert.match(out(), /\[\[agent-transformer prompt 1 begin\]\]\nDo it\n/);
});

test('when the clipboard fails, the terminal takes over for that turn', async () => {
  const clipboard = new FakeClipboard();
  clipboard.failWrite = new Error('xclip: cannot open display');
  clipboard.failRead = new Error('xclip: cannot open display');
  const { adapter, out } = await setup(['', 'Done.\n[[end of reply 1]]'], clipboard);
  assert.equal((await adapter.send('Do it')).text, 'Done.');
  assert.match(out(), /⚠ Could not copy the prompt to the clipboard: xclip: cannot open display/);
  assert.match(out(), /Copy prompt 1, from its begin line to its end line/);
  assert.match(out(), /⚠ Could not read the clipboard: xclip: cannot open display/);
});

test('/copy puts the prompt on the clipboard again', async () => {
  const clipboard = new FakeClipboard();
  const { adapter, out } = await setup(
    [
      () => {
        clipboard.text = 'the user copied something else';
        return '/copy';
      },
      copyThenEnter(clipboard, 'Ok.\n[[end of reply 1]]'),
    ],
    clipboard,
  );
  await adapter.send('Do it');
  assert.equal(clipboard.writes.length, 2);
  assert.equal(clipboard.writes[0], clipboard.writes[1]);
  assert.match(out(), /The prompt is on the clipboard again/);
});

test('attachments: the user is told which files to attach, by full path', async () => {
  const clipboard = new FakeClipboard();
  const { adapter, out } = await setup([copyThenEnter(clipboard, 'Seen.\n[[end of reply 1]]')], clipboard);
  await adapter.send('Look at these', { attachments: ['shots/screen.png', resolve('logs', 'build.log')] });
  assert.match(out(), /Attach these 2 files to the message by hand, with the chat's attach button \(nothing uploads them\):/);
  assert.ok(out().includes(`  ${resolve('shots/screen.png')}\n  ${resolve('logs', 'build.log')}`));
  assert.ok(!(clipboard.writes[0] ?? '').includes('screen.png'), 'the paths are for the user, not the prompt');
});

test('newChat tells the user to open a new conversation for the next prompt', async () => {
  const clipboard = new FakeClipboard();
  const { adapter, out, printed } = await setup(
    [copyThenEnter(clipboard, 'One.\n[[end of reply 1]]'), copyThenEnter(clipboard, 'Two.\n[[end of reply 2]]')],
    clipboard,
  );
  await adapter.send('first');
  printed.length = 0;
  await adapter.newChat();
  assert.match(out(), /Start a new conversation in the chat: the next prompt goes there/);
  await adapter.send('second');
  assert.match(out(), /Prompt 2 is on the clipboard: paste it into a new conversation in the chat/);
});

test('closed input, Ctrl+C and a closed adapter end the wait', async () => {
  const closed = await setup([null]);
  await assert.rejects(closed.adapter.send('x'), (error) => error instanceof AdapterError && error.kind === 'closed');

  const stopped = await setup([INTERRUPT]);
  await assert.rejects(stopped.adapter.send('x'), (error) => error instanceof AdapterError && error.kind === 'send_failed');

  const done = await setup([]);
  await done.adapter.close();
  await assert.rejects(done.adapter.send('x'), (error) => error instanceof AdapterError && error.kind === 'closed');
  await assert.rejects(done.adapter.newChat(), (error) => error instanceof AdapterError && error.kind === 'closed');
});

test('send before open, or without input, fails', async () => {
  const unopened = new ClipboardAdapter({ clipboard: { clipboard: new FakeClipboard() }, input: new ScriptedInput([]), print: () => undefined });
  await assert.rejects(unopened.send('x'), (error) => error instanceof AdapterError && error.kind === 'closed');
  const noInput = new ClipboardAdapter({ clipboard: { clipboard: new FakeClipboard() }, print: () => undefined });
  await noInput.open();
  await assert.rejects(noInput.send('x'), /needs the terminal input/);
});

test('the agent loop runs on it as usual, and approvals still need a terminal', async () => {
  const clipboard = new FakeClipboard();
  const notes: string[] = [];
  const ran: string[] = [];
  const tools: Tool[] = [
    {
      name: 'note',
      description: 'Writes a note.',
      params: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      body: 'text',
      run: async (args) => {
        notes.push(String(args.text).trim());
        return { ok: true, text: 'noted' };
      },
    },
    {
      name: 'shell',
      description: 'Runs a command.',
      params: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      approval: (args) => `run ${String(args.command)}`,
      run: async (args) => {
        ran.push(String(args.command));
        return { ok: true, text: 'ran' };
      },
    },
  ];
  const printed: string[] = [];
  const toolbox = new Toolbox(tools, {
    // As agent-cli builds it when stdin or stdout is not a terminal.
    approve: createApprover({ ask: async () => 'y', print: (text) => printed.push(text), interactive: false }),
  });
  const calls = '```tool\n{"tool": "note"}\nhello\n```\n```tool\n{"tool": "shell", "args": {"command": "rm -rf build"}}\n```';
  const input = new ScriptedInput([
    copyThenEnter(clipboard, `Two calls.\n\n${calls}\n[[end of reply 1]]`),
    copyThenEnter(clipboard, 'Noted it; the command was denied.\n[[end of reply 2]]'),
  ]);
  const adapter = new ClipboardAdapter({ clipboard: { clipboard }, input, print: (text) => printed.push(text) });
  await adapter.open();
  const agent = new Agent({ adapter, toolbox, root: '/work', sleep: async () => undefined });

  const result = await agent.run('Note hello, then clean the build');
  assert.equal(result.status, 'done');
  assert.equal(result.answer, 'Noted it; the command was denied.');
  assert.equal(result.iterations, 2);
  assert.deepEqual(notes, ['hello']);
  assert.deepEqual(ran, [], 'no terminal: the command is denied');
  assert.match(printed.join('\n'), /Denied: approvals need a terminal/);
  const second = clipboard.writes[1] ?? '';
  assert.match(second, /^\[\[agent-transformer prompt 2 begin\]\]\nTool results:/);
  assert.match(second, /\[1\] note: ok/);
  assert.match(second, /\[2\] shell: error/);
  assert.equal(input.left, 0);
});
