import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';

/**
 * The system clipboard, through the command-line tools of each OS: no dependency.
 *
 *   Windows       PowerShell Get-Clipboard / Set-Clipboard, text passed as UTF-8 bytes
 *   macOS         pbcopy / pbpaste, with a UTF-8 locale
 *   Linux, BSD    wl-copy / wl-paste on Wayland, else xclip or xsel on X11;
 *                 under WSL without them, the Windows clipboard through powershell.exe
 */
export interface Clipboard {
  /** The tools behind it, for messages: "PowerShell", "pbcopy/pbpaste", "xclip"... */
  readonly name: string;
  /** The text on the clipboard; '' when it holds no text. */
  read(): Promise<string>;
  write(text: string): Promise<void>;
}

export interface ClipboardCommand {
  file: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/** A clipboard, or why there is none. */
export type ClipboardChoice = { clipboard: Clipboard } | { unavailable: string };

const TIMEOUT_MS = 15_000;

/** A clipboard read and written by two commands: one gets the text on stdin, the other prints it. */
export class CommandClipboard implements Clipboard {
  readonly name: string;
  private readonly copy: ClipboardCommand;
  private readonly paste: ClipboardCommand;

  constructor(name: string, copy: ClipboardCommand, paste: ClipboardCommand) {
    this.name = name;
    this.copy = copy;
    this.paste = paste;
  }

  async read(): Promise<string> {
    const bytes = await run(this.name, this.paste);
    return bytes.toString('utf8').replace(/^\uFEFF/, '');
  }

  async write(text: string): Promise<void> {
    await run(this.name, this.copy, Buffer.from(text, 'utf8'));
  }
}

/**
 * Runs one clipboard command. A copy command may leave a process in the background that
 * serves the clipboard (xclip, xsel, wl-copy) and holds our pipes: a copy is done when
 * the command exits, a paste when its output is closed.
 */
function run(name: string, command: ClipboardCommand, input?: Buffer): Promise<Buffer> {
  const reading = input === undefined;
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      env: command.env ?? process.env,
      stdio: ['pipe', reading ? 'pipe' : 'ignore', 'pipe'],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    let settled = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stderr?.destroy();
      if (error) reject(error);
      else resolve(Buffer.concat(out));
    };
    const timer = setTimeout(() => {
      child.kill();
      settle(new Error(`${name}: ${basename(command.file)} did not finish in ${TIMEOUT_MS / 1000}s.`));
    }, TIMEOUT_MS);
    child.on('error', (error) => settle(new Error(`${name}: ${error.message}`)));
    child.on(reading ? 'close' : 'exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) return settle();
      const fail = (): void => {
        const detail = Buffer.concat(err).toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 300);
        settle(new Error(`${name}: ${basename(command.file)} failed (${code ?? signal})${detail === '' ? '' : `: ${detail}`}`));
      };
      const stderr = child.stderr;
      if (reading || !stderr || stderr.readableEnded) return fail();
      // On 'exit' the error message may still be in the pipe: give it a moment.
      const wait = setTimeout(fail, 500);
      stderr.once('end', () => {
        clearTimeout(wait);
        fail();
      });
    });
    // A tool that exits early closes its stdin: its exit code tells what went wrong.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
  });
}

/** Where to look for the tools; replaceable in tests. */
export interface ClipboardEnvironment {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** The full path of an executable, or undefined when it is not installed. */
  find: (name: string) => string | undefined;
  /** Whether a file exists (the usual PowerShell location). */
  exists: (path: string) => boolean;
}

export function currentEnvironment(): ClipboardEnvironment {
  return {
    platform: process.platform,
    env: process.env,
    find: (name) => findOnPath(name, process.env, process.platform),
    exists: isFile,
  };
}

/** The clipboard of this machine, or why there is none. */
export function systemClipboard(environment: ClipboardEnvironment = currentEnvironment()): ClipboardChoice {
  const { platform, env, find } = environment;
  if (platform === 'win32') {
    const shell = findPowerShell(environment);
    if (shell === undefined) return { unavailable: 'PowerShell, which holds the clipboard commands on Windows, was not found.' };
    return { clipboard: powerShellClipboard(shell, env) };
  }
  if (platform === 'darwin') {
    const copy = find('pbcopy');
    const paste = find('pbpaste');
    if (copy === undefined || paste === undefined) return { unavailable: 'pbcopy and pbpaste were not found.' };
    // They pick the text encoding from the locale.
    const utf8 = { ...env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };
    return { clipboard: new CommandClipboard('pbcopy/pbpaste', { file: copy, args: [], env: utf8 }, { file: paste, args: [], env: utf8 }) };
  }

  const wayland = (env.WAYLAND_DISPLAY ?? '') !== '';
  const x11 = (env.DISPLAY ?? '') !== '';
  if (wayland) {
    const copy = find('wl-copy');
    const paste = find('wl-paste');
    if (copy !== undefined && paste !== undefined) {
      return {
        clipboard: new CommandClipboard(
          'wl-clipboard',
          { file: copy, args: ['--type', 'text/plain;charset=utf-8'] },
          { file: paste, args: ['--no-newline', '--type', 'text'] },
        ),
      };
    }
  }
  if (x11 || wayland) {
    // XWayland: the X11 tools reach the clipboard too.
    const xclip = find('xclip');
    if (xclip !== undefined) {
      return {
        clipboard: new CommandClipboard(
          'xclip',
          { file: xclip, args: ['-selection', 'clipboard', '-in'] },
          { file: xclip, args: ['-selection', 'clipboard', '-out'] },
        ),
      };
    }
    const xsel = find('xsel');
    if (xsel !== undefined) {
      return {
        clipboard: new CommandClipboard(
          'xsel',
          { file: xsel, args: ['--clipboard', '--input'] },
          { file: xsel, args: ['--clipboard', '--output'] },
        ),
      };
    }
  }
  if ((env.WSL_DISTRO_NAME ?? '') !== '') {
    const shell = find('powershell.exe');
    if (shell !== undefined) return { clipboard: powerShellClipboard(shell, env) };
  }
  if (!wayland && !x11) return { unavailable: 'there is no graphical session (DISPLAY and WAYLAND_DISPLAY are not set).' };
  return { unavailable: `no clipboard tool was found: install ${wayland ? 'wl-clipboard, xclip or xsel' : 'xclip or xsel'}.` };
}

/**
 * Windows: PowerShell's own console encoding is the OEM code page, so the text crosses
 * the pipes as raw UTF-8 bytes, decoded and encoded inside the script.
 */
const POWERSHELL_READ = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$text = Get-Clipboard -Raw
if ($null -eq $text) { $text = '' }
$bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$text)
$out = [Console]::OpenStandardOutput()
$out.Write($bytes, 0, $bytes.Length)
$out.Flush()`;

const POWERSHELL_WRITE = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$buffer = New-Object System.IO.MemoryStream
[Console]::OpenStandardInput().CopyTo($buffer)
$text = [System.Text.Encoding]::UTF8.GetString($buffer.ToArray())
if ($text.Length -eq 0) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.Clipboard]::Clear()
} else {
  Set-Clipboard -Value $text
}`;

/** Windows PowerShell where Windows keeps it, else powershell.exe or pwsh.exe on the PATH. */
export function findPowerShell(environment: ClipboardEnvironment): string | undefined {
  const { env, find } = environment;
  const usual = join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return environment.exists(usual) ? usual : (find('powershell.exe') ?? find('pwsh.exe'));
}

/**
 * The clipboard through PowerShell. `prelude` runs before each script: the tests define
 * Get-Clipboard and Set-Clipboard there as functions, which PowerShell prefers to the
 * cmdlets, so they run the real scripts and pipes without touching the user's clipboard.
 */
export function powerShellClipboard(shell: string, env: NodeJS.ProcessEnv, prelude = ''): Clipboard {
  // -EncodedCommand: no quoting to get wrong, and not subject to the script execution policy.
  const command = (script: string): ClipboardCommand => ({
    file: shell,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`${prelude}\n${script}`, 'utf16le').toString('base64')],
    env,
  });
  return new CommandClipboard('PowerShell', command(POWERSHELL_WRITE), command(POWERSHELL_READ));
}

/** The full path of an executable found in an absolute PATH folder (PATHEXT on Windows). */
export function findOnPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  const windows = platform === 'win32';
  const folders = (env.PATH ?? env.Path ?? '').split(windows ? ';' : ':');
  const extensions = windows && extname(name) === '' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const folder of folders) {
    // A relative entry would find whatever lies in the current folder.
    if (folder === '' || !isAbsolute(folder)) continue;
    for (const extension of extensions) {
      const file = join(folder, name + extension);
      if (!isFile(file)) continue;
      if (windows) return file;
      try {
        accessSync(file, constants.X_OK);
        return file;
      } catch {
        // Not executable: keep looking.
      }
    }
  }
  return undefined;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
