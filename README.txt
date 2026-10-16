Web-Chat Agent Bridge (Concept & Work in Progress)Stato del progetto: Concept e analisi architetturale preliminare (Ottobre 2026).   Le soluzioni descritte in questo documento rappresentano ipotesi progettuali in fase di esplorazione, da validare progressivamente tramite prototipi e spike tecnici.   🎯 Idea di baseL'obiettivo del progetto è costruire un'interfaccia locale (CLI/TUI o applicazione leggera) che offra l'esperienza d'uso di un agente di coding nativo, utilizzando però come "cervello" una normale chat web in abbonamento (come Gemini o DeepSeek) eseguita dietro le quinte.   Spesso i modelli più avanzati sono già inclusi negli abbonamenti consumer, ma restano chiusi dentro una pagina web dove non possono leggere file, eseguire test o interagire con il sistema operativo. Questo progetto esplora la possibilità di creare un ponte (bridge) in cui il modello pianifica e decide nella chat web, mentre un esecutore deterministico locale applica le azioni sul computer in modo controllato.   🧩 Architettura concettualeL'ipotesi architetturale divide il sistema in moduli indipendenti per non legare la logica dell'agente a una singola piattaforma web:   Interfaccia Utente (CLI / TUI / Local UI): Il punto di contatto con l'utente, dove inviare le richieste, seguire i progressi del task, ispezionare i diff del codice e approvare le azioni sensibili.   Orchestratore Locale: Gestisce il ciclo dell'agente, mantiene lo stato del task e il piano d'azione fuori dalla chat web, valida il formato delle risposte e gestisce eventuali retry o reiniezioni delle istruzioni.   Adapter Browser: Il livello di comunicazione che pilota la pagina web in background (da testare tramite Playwright con profilo persistente, protocollo CDP o estensione browser leggera), occupandosi di inviare i prompt, caricare file allegati e leggere le risposte.   Esecutore Deterministico & Client MCP: Uno script locale che traduce le richieste JSON del modello in operazioni reali sul filesystem o sul terminale, con la possibilità di collegarsi a server MCP esistenti per estendere gli strumenti senza riscriverli da zero.   Workspace Sandbox: L'ambiente confinato (cartella di progetto o container) dentro cui avvengono le modifiche, protetto da checkpoint Git automatici.   💡 Meccanismi in fase di esplorazioneQueste sono le direzioni tecniche principali che il progetto intende sperimentare per superare i limiti dei tool attuali:   Contratto JSON e filtraggio dinamico dei tool:
Invece di esporre decine di strumenti contemporaneamente rischiando allucinazioni, l'orchestratore può inviare alla chat web una "busta" JSON contenente lo stato compatto del task e solo il sottoinsieme di tool pertinenti per quel singolo turno operativo. Il routing può essere gestito a costo zero in locale (ad esempio tramite una macchina a stati finiti che sblocca i tool di modifica solo dopo la lettura dei file, o con un piccolo router semantico su CPU) senza dipendere da API esterne a pagamento.   Esecuzione ibrida con Rollback immediato (undo):
Le operazioni di sola lettura (list_dir, read_file, search) vengono eseguite liberamente per velocizzare il flusso. Quando invece il modello richiede un'azione che modifica lo stato (edit, write_file), lo script locale crea prima un checkpoint Git automatico, applica la modifica e restituisce al modello il risultato insieme a un tool temporaneo di annullamento (undo_last_action), permettendo sia all'agente sia all'utente di fare rollback istantaneo se il diff o i linter segnalano un errore.   Multimodalità reale (Allegati e Ciclo Visivo):
A differenza delle soluzioni che incollano tutto come testo, l'idea è sfruttare programmaticamente il vero input di upload file della chat web (attach e screenshot). Questo permetterebbe sia di inviare output e log molto lunghi come file allegati senza intasare il contesto testuale, sia di creare un ciclo visivo in cui l'agente cattura lo screenshot di un'interfaccia o di un'app appena generata e lo ricarica nella chat per correggere bug grafici.   Proposta dinamica di nuovi Tool (Human-in-the-Loop):Un'espansione sperimentale prevede di fornire al modello un meta-tool (propose_tool) con cui suggerire la creazione di uno strumento personalizzato o di una macro specifica per il repository in uso. La proposta mette in pausa l'esecuzione e mostra il codice dello script all'utente nell'interfaccia, richiedendo un'approvazione esplicita prima di registrare il nuovo tool nella sandbox.Isolamento e Sicurezza a livelli:
Poiché l'agente interagisce con il disco e con una shell dotata di allowlist, la sicurezza non può basarsi solo sulla cartella di lavoro. Si valuteranno approcci progressivi: dalla validazione rigorosa dei path per i comandi nativi sui file, all'uso dei permessi nativi del runtime (es. flag --permission di Node/Deno) per eventuali script custom, fino all'isolamento completo dei comandi di shell dentro un container Docker.   ⚠️ Sfide aperte e Punti da verificarePrima di consolidare il codice in uno strumento definitivo, ci sono diversi aspetti critici da mettere alla prova:   Stabilità del DOM e blocchi anti-bot: Le interfacce web cambiano spesso e possono bloccare i browser automatizzati; andrà verificata sul campo la differenza di affidabilità tra Playwright headless, connessione a un browser reale e WebExtension locale.   Rilevamento di fine generazione e pulizia del contesto: Capire con certezza quando lo stream della risposta è terminato e impedire che eventuali chiamate JSON malformate inquinino la cronologia della chat richiederà parser tolleranti e strategie di retry mirate.   Termini di Servizio (ToS): L'automazione delle interfacce web consumer può scontrarsi con i termini dei provider. Per questo l'architettura punta a tenere l'Adapter completamente separato dall'Orchestratore, così da poter affiancare in qualsiasi momento una modalità copia-incolla assistita conforme o un backend basato su API ufficiali.   🗺️ Primi passi (Roadmap esplorativa)Spike di fattibilità: Testare in isolamento la connessione con la pagina web (invio prompt, attesa fine risposta, estrazione blocco JSON e caricamento di un file allegato) per verificare che regga almeno 20 cicli consecutivi senza errori.   Core MVP: Costruire il loop minimale dell'orchestratore con i tool base per i file (list_dir, read_file, write_file, edit) e i checkpoint Git automatici su un piccolo repository di prova.   Livello di affidabilità e Multimodalità: Introdurre la validazione dello schema con autocorrezione, la gestione esterna dello stato e il ciclo di upload immagini/screenshot.   Sandbox avanzata ed Estensibilità: Aggiungere l'esecuzione protetta dei comandi di shell (run), il supporto come client MCP e il sistema di proposta per i tool personalizzati.   

## Terms of Service

**Unofficial project.** Agent-Transformer is not affiliated with any AI provider,
and it does not encourage anyone to violate a provider's Terms of Service.

**Web adapters.** Web adapters drive a chat website through a real browser, using
your own account. Most providers forbid automated use of their consumer chat apps
and may suspend accounts that do it. Check the terms of each service, use a
dedicated account, and prefer the official API backends when you can. You are
responsible for how you use this tool.

**What it will never do:** bypass captchas, solve anti-bot challenges, or disguise
the automated browser. If a site asks for verification, Agent-Transformer stops
and hands control back to you.

**Clipboard mode is the compliant path.** With `--adapter clipboard` (see Clipboard
mode), no website is automated: Agent-Transformer opens no browser and never writes
to or reads from a chat page. It prepares each prompt and reads back the reply you
copied. You do every interaction with the chat yourself: paste, send, copy. This is
the split aider uses for its copy/paste mode. What you paste is still sent to the
provider, under its terms and privacy policy.

## Agent mode

    npm run agent                                   # tasks typed at the prompt
    npm run agent -- --task "Fix the failing test"  # one task, then exit
    npm run agent -- --adapter clipboard            # any chat, by copy and paste

The agent works in `--workspace` (default: the current folder). The model asks for
tools by writing fenced blocks tagged `tool`: a JSON line with the name and the
arguments, then any long text (file contents, commands) as is, with no escaping.

    ```tool
    {"tool": "write_file", "args": {"path": "hello.py"}}
    print("hello")
    ```

The results go back to the chat in the next message. A reply without tool blocks is
the final answer. Native tools: `read_file`, `write_file`, `edit_file`
(SEARCH/REPLACE blocks), `list_dir`, `run_command`. File tools cannot leave the
workspace; every shell command waits for your approval (`--confirm-writes` asks
before writes too), and runs in a sandbox container when Docker or Podman is
available (see Safety). Each task stops after `--max-iterations` replies (30) or
`--max-minutes` (30). `/undo` puts the workspace back as it was before the last
change; `/checkpoints` lists the snapshots; `/mcp` lists the MCP servers.

**MCP servers** come from `--mcp <file>` or `<data-dir>/mcp.json`, in the usual
`mcpServers` format. Their tools appear as `server.tool` and ask for approval unless
listed in `autoApprove`:

    { "mcpServers": {
        "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
                "autoApprove": ["read_file", "list_directory"] },
        "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } } } }

**Without a browser:** `--replay script.json` answers with scripted replies (a JSON
list of strings, or `{"error": "busy"}` to simulate a failure), to try the loop
offline.

Everything the agent reads, files and command output included, is sent to the chat
provider: do not use it on code or data you cannot share.

## Clipboard mode

    npm run agent -- --adapter clipboard
    npm run agent -- --adapter clipboard --task "Fix the failing test"

Agent mode without browser automation. The agent prepares each message; you carry
it to a chat and bring the reply back. It works with any chat you can open
(DeepSeek, ChatGPT, Gemini, Claude...), in your usual browser and account.

1. Open the chat in your browser.
2. Type a task at `task>`. The agent prints the prompt and copies it to the
   clipboard. It sits between `[[agent-transformer prompt N begin]]` and
   `[[agent-transformer prompt N end]]`, and the first prompt of a conversation
   carries the instructions and the list of tools.
3. Paste it into the chat and send it. The agent says when the prompt goes into a
   new conversation: the first one, and after `/new`.
4. When the reply is complete, copy all of it (the copy button under the reply is
   the easiest way) and press Enter at `reply N>`. The agent reads the clipboard,
   runs the tool calls and prints the next prompt.
5. Repeat until the model replies without tool calls: that is the final answer.

Each prompt asks the model to end its reply with the line `[[end of reply N]]`.
Before a reply reaches the agent it is checked, and you are asked again when:

- the clipboard still holds the prompt (Enter pressed before copying the reply), or
  the text begins with a prompt's begin line (your own message copied by mistake);
- the end line is missing or a code block is left open: the reply was cut off, still
  being written, or copied only in part;
- the end line has another number: it is the reply to an older prompt.

Copy the reply again and press Enter. If the model only forgot its end line,
`/accept` passes the refused reply on as it is. At `reply N>`:

    Enter     read the reply from the clipboard
    /copy     copy the prompt to the clipboard again
    /accept   pass on the last refused reply, as it is
    Ctrl+C    stop the task

**Without a clipboard**, or when the clipboard tool fails, copy the prompt from the
terminal, from its begin line to its end line, and paste the reply into the terminal
instead of pressing Enter. A pasted reply ends at its `[[end of reply N]]` line; if
it has none, type `[[end]]` on a line of its own after it. What is pasted after the
end line is dropped, so it cannot answer an approval prompt.

**Clipboard tools.** Windows: PowerShell (`Get-Clipboard`, `Set-Clipboard`; the text
crosses the pipes as UTF-8). macOS: `pbcopy` and `pbpaste`. Linux: `wl-copy` and
`wl-paste` on Wayland, else `xclip` or `xsel`; under WSL without them, the Windows
clipboard through `powershell.exe`. Nothing else is installed or needed.

**Files.** Nothing is uploaded. When a message needs files, the agent lists their
full paths: attach them yourself with the chat's attach button.

**The rest is unchanged.** Tools, approvals, the sandbox and checkpoints work as in
the other modes: every command asks at the terminal, and without a terminal it is
denied. Since you take part in every turn, `--max-minutes` defaults to 120 here.
`--replay` and the plain chat (`npm run chat`) do not take `--adapter clipboard`.

The prompts carry what the agent read. Clipboard history and cloud clipboard sync
(Windows `Win+V`, clipboard managers) keep a copy of them too.

## Safety

### Threat model

- **The model is untrusted.** It reads files, command output and MCP results, so any
  tool call may come from a prompt injection. Every rule below is enforced by the
  local runner, in code. Nothing relies on the instructions sent to the chat.
- **MCP servers** are your choice, but their tool descriptions and results are
  untrusted text.
- **Everything the agent reads is sent to the chat provider**: reading a secret is
  already a leak.
- **You are trusted, but your attention is limited.** An approval prompt shows
  exactly what will happen, and nothing the model writes can change how it looks.
- **Fail closed.** When something cannot be checked (no terminal for an approval, no
  sandbox where one was asked for), the answer is no. The agent never falls back
  quietly to a less safe mode.

### What is enforced in every mode

- **Approvals.** Every shell command asks, and so does every MCP tool that is not in
  your `autoApprove`. Without a terminal (stdin and stdout must both be a TTY) or once
  stdin is closed, the answer is no. A piped `y` does not count.
- **The approval prompt** shows the whole command or the full MCP arguments behind a
  `│` gutter, says where the command runs (`[sandbox: docker, network off]` or
  `[HOST, not sandboxed]`), and warns about invisible characters. It also adds
  advisory hints (`rm -rf`, `sudo`, `curl | sh`...). Hints are a pattern match, easy
  to get around: they never replace the sandbox.
- **The terminal.** Text from the model, commands and MCP servers is sanitized before
  it is printed. Control characters, escape sequences, `\r`, bidi controls and
  zero-width characters show as `\x1b`, `\r`, `\u{202e}`.
- **Files.** The file tools stay inside the workspace, links resolved. Paths with a
  `.git` segment are refused, in any spelling (case, trailing dots, `git~1`, `:stream`,
  ignored Unicode). So is the data dir, even when it lies inside the workspace. The
  agent asks before reading likely secrets (`.env*`, `*.pem`, `*.key`, `id_rsa*`,
  `.npmrc`, `credentials*`...), and before writing files that run code by themselves
  (`.envrc`, `.husky/`, `.vscode/`, `.github/workflows/`, `.npmrc`...) or files with
  other hard links.
- **The workspace** cannot be `/`, your home folder, a folder that contains it, or a
  folder inside the data dir.
- **Environment.** Commands on the host get only `PATH`, `HOME`, `USER`, `SHELL`,
  `TERM`, `LOGNAME` and the locale (`LANG`, `LC_*`, `TZ`), plus each `--pass-env NAME`.
- **Leftovers.** What commands leave running is killed when the agent exits, crashes,
  or gets SIGINT, SIGTERM or SIGHUP.
- **Checkpoints.** Before every change, the workspace is snapshotted into a shadow git
  repository in the data dir; your own `.git` is never touched. `/undo` shows what it
  will restore and remove, then asks.
- **MCP.** At startup the agent lists every server, its tools and the ones that run
  without asking. It pins a hash of the tool definitions: when they change, every
  call to that server asks until you accept them (`/mcp accept <server>`). The
  server's annotations never decide approval.
- **Data at rest.** The data dir, profiles, sessions and checkpoints are 0700
  folders with 0600 files.
- **Redaction.** Private keys and AWS, GitHub and Slack tokens are masked in command
  and MCP output. A masked text can never be written back over the original. This is
  a safety net, not a guarantee.

### Sandbox modes

    --sandbox auto     (default) Docker, else Podman, else the host with a warning
                       at startup and in every approval prompt
    --sandbox docker   Docker, or an error at startup
    --sandbox podman   Podman, or an error at startup
    --sandbox none     the host, by choice
    --sandbox-image    default docker.io/library/node:24-bookworm; never pulled
                       without asking
    --sandbox-network  give the container network access (default: none)

In a container, one per session, created at the first command and removed at exit:

- Only the workspace is mounted, at `/workspace` (the working directory). Its `.git`
  is read-only, and a data dir inside the workspace is hidden. There is no home, no
  Docker socket, no SSH agent and no host environment.
- `--network none` (unless `--sandbox-network`), all capabilities dropped,
  no-new-privileges, a read-only root with tmpfs for `/tmp` and `HOME`, limits of
  512 processes, 2 GB of memory and 2 CPUs.
- On Linux the container runs as your uid:gid, so the files it writes stay yours
  (Podman: `--userns=keep-id`).
- A timeout or Ctrl+C kills the command inside the container. Containers left by a
  crashed session are removed at the next start.
- The image needs `/bin/sh`. It also needs `setsid -w` (util-linux) for a clean
  kill; without it, stopping a command restarts the container.

**What the container protects:** the rest of your machine. A command cannot read
your home, your SSH keys, your cloud credentials or your other projects. It cannot
reach the Docker socket or your environment variables, and it cannot reach the
network unless you allow it.

**What it does not protect:**

- **The workspace itself.** A command can read and change every file in it (except
  `.git`), `.env` included, and its output goes to the chat. Checkpoints and `/undo`
  help you recover.
- **Files that run later on your machine.** A command can change `package.json`
  scripts, a `Makefile`, `.envrc`, `.vscode/`, or the hooks of a nested repository.
  It can also create a `.git` where there was none (the agent warns). Check them
  before running them outside the sandbox.
- **Exfiltration over the network**, when you pass `--sandbox-network`.
- **Bugs in the kernel or in the container runtime.** A rootful Docker daemon runs
  as root.
- **What is outside the sandbox anyway.** The file tools run on the host, but the
  path policy guards them. Local (stdio) MCP servers run on the host with your
  permissions. The browser runs there too.

**Host mode** (`--sandbox none`, or `auto` without Docker or Podman) keeps
everything listed above under "every mode". But a command you approve runs with your
permissions: it can read any file you can, use the network, and start a daemon that
leaves its process group. Only your approval stands in the way.

### Platform notes

The process groups, the uid:gid mapping, the file modes and the check of an opened
file through `/proc/self/fd` are POSIX or Linux features. On Windows:

- commands get no process group, and taskkill cannot find what an exited shell left
  behind;
- file modes are ignored (the data dir is under `%LOCALAPPDATA%`, which only you can
  open);
- an opened file is checked by path and file id instead of `/proc`.

On macOS and Windows a process racing links during a file operation is caught by a
second path check, which is weaker than the Linux one. A SIGKILL of the agent cannot
be caught: the next start removes its containers, but host processes survive.
