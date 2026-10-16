# Task state and context outside the chat

A web chat is a poor place to keep a task. Its context is limited, every tool result
is pasted into it, and when the conversation ends (too long, a crash, a new chat) the
plan goes with it. So the orchestrator (`src/agent`) keeps the task outside the chat:

- a **task state** saved in the session folder, so a task can be resumed;
- a **budget** per conversation, with long tool results cut down to summaries
  (their full text attached as a file);
- a **rollover**: when the budget runs out or the model drifts off the protocol, a
  new chat takes over with an envelope of the state;
- a **read-before-edit gate** on `edit_file`.

All of it is on by default. `new Agent({ ..., context: false })` turns it all off and
gives back the loop as it was before. `context: { ... }` changes the settings (see
[Settings](#settings)).

Nothing here changes the safety model. Every workspace tool call still goes through
the toolbox, the path policy and the approvals exactly as before. The only tool the
agent adds, `update_task`, touches the task state in memory and nothing else.

## The state file

`task-state.json`, in the session folder next to `transcript.jsonl`:

    <data-dir>/sessions/<date>-<adapter>/task-state.json

It is written when a task starts, after every reply and when the task ends: first to
a temporary file, then renamed over the old one (on Windows, where a sync client or
an antivirus can hold the file, it is overwritten directly). The folder is 0700 and
the file 0600, like the transcript. A failed save is logged once
(`state_save_failed`) and never stops the task.

| Field | What it holds |
| --- | --- |
| `version` | 1 |
| `goal` | the task as the user wrote it (at most 20 000 characters) |
| `root` | the workspace, as an absolute path |
| `status` | `running` while the task runs, then `done`, `max_iterations`, `timeout`, `filtered`, `aborted` or `failed`. `running` in a saved file means the agent died mid-task. |
| `startedAt`, `updatedAt` | ISO times |
| `iterations`, `toolCalls` | replies and tool calls over every run of the task |
| `runs` | 1, plus one per resume |
| `chats` | conversations the task has used, over every run |
| `rollovers` | `{reason, at, chat, chars}` for each rollover (the last 50) |
| `checklist` | `{text, done}` steps written by the model with `update_task` (40 steps, 300 characters each) |
| `decisions` | lines written by the model with `update_task` (the last 20, 400 characters each) |
| `files.read`, `files.changed` | workspace paths, `/` separators, most recent last (200 each) |
| `recent` | the last 8 calls: `{reply, call, ok, result}`, where `call` is one line (`run_command npm test`) and `result` the first and last lines of the output (300 characters). Calls of a reply that never ran are listed too, with `ok: false` and `Not run: …`: those left when the task stopped (a limit, or the user stopping it mid-reply) and those held back behind a malformed block. |
| `answer` | the last reply, the final answer once `done` (4 000 characters) |
| `resumedFrom` | the `task-state.json` this run was resumed from |

Only the native file tools feed `files`: `read_file` fills `read`, `write_file` and
`edit_file` fill `changed`. What a shell command or an MCP tool reads or changes is
not tracked; it shows up in `recent` only.

A session folder holds the state of its **last task**: a new task in the same session
replaces the file. The transcript keeps every task.

### update_task

The orchestrator can count calls and files, but only the model knows its plan. The
agent offers it one more tool, `update_task`, with a rule in the instructions ("Keep
your plan current with update_task..."):

    ```tool
    {"tool": "update_task", "args": {"decision": "Use pytest, not unittest"}}
    - [x] Read app.py
    - [ ] Change greet()
    - [ ] Run the tests
    ```

The text after the JSON line replaces the whole checklist (`- [ ]`, `- [x]`, plain
lines and numbered lines are all read). `decision` adds one line. The tool goes
through a `Toolbox` of its own, so its arguments are checked like any other call's;
it needs no approval because it never touches the workspace. It is not offered when
the toolbox already has a tool with that name, or with `taskTool: false`.

### Resuming

From the agent prompt:

    /resume              the most recently updated task-state.json under <data-dir>/sessions
                         whose task ran in this workspace (the data dir is shared)
    /resume <folder>     the one in that session folder (or a task-state.json path)

From a script:

    const { state, file } = await loadTaskState(folderOrFile);   // or findLatestTaskState(sessionsDir, workspace)
    const result = await agent.resume(state, signal, file);

A resume always runs in a **new chat** (a fresh agent is already on one; an agent that
has talked opens a new one first). Its first message is the envelope below, with
reason `resume`. The limits (`--max-iterations`, `--max-minutes`) start over for the
run; `iterations` in the state keeps counting. The new run saves its state in the
**current** session folder and sets `resumedFrom`.

A state from disk is checked before it is used: an unknown version or status, a
missing goal or wrongly typed fields are refused, and the model-written parts are
capped again. A task is resumed only in the workspace it ran in: anywhere else
`resume()` throws (`That task ran in ..., resume it with --workspace ...`). A task
that ended `done` can be resumed too, to go on with it.

## The budget

Each conversation has a budget in **characters** (a stand-in for tokens: the agent has
no tokenizer for the web model). What counts: every message sent, every attached file,
every reply text. Reasoning shown apart (`thinking`) does not count. A reply that
could not be read and was asked again counts its message too.

Before each message, in a conversation that already holds at least one exchange, the
agent checks:

    used + next message + its attachments + replyReserveChars > budgetChars

and when that is true it rolls over before sending (reason `budget`). The first
message of a conversation is never checked, so a conversation always gets at least
one exchange.

After every exchange the agent emits a `budget` event (`{chat, used, limit}`), and the
transcript's turn records carry `chat` (the agent's conversation number) and
`contextChars` (how full it is).

### Long results

A tool result longer than `inlineResultChars` (6 000; `inlineReadChars`, 16 000, for
`read_file`, whose text the model needs as it is) is replaced in the message by a
summary of about that size:

    <the first 40 %>
    [… 812 lines, 41 230 characters left out …]
    [lines from the part left out that mention errors:]
    FAIL src/app.test.ts > greets
    AssertionError: expected 'hi' to be 'hello'
    [end of those lines]
    <the last 40 %>

The middle lines that mention errors (`error`, `fail`, `exception`, `traceback`,
`assert…`, `fatal`, `warning`, `panic`) fill the last 20 %. Test runners and compilers
put what matters at either end, or flag it.

**Attachments.** With a session folder, the full text is saved as
`<session>/attachments/result-0001-<tool>.txt` and sent with the message as an
attachment (`ChatAdapter.send(..., { attachments })`), and the summary says so:

    [The full result (812 lines, 48 000 characters) is attached as result-0001-run_command.txt. Only its start, its end and the lines that mention errors are shown here.]

Attachments live in the session folder, inside the data dir, never in the workspace
(the file tools refuse the data dir). They hold exactly the text that would have gone
inline, after the tools' own redaction, and they go to the provider like any other
message. They count against the budget in full: they keep the visible message short,
not the conversation.

- One message attaches at most a quarter of the budget; long results past that stay
  summaries.
- Without a session folder (no transcript), or with `largeResults: 'summary'`, there
  are no attachments: the summary ends with
  `[N characters were left out to keep this chat short. ...]` and a hint (read in
  slices, filter the command output).
- If a message with attachments fails with `send_failed`, or with an error that is not
  an `AdapterError` (an adapter whose upload throws), the same message is sent again
  with summaries only, and attachments stay off for the rest of the agent's life
  (`attachments_off` event).
- The toolbox already cuts every result at 20 000 characters (`maxResultChars`) before
  the agent sees it, so an attachment holds at most that much.

**One message as a whole.** Each result is capped on its own, and the results of one
message are capped together too: all of them, attachments included, fit in a third of
`budgetChars - replyReserveChars` (64 000 characters by default). They are taken in
order. A result that does not fit in what is left first loses its attachment, then is
cut to a 500-character summary, then to its first and last lines. That last form is
always sent, whatever the room, so the model still sees every call it made. Its note
says `[N characters were left out because this message was full. To see them, send
this call again on its own, or ask for less at a time.]`. Since one results message
never takes more than a third of the budget, a conversation always holds more than one
reply.

Each summarized result emits `summarized` (`{index, tool, chars, kept, attachment?,
full?}`, where `full` means it was cut because the message was full) and logs
`result_summarized`.

## Rollover

A rollover opens a new chat (`adapter.newChat()`) and sends the **envelope** as its
first message. Three reasons:

| Reason | When |
| --- | --- |
| `budget` | the next message would not fit (above) |
| `drift` | `rolloverAfterDrift` (2) replies in a row with no valid tool call (see [Drift](#drift)) |
| `limit` | the provider answered with an `AdapterError` of kind `limit` (the chat is full). Only once per conversation: a `limit` on a conversation's first message fails the task, since it is a usage limit, not a long chat. |

When the task has not had a reply yet (a new task whose first message lands in a full
chat), the new chat simply gets the normal first message.

### The envelope

The "busta" of the README, in four parts:

1. **The instructions**: the whole protocol and the tool list, as in a first message,
   with "at most N replies" set to the replies left in this run.
2. **The task**: the goal, as the user wrote it, cut to a tenth of the budget (at
   least 1 000 characters; 20 000 by default) with a note saying so.
3. **The task state**, why the chat changed, and the state as JSON:

       ```json
       {
         "replies_used": 12,
         "replies_left": 18,
         "checklist": ["[x] Read app.py", "[ ] Change greet()"],
         "decisions": ["Use pytest, not unittest"],
         "files_read": ["app.py"],
         "files_changed": [],
         "recent_calls": [{"reply": 12, "call": "run_command pytest", "ok": false, "result": "... / 1 failed"}]
       }
       ```

   followed, when files were read or changed, by "read a file again before you edit
   it". The file lists carry the last 30 paths each.
4. **The last results**: the results message the old chat was about to get (with its
   summaries and attachments), or, on a resume, a line that points to `recent_calls`.

Nothing else of the old chat comes along: no earlier replies, no earlier results. The
model is told to trust the state over what it remembers.

**Its size.** The whole envelope fits in half of `budgetChars - replyReserveChars`: the
last results are fitted (as above) in what the first three parts leave of that half.
With a results message capped at a third, the new chat then has room for the reply to
the envelope and the next results message, so it does not roll over again at once.
Each result cut further for the envelope emits `summarized` again.

Each rollover emits `rollover` (`{reason, chat, used, limit}`), logs a `rollover` event
in the transcript and adds a record to `rollovers` in the state.

## Drift

The model has drifted when a reply holds tool blocks but **no valid call**: every block
is malformed, or every call names an unknown tool. It has also drifted when a reply has
**no tool block** but tries to call a tool anyway, which used to end the task as if it
were the final answer:

- a line that starts with `{` and names a known tool (`"tool"`, `"name"` or
  `"tool_name"`), outside any fence or in an untagged or `json` fence;
- a native function-calling tag (`<tool_call>`, `<function_calls>`, `<invoke>`, or
  DeepSeek's `<｜tool▁calls▁begin｜>` tokens) outside a code block (untagged and
  `json` blocks count as outside).

Prose that only names a tool is not drift. Nothing is run for such a reply; the model
is told what was found and how a call is written. Each drifting reply emits `drift`
(`{count, detail}`). After `rolloverAfterDrift` (2) in a row, a new chat takes over;
after `maxMalformedReplies` (3) in a row, counted across the rollover, the task fails
as before.

A reply **cut off inside a tool block** (the block never closes: the provider stopped
the reply) is not drift: the model followed the protocol. Its block is reported as
malformed, with a hint to send long text in parts, but it emits no `drift` and never
starts a new chat: that would not make the next reply shorter, its envelope would blame
the protocol, and the read-before-edit gate would refuse the edits the model was
writing. It still counts toward `maxMalformedReplies`; when the last of those replies
was cut off, the error says so.

## Read before edit

`edit_file` on a file that was not read with `read_file` (or written with
`write_file` / `edit_file`) **in the current conversation** is refused before it
reaches the toolbox:

    Not run: app.py was not read in this conversation, and edit_file needs its exact
    current text. Call read_file on it first, then send the edit again.

The list starts empty in every new chat (a rollover, a resume, `/new`), since the
model has lost the text it read. Paths are resolved against the workspace as the path
policy resolves them (`./a.py`, `a.py` and absolute paths in the workspace are the
same file; nothing is trimmed, so `" a.py"` is another file; a backslash separates
folders on Windows only), and compared ignoring case on Windows and macOS. The
refusal emits `gated`, logs a `tool_call` with `gated: true`, and is not counted as
a tool call. It is a guard against stale edits, not a security boundary: it only ever
refuses more. It applies to the native `edit_file` only; `write_file` and MCP tools
are not gated. `readBeforeEdit: false` turns it off.

## Events and transcript entries

For scripts (the reliability spike) the decisions show up in `onEvent` and in the
transcript (`Recorder`):

| `onEvent` | Transcript | When |
| --- | --- | --- |
| `budget` | `chat`, `contextChars` on each turn | after every exchange |
| `summarized` | `result_summarized` | a long result was summarized |
| `attachments_off` | `attachments_off` | an upload failed; summaries only from now on |
| `rollover` | `rollover` | a new chat took over |
| `drift` | `drift` | a reply with no valid call |
| `gated` | `tool_call` with `gated: true` | an edit was refused by the gate |
| `resume` | `resume` | a saved task starts again |
| | `attachment_failed` | the full text could not be saved (the summary goes alone) |
| | `state_save_failed` | the state file could not be written (logged once) |

`agent.state` is the state of the running (or last) task, and `agent.conversation`
gives `{number, usedChars, exchanges}` of the chat in use.

## Settings

`new Agent({ ..., context: { ... } })`; each field is optional.

| Setting | Default | |
| --- | --- | --- |
| `budgetChars` | 200 000 | characters one conversation may hold |
| `replyReserveChars` | 8 000 | room kept for the next reply |
| `inlineResultChars` | 6 000 | longer results are summarized |
| `inlineReadChars` | 16 000 | the same for `read_file` |
| `largeResults` | `'attach'` | or `'summary'`: no attachments |
| `rolloverAfterDrift` | 2 | drifting replies in a row before a new chat |
| `readBeforeEdit` | true | the gate on `edit_file` |
| `taskTool` | true | offer `update_task` |
| `dir` | the transcript's folder | where `task-state.json` and `attachments/` go |

The CLI uses the defaults. There are no command-line flags for them yet (`src/cli.ts`
belongs to another change); the obvious ones would be `--context-budget <chars>`,
`--large-results attach|summary`, `--no-edit-gate` and `--resume [folder]` for
`--task` mode.

## Limits

- **Characters are not tokens.** 200 000 characters (very roughly 50 000 to 70 000
  tokens of code and English) is a guess meant to stay well inside the context of a
  web chat model; other scripts and languages tokenize differently. None of the
  defaults has been measured on a live chat.
- **Attachments are not verified on DeepSeek.** The adapter uploads them through the
  page's file input; whether the model reads a `.txt` attachment in full, and how much
  context it takes, still has to be checked live. If the upload throws, the agent
  falls back to summaries; if it "succeeds" without the model seeing the file, the
  model still has the summary.
- **The size bounds hold for sane settings only.** The envelope fits its half of the
  budget when the instructions (mostly the tool list) and the task state take less
  than that: true by far with the defaults (a few thousand characters for the native
  tools against 96 000), not with a budget set below a long MCP tool list. And a reply
  with very many calls still sends one short line per call. In those cases the
  envelope (or a results message) is sent over the budget, and the next message rolls
  over again: a new chat per reply, bounded by `--max-iterations`. A reply longer than
  about a sixth of the budget can also make the chat after an envelope roll over after
  one reply.
- **What the state does not know**: files changed by commands or MCP tools, anything
  the model learned that it did not write into `update_task`, and the reasoning of
  earlier replies.
- **Drift detection is a heuristic.** A final answer that shows a JSON tool call on a
  line of its own, or a function-calling tag outside a code block, is taken for a
  call: the model is asked again, and three such replies in a row fail the task.
- **One state per session folder**, the last task's: an older task of the same
  session cannot be resumed.
- **A provider `limit`** that is a usage limit, not a full chat, costs one new chat
  before the task fails.
