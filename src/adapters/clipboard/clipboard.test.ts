import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CommandClipboard,
  currentEnvironment,
  findOnPath,
  findPowerShell,
  powerShellClipboard,
  systemClipboard,
  type ClipboardEnvironment,
} from './clipboard.js';

/** An environment where only `installed` tools exist. Nothing is run. */
function environment(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, installed: string[], exists = false): ClipboardEnvironment {
  return {
    platform,
    env,
    find: (name) => (installed.includes(name) ? `/usr/bin/${name}` : undefined),
    exists: () => exists,
  };
}

function nameOf(choice: ReturnType<typeof systemClipboard>): string {
  return 'clipboard' in choice ? choice.clipboard.name : `unavailable: ${choice.unavailable}`;
}

test('each OS gets its own clipboard tools', () => {
  assert.equal(nameOf(systemClipboard(environment('win32', { SystemRoot: 'C:\\Windows' }, [], true))), 'PowerShell');
  assert.equal(nameOf(systemClipboard(environment('win32', {}, ['pwsh.exe']))), 'PowerShell');
  assert.match(nameOf(systemClipboard(environment('win32', {}, []))), /unavailable: PowerShell/);

  assert.equal(nameOf(systemClipboard(environment('darwin', {}, ['pbcopy', 'pbpaste']))), 'pbcopy/pbpaste');
  assert.match(nameOf(systemClipboard(environment('darwin', {}, []))), /unavailable: pbcopy and pbpaste/);

  const wayland = { WAYLAND_DISPLAY: 'wayland-0' };
  assert.equal(nameOf(systemClipboard(environment('linux', wayland, ['wl-copy', 'wl-paste', 'xclip']))), 'wl-clipboard');
  assert.equal(nameOf(systemClipboard(environment('linux', wayland, ['xclip']))), 'xclip', 'XWayland');
  assert.match(nameOf(systemClipboard(environment('linux', wayland, []))), /install wl-clipboard, xclip or xsel/);

  const x11 = { DISPLAY: ':0' };
  assert.equal(nameOf(systemClipboard(environment('linux', x11, ['xclip', 'xsel']))), 'xclip');
  assert.equal(nameOf(systemClipboard(environment('freebsd', x11, ['xsel']))), 'xsel');
  assert.match(nameOf(systemClipboard(environment('linux', x11, ['wl-copy', 'wl-paste']))), /install xclip or xsel/);

  assert.match(nameOf(systemClipboard(environment('linux', {}, ['xclip']))), /no graphical session/);
  assert.equal(nameOf(systemClipboard(environment('linux', { WSL_DISTRO_NAME: 'Ubuntu' }, ['powershell.exe']))), 'PowerShell');
});

test('a command clipboard passes text as UTF-8 both ways', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-clipboard-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = join(dir, 'clipboard.bin');
  // Two small Node programs stand in for the OS tools: one stores stdin, the other prints it.
  const copy = { file: process.execPath, args: ['-e', `process.stdin.pipe(require('fs').createWriteStream(${JSON.stringify(store)}))`] };
  const paste = { file: process.execPath, args: ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(store)}))`] };
  const clipboard = new CommandClipboard('test', copy, paste);

  const text = 'àèìòù € 漢字 🎉 "quotes" $HOME `ticks`\n\tsecond line\r\nthird';
  await clipboard.write(text);
  assert.equal(await clipboard.read(), text);
  await clipboard.write('');
  assert.equal(await clipboard.read(), '');

  // A byte order mark from the tool is dropped.
  await writeFile(store, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('ok', 'utf8')]));
  assert.equal(await clipboard.read(), 'ok');
});

test('Windows: the PowerShell scripts pass text as UTF-8 both ways (cmdlets replaced, clipboard untouched)', async (t) => {
  const shell = process.platform === 'win32' ? findPowerShell(currentEnvironment()) : undefined;
  if (shell === undefined) {
    t.skip(process.platform === 'win32' ? 'PowerShell not found' : 'Windows only');
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'agent-powershell-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = join(dir, 'clipboard.txt');
  // Functions win over cmdlets in PowerShell: these two keep the "clipboard" in a file.
  const prelude = [
    'function Set-Clipboard { param([string]$Value) [System.IO.File]::WriteAllText($env:AGENT_TEST_CLIPBOARD, $Value, (New-Object System.Text.UTF8Encoding($false))) }',
    'function Get-Clipboard { param([switch]$Raw) [System.IO.File]::ReadAllText($env:AGENT_TEST_CLIPBOARD, [System.Text.Encoding]::UTF8) }',
  ].join('\n');
  const clipboard = powerShellClipboard(shell, { ...process.env, AGENT_TEST_CLIPBOARD: store }, prelude);

  const text = `àèìòù € 漢字 🎉 "double" 'single' $HOME \`ticks\` %PATH% ^caret\n\tsecond line\r\nthird\n`;
  await clipboard.write(text);
  // The functions ran (not the cmdlets): the text is in the file, as UTF-8 without a BOM.
  assert.deepEqual(await readFile(store), Buffer.from(text, 'utf8'));
  assert.equal(await clipboard.read(), text);

  // A long prompt, as the first one of a task is.
  const long = `${'línea ✓ '.repeat(20_000)}\nend`;
  await clipboard.write(long);
  assert.equal(await clipboard.read(), long);
});

test('a failing or missing tool gives a clear error', async () => {
  const failing = new CommandClipboard(
    'test',
    { file: process.execPath, args: ['-e', "process.stderr.write('Error: Can\\'t open display'); process.exit(1)"] },
    { file: process.execPath, args: ['-e', 'process.exit(2)'] },
  );
  await assert.rejects(failing.write('x'), /test: .* failed \(1\): Error: Can't open display/);
  await assert.rejects(failing.read(), /test: .* failed \(2\)/);

  const missing = new CommandClipboard('test', { file: join(tmpdir(), 'no-such-clipboard-tool'), args: [] }, { file: join(tmpdir(), 'no-such-clipboard-tool'), args: [] });
  await assert.rejects(missing.read(), /test: .*ENOENT/);
});

test('tools are found in absolute PATH folders only', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-path-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const windows = process.platform === 'win32';
  const file = join(dir, windows ? 'cliptool.exe' : 'cliptool');
  await writeFile(file, '');
  if (!windows) await chmod(file, 0o755);
  const separator = windows ? ';' : ':';
  const env = { PATH: ['relative', dir].join(separator), PATHEXT: '.EXE;.CMD' };
  // Windows tries each PATHEXT extension: "cliptool.EXE" is the same file there.
  assert.equal(findOnPath('cliptool', env, process.platform)?.toLowerCase(), file.toLowerCase());
  assert.equal(findOnPath('missing-tool', env, process.platform), undefined);
  assert.equal(findOnPath('cliptool', { PATH: 'relative' }, process.platform), undefined);
  if (!windows) {
    await chmod(file, 0o644);
    assert.equal(findOnPath('cliptool', env, process.platform), undefined, 'not executable');
  }
});
