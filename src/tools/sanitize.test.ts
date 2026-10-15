import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countHidden, safe, safeLine, sanitize } from './sanitize.js';

test('escape sequences, carriage returns and other C0/C1 controls become visible', () => {
  assert.deepEqual(sanitize('\x1b[31mred\x1b[0m'), { text: '\\x1b[31mred\\x1b[0m', hidden: 2 });
  // \r would send the cursor back and let "safe" overwrite what really runs.
  assert.deepEqual(sanitize('rm -rf ~\rsafe   '), { text: 'rm -rf ~\\rsafe   ', hidden: 1 });
  assert.equal(sanitize('\x07\x08\x00\x7f').text, '\\x07\\b\\0\\x7f');
  // C1: CSI (0x9b) and OSC (0x9d) start sequences on their own in some terminals.
  assert.equal(sanitize('\u009b2J\u009d52;c;aGk=\u0007').text, '\\x9b2J\\x9d52;c;aGk=\\x07');
  assert.equal(sanitize('a\u0085b').text, 'a\\x85b');
});

test('newlines and tabs stay in multi-line text and are escaped in one-line fields', () => {
  assert.deepEqual(sanitize('a\n\tb'), { text: 'a\n\tb', hidden: 0 });
  assert.deepEqual(sanitize('a\n\tb', { multiline: false }), { text: 'a\\n\\tb', hidden: 2 });
  assert.equal(safeLine('x.txt\n? fake prompt'), 'x.txt\\n? fake prompt');
});

test('bidi controls, zero-width and other invisible characters become visible', () => {
  // "Trojan Source": U+202E reverses what follows on screen.
  assert.equal(sanitize('echo safe‮;hs.lave | lruc').text, 'echo safe\\u{202e};hs.lave | lruc');
  for (const code of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c]) {
    assert.equal(sanitize(String.fromCodePoint(code)).hidden, 1, code.toString(16));
  }
  for (const code of [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad, 0x2028, 0x2029, 0x3164, 0xfe0f, 0xe0041]) {
    assert.equal(sanitize(`a${String.fromCodePoint(code)}b`).hidden, 1, code.toString(16));
  }
  assert.equal(sanitize('a\u{e0041}b').text, 'a\\u{e0041}b');
  assert.equal(sanitize('lone \ud800 surrogate').text, 'lone \\u{d800} surrogate');
});

test('ordinary text, accents and emoji are left alone', () => {
  const text = 'Così è: café, naïve, 日本語, ✅ done 🚀 — “quotes”';
  assert.deepEqual(sanitize(text), { text, hidden: 0 });
});

test('the output is safe to sanitize again, and safe() folds Windows line endings', () => {
  const once = sanitize('\x1b[2J‮\r\n').text;
  assert.equal(sanitize(once).text, once);
  assert.equal(safe('one\r\ntwo\rthree'), 'one\ntwo\\rthree');
});

test('countHidden looks into strings, keys and lists', () => {
  assert.equal(countHidden({ command: 'ls​', list: ['\x1b', 'ok'], ['k‮']: 1, n: 3 }), 3);
  assert.equal(countHidden({ text: 'plain\n\ttext' }), 0);
});
