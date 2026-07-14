// ── askHidden() — the echo-suppressed password reader ────────────────────────
//
// The first version of this silently returned an empty string on Windows
// PowerShell, so the script bailed and the user's keystrokes fell through to
// the shell as commands — leaking the password they were trying to set. These
// tests exist so that cannot happen again.
//
// A real TTY can't be simulated from a test runner, so askHidden takes an
// injectable stdin/stdout and we drive it with fakes.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { askHidden } = require('../scripts/createHoldingsUser');

const ETX = ''; // Ctrl-C
const EOT = ''; // Ctrl-D
const DEL = ''; // Backspace

function fakeTTY({ isTTY = true } = {}) {
  const s = new EventEmitter();
  s.isTTY = isTTY;
  s.rawMode = null;
  s.setRawMode = (v) => { s.rawMode = v; };
  s.resume = () => {};
  s.pause = () => {};
  s.setEncoding = () => {};
  return s;
}

function fakeOut() {
  const out = { written: '' };
  out.write = (s) => { out.written += s; return true; };
  return out;
}

// Feed keystrokes after askHidden has attached its listener.
function type(stdin, ...chunks) {
  setImmediate(() => chunks.forEach(c => stdin.emit('data', c)));
}

describe('askHidden', () => {
  test('reads a password typed one character at a time', async () => {
    const stdin = fakeTTY(), stdout = fakeOut();
    const p = askHidden('Password: ', stdin, stdout);
    type(stdin, 'h', 'u', 'n', 't', 'e', 'r', '2', '\r');

    assert.equal(await p, 'hunter2');
  });

  test('reads a password delivered as one chunk (paste)', async () => {
    const stdin = fakeTTY(), stdout = fakeOut();
    const p = askHidden('Password: ', stdin, stdout);
    type(stdin, 'CorrectHorseBattery!2026\r');

    assert.equal(await p, 'CorrectHorseBattery!2026');
  });

  test('NEVER echoes the typed characters', async () => {
    const stdin = fakeTTY(), stdout = fakeOut();
    const p = askHidden('Password: ', stdin, stdout);
    type(stdin, 'S3cret-Passphrase\r');
    await p;

    // Only the prompt and the closing newline may ever be written.
    assert.equal(stdout.written, 'Password: \n');
    assert.ok(!stdout.written.includes('S3cret'));
  });

  test('handles backspace', async () => {
    const stdin = fakeTTY(), stdout = fakeOut();
    const p = askHidden('Password: ', stdin, stdout);
    type(stdin, 'abcX', DEL, 'd', '\r');

    assert.equal(await p, 'abcd');
  });

  test('backspace on an empty buffer does not underflow', async () => {
    const stdin = fakeTTY(), stdout = fakeOut();
    const p = askHidden('Password: ', stdin, stdout);
    type(stdin, DEL, DEL, 'a', '\r');

    assert.equal(await p, 'a');
  });

  test('ignores arrow keys and other escape sequences', async () => {
    const stdin = fakeTTY(), stdout = fakeOut();
    const p = askHidden('Password: ', stdin, stdout);
    type(stdin, 'ab', '[A', '[D', 'cd', '\r');   // up, left

    assert.equal(await p, 'abcd');
  });

  test('accepts \\n as well as \\r (terminals differ)', async () => {
    const stdin = fakeTTY(), stdout = fakeOut();
    const p = askHidden('Password: ', stdin, stdout);
    type(stdin, 'linefeed-terminated\n');

    assert.equal(await p, 'linefeed-terminated');
  });

  test('Ctrl-D ends input', async () => {
    const stdin = fakeTTY(), stdout = fakeOut();
    const p = askHidden('Password: ', stdin, stdout);
    type(stdin, 'partial', EOT);

    assert.equal(await p, 'partial');
  });

  test('restores raw mode and detaches its listener when done', async () => {
    const stdin = fakeTTY(), stdout = fakeOut();
    const p = askHidden('Password: ', stdin, stdout);
    type(stdin, 'x\r');
    await p;

    assert.equal(stdin.rawMode, false, 'raw mode must be restored');
    assert.equal(stdin.listenerCount('data'), 0, 'listener must be removed');
  });

  test('rejects when there is no TTY — never resolves empty', async () => {
    const stdin = fakeTTY({ isTTY: false }), stdout = fakeOut();

    // This is the regression: it used to resolve '' here, which made the caller
    // fail with "password must be at least 12 characters (got 0)".
    await assert.rejects(
      () => askHidden('Password: ', stdin, stdout),
      /No interactive terminal detected/
    );
  });
});
