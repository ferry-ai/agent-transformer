import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local stand-in for chat.deepseek.com, for tests and dry runs: no network, no
 * account. It has what the adapter touches (the message box, a file input, the
 * DeepThink toggle, messages with .ds-markdown, each a [data-message-id] inside a
 * .ds-message, the completion request) and replays whatever stream the test gives it.
 * It says nothing about the real site: only captures do (docs/calibration.md).
 */

export interface MockRequest {
  /** Completion requests so far, this one included. */
  turn: number;
  prompt: string;
  /** Names of the files picked before the message was sent. */
  files: string[];
  /** DeepThink was on. */
  thinking: boolean;
}

export interface MockTurn {
  /** HTTP status of the completion response (default 200). */
  status?: number;
  contentType?: string;
  /** The completion response body, written one event at a time. */
  body: string;
  /** Inner HTML of the reply the page shows once the stream has ended; '' shows none. */
  html: string;
  /** A toast (role="alert") the page shows once the stream has ended, as for "server busy". */
  notice?: string;
  /** Pause between two events (default 10 ms). */
  delayMs?: number;
}

export interface MockSite {
  /** The chat page: give it to DeepSeekWebAdapter as `url`. */
  readonly url: string;
  readonly requests: MockRequest[];
  /** Loads of the chat page: a new chat is one more. */
  readonly pageLoads: number;
  /** When true the chat redirects to /sign_in, as DeepSeek does for a logged-out profile. */
  signedOut: boolean;
  close(): Promise<void>;
}

export async function startMockSite(answer: (request: MockRequest) => MockTurn): Promise<MockSite> {
  const requests: MockRequest[] = [];
  const replies = new Map<number, { html: string; notice: string }>();
  let pageLoads = 0;
  let signedOut = false;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (req.method === 'GET' && path === '/') {
      if (signedOut) {
        res.writeHead(302, { location: '/sign_in' }).end();
        return;
      }
      pageLoads += 1;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(CHAT_PAGE);
      return;
    }
    if (req.method === 'GET' && path === '/sign_in') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(SIGN_IN_PAGE);
      return;
    }
    if (req.method === 'POST' && path === '/api/v0/chat/completion') {
      const body = parseJson(await readBody(req));
      const request: MockRequest = {
        turn: requests.length + 1,
        prompt: typeof body.prompt === 'string' ? body.prompt : '',
        files: Array.isArray(body.files) ? body.files.map(String) : [],
        thinking: body.thinking_enabled === true,
      };
      requests.push(request);
      const turn = answer(request);
      replies.set(request.turn, { html: turn.html, notice: turn.notice ?? '' });
      res.writeHead(turn.status ?? 200, {
        'content-type': turn.contentType ?? 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'x-mock-turn': String(request.turn),
      });
      for (const chunk of turn.body.split(/(?<=\n\n)/)) {
        res.write(chunk);
        await new Promise((resolve) => setTimeout(resolve, turn.delayMs ?? 10));
      }
      res.end();
      return;
    }
    const reply = /^\/mock\/reply\/(\d+)$/.exec(path);
    if (req.method === 'GET' && reply) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(replies.get(Number(reply[1])) ?? { html: '', notice: '' }));
      return;
    }
    res.writeHead(404).end();
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/`,
    requests,
    get pageLoads() {
      return pageLoads;
    },
    get signedOut() {
      return signedOut;
    },
    set signedOut(value: boolean) {
      signedOut = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface MockReply {
  text: string;
  thinking?: string;
  /** The last status the stream sets; anything but FINISHED leaves the reply "ended early". */
  status?: string;
}

/**
 * A completion stream in the fragments format the parser expects (stream.ts): ready,
 * a snapshot, THINK and RESPONSE fragments grown by APPEND and bare continuations, a
 * BATCH, the status, then title and close. Modelled on public descriptions, not on a
 * capture.
 */
export function fragmentStream(reply: MockReply): string {
  const out: string[] = [];
  const emit = (data: unknown, event?: string): void => {
    out.push(`${event === undefined ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`);
  };
  const grow = (fragment: { id: number; type: string }, text: string): void => {
    const [first = '', ...rest] = text.match(/[\s\S]{1,16}/g) ?? [];
    emit({ p: 'response/fragments', o: 'APPEND', v: [{ ...fragment, content: first }] });
    rest.forEach((piece, i) => emit(i % 2 === 0 ? { v: piece } : { p: 'response/fragments/-1/content', o: 'APPEND', v: piece }));
  };
  emit({ request_message_id: 1, response_message_id: 2 }, 'ready');
  emit({
    v: {
      response: {
        message_id: 2,
        parent_id: 1,
        role: 'ASSISTANT',
        thinking_enabled: reply.thinking !== undefined,
        status: 'WIP',
        accumulated_token_usage: 0,
        files: [],
        fragments: [],
        has_pending_fragment: false,
      },
    },
  });
  if (reply.thinking !== undefined) {
    grow({ id: 1, type: 'THINK' }, reply.thinking);
    emit({ p: 'response/fragments/-1/elapsed_secs', o: 'SET', v: 1.5 });
  }
  grow({ id: 2, type: 'RESPONSE' }, reply.text);
  const status = reply.status ?? 'FINISHED';
  if (status !== 'WIP') {
    emit({
      p: 'response',
      o: 'BATCH',
      v: [
        { p: 'accumulated_token_usage', v: 42 },
        { p: 'quasi_status', v: status },
      ],
    });
    emit({ p: 'response/status', o: 'SET', v: status });
  }
  emit({ updated_at: 0 }, 'update_session');
  emit({ content: 'Mock chat' }, 'title');
  emit({ click_behavior: 'none', auto_resume: false }, 'close');
  return out.join('');
}

/** The reply as the page shows it: reasoning and answer in .ds-markdown blocks, code fences as code blocks. */
export function replyHtml(reply: { text: string; thinking?: string }): string {
  const thinking = reply.thinking === undefined ? '' : `<div class="ds-think-content"><div class="ds-markdown">${markdown(reply.thinking)}</div></div>`;
  return `${thinking}<div class="ds-markdown">${markdown(reply.text)}</div>`;
}

function markdown(text: string): string {
  return text
    .split(/(```[^\n]*\n[\s\S]*?\n```)/)
    .map((part) => {
      const fence = /^```([^\n]*)\n([\s\S]*?)\n```$/.exec(part);
      if (fence) {
        return (
          '<div class="md-code-block"><div class="md-code-block-banner-wrap"><div class="md-code-block-banner">' +
          `<div class="md-code-block-infostring">${escapeHtml(fence[1] ?? '')}</div>` +
          `<div role="button">Copia</div></div></div><pre>${escapeHtml(fence[2] ?? '')}</pre></div>`
        );
      }
      return part
        .split(/\n{2,}/)
        .filter((paragraph) => paragraph.trim() !== '')
        .map((paragraph) => `<p>${escapeHtml(paragraph.trim()).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</p>`)
        .join('');
    })
    .join('');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const SIGN_IN_PAGE = `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Mock sign-in</title></head>
<body><form><input type="email" aria-label="Email"><input type="password" aria-label="Password"><button type="button">Accedi</button></form></body></html>`;

const CHAT_PAGE = `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Mock chat</title></head>
<body>
<main id="chat"></main>
<div class="composer">
  <textarea id="chat-input" placeholder="Invia un messaggio a DeepSeek"></textarea>
  <div role="button" id="think" class="ds-button ds-toggle-button" aria-pressed="false"><span>DeepThink</span></div>
  <input type="file" id="picker" multiple style="display:none">
</div>
<script>
  const input = document.getElementById('chat-input');
  const think = document.getElementById('think');
  const picker = document.getElementById('picker');
  const chat = document.getElementById('chat');
  let ids = 0;
  let files = [];
  let uploading = false;
  think.addEventListener('click', () => {
    think.setAttribute('aria-pressed', String(think.getAttribute('aria-pressed') !== 'true'));
  });
  // Like the real page, a picked file uploads for a moment before a message can go.
  picker.addEventListener('change', () => {
    files = Array.from(picker.files).map((file) => file.name);
    uploading = true;
    setTimeout(() => { uploading = false; }, 1500);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    if (uploading || input.value.trim() === '') return;
    const prompt = input.value;
    input.value = '';
    send(prompt);
  });
  // Both message selectors match, one inside the other (.ds-message around
  // [data-message-id]): the adapter must count each message once.
  function message(className) {
    const outer = document.createElement('div');
    outer.className = 'ds-message';
    const inner = document.createElement('div');
    inner.dataset.messageId = String(++ids);
    inner.className = className;
    outer.append(inner);
    chat.append(outer);
    return inner;
  }
  async function send(prompt) {
    message('user').textContent = prompt;
    const sent = files;
    files = [];
    const response = await fetch('/api/v0/chat/completion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, files: sent, thinking_enabled: think.getAttribute('aria-pressed') === 'true' }),
    });
    const turn = response.headers.get('x-mock-turn');
    const reader = response.body.getReader();
    while (!(await reader.read()).done) {}
    const { html, notice } = await (await fetch('/mock/reply/' + turn)).json();
    if (notice !== '') {
      const toast = document.createElement('div');
      toast.setAttribute('role', 'alert');
      toast.textContent = notice;
      document.body.append(toast);
      setTimeout(() => toast.remove(), 4000);
    }
    if (html === '') return;
    message('reply').innerHTML = html;
  }
</script>
</body></html>`;
