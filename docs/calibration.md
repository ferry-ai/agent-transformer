# Calibrating the DeepSeek connector

The DeepSeek web adapter (`src/adapters/deepseek/`) reads replies from two places:
the completion stream (`stream.ts`) and the rendered page (`selectors.ts` plus
`src/browser/last-message.js`). Both were written from public userscripts, not from a
logged-in session. Calibration means capturing real replies, checking what the adapter
read against the browser window, and keeping sanitized copies as test fixtures.

## Status (2026-10-16)

**Nothing after the login is verified yet.** The live check could not run: the
persistent profile in `%LOCALAPPDATA%\Agent-Transformer\profiles\deepseek` is not logged
in. `npm run check` (2026-10-16) landed on `https://chat.deepseek.com/sign_in` (Italian
UI, title "DeepSeek - Verso l'Ignoto"), with no message box, no file input and no
verification shown. So no capture was made, `src/adapters/deepseek/fixtures/` holds no
fixture yet, and the fixture replays in the tests are skipped with a note.

What *is* verified, offline:

- The sign-in page is recognised from its URL, at once (live: `/sign_in`).
- The browser mechanics (stream capture, page fallback, uploads, the DeepThink toggle,
  new chat, notices, errors) against a **local mock** of the chat page
  (`src/adapters/deepseek/testing/mock-site.ts`). The mock copies the structure the
  adapter expects; it says nothing about the real site.
- The capture → sanitize → check → replay pipeline, end to end on the mock
  (`capture.ts --mock`, then `sanitize.ts --out <temp folder>`).

## What changed in this round

Adapter (`index.ts`):

- **Sign-in page fails fast.** Without a terminal (a script, `--task` with no TTY) the
  adapter no longer waits forever on the sign-in page or a verification: it fails at once
  with "log in with `npm run chat`". With a terminal it says so right away instead of
  after 10 s, then waits for the user. The `waitForUser` option overrides the default.
  `inspect()` (`npm run check`) never waits for a login.
- **Notices.** Toasts and alerts (`[role="alert"]`, `.ds-toast`) whose text matches the
  busy, limit or logged-out patterns end the wait with the matching error, both while
  sending and while waiting for the page.
- **Errors.** HTTP 429 is `busy`; HTTP 401, and bodies such as "Missing Token" or
  "Authorization Failed", say the session expired; other refusals are classified from
  their JSON body (`{code, msg}`, `{data: {biz_code, biz_msg}}`).
- **End of generation.** The stream's end is the end of the reply when its last status is
  `FINISHED` or `CONTENT_FILTER`. When it stops on `WIP` or `INCOMPLETE` (an automatic
  "continue"), the adapter waits for the page and keeps the page text if it goes beyond
  the stream. A finished stream the parser cannot read is completed from the page (up to
  10 s), not read after 500 ms.
- **Answer vs reasoning.** Stream: `THINK` fragments are the reasoning, `RESPONSE` the
  answer, `TEMPLATE_RESPONSE` the content filter's canned answer, which replaces what was
  streamed before it (`filtered: true`). Page: the last `.ds-markdown` block is the
  answer, earlier ones the reasoning; a short reply matching the filter texts is flagged.
- **Messages** are counted the way the page script counts them: the two message guesses
  (`[data-message-id]`, `.ds-message`) folded when nested.
- **DeepThink**: `setDeepThink(on)` clicks the toggle whose text is "DeepThink" and reads
  its state from ARIA or its class names.
- **Debug captures** keep the message HTML once it has been still for a second.
- **Headless** is refused on deepseek.com (only the mock page runs headless). The browser
  launch stops with a clear message when another browser holds the profile.

Stream parser (`stream.ts`): error envelopes, error `hint` events, `quasi_status`,
`endedEarly()`.

Tooling: `scripts/deepseek/capture.ts`, `sanitize.ts`, `check-fixtures.ts`; fixture
loading, sanitizing and rendering in `src/adapters/deepseek/testing/`; replays in
`stream.test.ts` and `src/browser/last-message.test.ts`; sanitizer tests and the leak
check of committed fixtures in `sanitize.test.ts`.

## Capture recipe

Every message lands in the account's DeepSeek history. The capture messages are fixed,
neutral and written for this purpose (`capture.ts --list`); send nothing else.

1. **Log in once, by hand.** `npm run chat`, log in in the browser window, `/quit`. The
   profile keeps the session. Nothing in this repository types credentials or solves a
   verification; if DeepSeek asks for one, complete it yourself or stop.
2. **Check.** `npm run check` must say `Message box: yes`. Close any other browser
   window that uses the profile first: only one browser at a time.
3. **Capture**, a few messages per run (each run opens and closes the browser):

       npx tsx scripts/deepseek/capture.ts --list
       npx tsx scripts/deepseek/capture.ts --only short,long,code,multi-code
       npx tsx scripts/deepseek/capture.ts --only tool,table-math,italian,special-chars
       npx tsx scripts/deepseek/capture.ts --only deepthink,new-chat,attachment

   Each run prints its session folder (under `%LOCALAPPDATA%\Agent-Transformer\sessions`)
   and one line per reply: where it was read from (`network` or `dom`), its length, the
   stream status. It stops at the first failure and never retries. While it runs, look
   at the browser window: the printed text must be what the page shows.
4. **Sanitize** each session into fixtures:

       npx tsx scripts/deepseek/sanitize.ts "<session folder>" --deny "<your name>,<your email>"

   Message, chat, session, user and file ids become placeholders (`1001`, `id-1`,
   `00000000-…-000000000001`), times become zero, tokens, emails and user folders are
   masked. If anything still looks private it writes nothing and lists it. The summary
   says, per reply, whether the page text matches the stream text.
5. **Check and review.** `npx tsx scripts/deepseek/check-fixtures.ts --deny "<…>"`, then
   read the `.json` files: `stream` is what the parser read, `page` what the page script
   read. Fix `stream.ts`, `selectors.ts` or `last-message.js` where they disagree with the
   browser window, and sanitize again.
6. `npm test` replays every fixture (`stream.test.ts`, `last-message.test.ts`) and checks
   them for leaks (`sanitize.test.ts`). Commit only the sanitized files in
   `src/adapters/deepseek/fixtures/`, never a session folder or anything from `profiles/`.
7. **One real agent task** on a fresh temp workspace, file tools only (commands are
   denied without a terminal):

       npm run agent -- --task "Create notes.md with a two-item list, then add a third item with edit_file." --workspace <empty temp folder>

`--mock` runs the capture on the local mock page, headless, in a temp data dir; its
sessions are labelled as mocks (an `origin` starting with `MOCK`), and `sanitize.ts` refuses to
write them into the fixtures folder, whatever `--out` says (the path is compared resolved,
without a trailing separator, case-insensitively on Windows and macOS). Should one get there
anyway, `check-fixtures.ts` and `npm test` fail on it. Use it to try the scripts, never as calibration.

## Recapturing

When DeepSeek changes its page, `npm run check` and the capture summary show it first
(`dom` instead of `network`, `page DIFFERS`, an `empty` or `timeout` error). Run the
recipe again for the affected messages: `sanitize.ts` overwrites fixtures of the same
name, and the tests then show what the parser or the page script now reads differently.
Update the selectors or the parser, then the fixtures, in the same commit.

## Still unverified or flaky

Everything below is a guess until a logged-in capture confirms it:

- **Message box**: `textarea#chat-input` or a placeholder containing "DeepSeek",
  "essage", "essaggio" or "消息" (any textarea as a last resort).
- **Messages and Markdown**: `[data-message-id]` / `.ds-message`, `.ds-markdown`; which
  block is reasoning when DeepThink is on; code-block banners and copy buttons left out.
- **Stream**: the endpoint `/api/v0/chat/completion`, the fragments format, the statuses
  (`WIP`, `FINISHED`, `INCOMPLETE`, `CONTENT_FILTER`), the automatic "continue". If the
  endpoint moved, every reply falls back to the page after a 30 s wait for the stream.
- **DeepThink toggle**: the label "DeepThink" in the Italian UI and how its state shows.
  When the state cannot be read, the capture clicks once and may leave it on.
- **Attachments**: the hidden `input[type="file"]`, and that Enter is refused while the
  upload runs (the adapter retries Enter for up to 120 s).
- **New chat**: reloading `https://chat.deepseek.com/` is assumed to open a new chat.
- **Notices and errors**: the texts (English, Italian, Chinese) for busy, rate limit,
  length limit, logged out and the content filter; the toast selector. These are not
  provoked on purpose: they stay tolerant guesses until one shows up in a capture.
- **Verification**: detected only as a captcha/challenge iframe.
- **Timing**: the page fallback waits until the text has been still for 5 s, which can
  cut a reply that pauses longer (long reasoning) and adds 5 s when the stream is not
  understood.
- **Locked profile on Windows**: a second Chrome on a profile in use hands it over and
  exits, which Playwright reports as a closed browser, not as a lock.
