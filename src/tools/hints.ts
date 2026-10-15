/**
 * Hints for the approval prompt: the usual ways a command does lasting damage. They
 * match text the model wrote, and quotes, variables or an encoded string get around
 * them, so they decide nothing: every command still needs approval, and the sandbox
 * is what contains it. They only point the user's attention.
 */
const HINTS: readonly { test: RegExp | ((command: string) => boolean); hint: string }[] = [
  { test: recursiveForcedRm, hint: 'rm -rf deletes whole folders without asking' },
  { test: /(?:^|[\s;&|(`])(?:sudo|doas|pkexec)\s|(?:^|[\s;&|(`])su\s+(?:-|root\b)/, hint: 'sudo runs it as root' },
  {
    test: /\b(?:curl|wget|fetch)\b[^\n;&]*\|\s*(?:sudo\s+)?(?:[a-z]*sh|python[0-9.]*|perl|ruby|node|bun|deno)\b|\b(?:sh|bash|zsh)\s+(?:-c\s+)?["']?\$\(\s*(?:curl|wget)\b|\b(?:sh|bash|zsh)\s+<\(\s*(?:curl|wget)\b/,
    hint: 'it downloads code and runs it',
  },
  { test: /\b(?:base64|xxd|openssl)\b[^\n]*(?:-d\b|--decode\b|-r\b)[^\n]*\|\s*(?:[a-z]*sh|python[0-9.]*|perl|node)\b|\beval\s/, hint: 'it runs code that is not written out here (eval, decoded text)' },
  { test: /\b(?:chmod|chown|chgrp)\s+(?:\S+\s+)*(?:-[a-zA-Z]*R[a-zA-Z]*|--recursive)\b/, hint: 'it changes permissions or owners of whole folders' },
  { test: /\bchmod\s+(?:-\S+\s+)*(?:0?777|a\+rwx|o\+w)\b/, hint: 'it makes files writable by everyone' },
  { test: /\bgit\s+push\b[^\n;&|]*(?:\s--force(?:-with-lease)?\b|\s-[a-zA-Z]*f\b|\s\+\S)/, hint: 'git push --force can overwrite the history on the remote' },
  { test: /\bgit\s+(?:reset\s+--hard|clean\s+-[a-zA-Z]*f|checkout\s+(?:--\s+)?\.(?:\s|$)|stash\s+(?:drop|clear))/, hint: 'it throws away uncommitted work' },
  { test: /\bdd\s+[^\n]*\bof=\/dev\/|\bmkfs(?:\.\w+)?\s|>\s*\/dev\/(?:sd[a-z]|nvme|disk|hd[a-z])/, hint: 'it writes to a disk device' },
  { test: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, hint: 'a fork bomb' },
  {
    test: />>?\s*(?:~|\$HOME|\$\{HOME\})\/(?:\.(?:bash|zsh|ba)?rc|\.(?:bash_)?profile|\.zshenv|\.ssh\/|\.gitconfig|\.config\/)/,
    hint: 'it writes to your shell startup files or SSH and git settings',
  },
  {
    test: /\bcrontab\s+(?!-l\b)\S|\bsystemctl\s+(?:--user\s+)?enable\b|\blaunchctl\s+(?:load|bootstrap)\b/,
    hint: 'it installs something that runs later on its own',
  },
];

/** The hints that match a command, at most one per kind. */
export function dangerHints(command: string): string[] {
  return HINTS.filter(({ test }) => (typeof test === 'function' ? test(command) : test.test(command))).map(({ hint }) => hint);
}

/** rm with both recursive and force, however the flags are written: -rf, -fR, -r -f, --recursive --force. */
function recursiveForcedRm(command: string): boolean {
  for (const match of command.matchAll(/(?:^|[\s;&|(`])rm((?:\s+-[^\s]*)+)/g)) {
    const flags = (match[1] ?? '').trim().split(/\s+/);
    const short = flags.filter((flag) => /^-[a-zA-Z]+$/.test(flag)).join('');
    const recursive = /[rR]/.test(short) || flags.includes('--recursive');
    const force = short.includes('f') || flags.includes('--force');
    if (recursive && force) return true;
  }
  return false;
}
