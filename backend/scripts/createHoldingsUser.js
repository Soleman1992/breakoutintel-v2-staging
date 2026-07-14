#!/usr/bin/env node
//
// ── Create the Holdings operator user — one-time setup ───────────────────────
//
//   npm run holdings:create-user
//   npm run holdings:create-user -- --force     (reset the existing password)
//
// This is the ONLY way a holdings_users row comes into existence. There is no
// signup route, by design.
//
// The password is read from an interactive prompt with echo suppressed — never
// from argv or an env var, so it cannot land in shell history, in `ps` output,
// or in a CI log.

require('dotenv').config();

const readline = require('readline');
const { Pool } = require('pg');
const { hashPassword, MIN_PASSWORD_LENGTH } = require('../src/auth/holdingsAuth');

const FORCE = process.argv.includes('--force');

// Control characters, named so the switch below stays readable.
const ETX = '';   // Ctrl-C
const EOT = '';   // Ctrl-D
const BS  = '';   // Backspace
const DEL = '';   // Delete (what most terminals send for Backspace)

// ── Prompt helpers ───────────────────────────────────────────────────────────
function ask(rl, question) {
  return new Promise(resolve => rl.question(question, a => resolve(a.trim())));
}

/**
 * Read a line with terminal echo suppressed, so the password is never shown,
 * never scrolls back, and never reaches shell history.
 *
 * Reads stdin in raw mode directly rather than going through readline. The
 * first version of this overrode readline's private _writeToOutput to mute the
 * echo; on Windows PowerShell that interfered with readline's own line handling
 * and the prompt resolved instantly with an empty string — the script then bailed
 * and the user's keystrokes fell through to the shell as commands. Raw mode is
 * the portable way to do this.
 *
 * IMPORTANT: no readline interface may be open on stdin while this runs — both
 * consume 'data' events. Callers close it first.
 *
 * `stdin`/`stdout` are injectable so this can be unit-tested with fake streams:
 * a real TTY cannot be simulated from a test runner, and this function has
 * already been wrong once.
 */
function askHidden(query, stdin = process.stdin, stdout = process.stdout) {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY) {
      return reject(new Error(
        'No interactive terminal detected.\n' +
        '  Run this directly in PowerShell, Git Bash, or Windows Terminal —\n' +
        "  not through a pipe, a CI job, or an assistant's shell."
      ));
    }

    stdout.write(query);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let pw = '';

    const finish = (value) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\n');
      resolve(value);
    };

    const onData = (chunk) => {
      // Arrow keys, Home/End, F-keys etc. arrive as a single ESC-prefixed chunk
      // (e.g. ESC [ A). ESC itself is a control char and would be skipped below,
      // but the '[' and 'A' that follow are printable and would be appended
      // straight into the password. Drop the whole sequence instead.
      if (chunk.charCodeAt(0) === 27) return;

      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === EOT) return finish(pw);

        if (ch === ETX) {                      // Ctrl-C — abort cleanly
          stdin.setRawMode(false);
          stdout.write('\n^C\n');
          process.exit(130);
        }

        if (ch === DEL || ch === BS) {         // Backspace
          pw = pw.slice(0, -1);
          continue;
        }

        // Skip every other control character (arrow keys, escape sequences...)
        if (ch >= ' ' && ch !== DEL) pw += ch;
      }
    };

    stdin.on('data', onData);
  });
}

function makeInterface() {
  return readline.createInterface({
    input:    process.stdin,
    output:   process.stdout,
    terminal: true,
  });
}

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

// ── Main ─────────────────────────────────────────────────────────────────────
let rlClosed = false;

async function main() {
  // Fail fast and legibly if there is no terminal. The password is read in raw
  // mode, which requires a TTY; without this guard the failure surfaces as an
  // opaque "readline was closed" much further down.
  if (!process.stdin.isTTY) {
    fail(
      'No interactive terminal detected.\n' +
      '  This script must be run directly in a terminal — PowerShell, Git Bash,\n' +
      '  or Windows Terminal — so it can read your password without echoing it.\n' +
      "  It cannot be piped, scripted, or run through an assistant's shell."
    );
  }

  if (!process.env.DATABASE_URL) {
    fail('DATABASE_URL is not set. Set it in your environment or backend/.env');
  }

  const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost')
      ? false
      : { rejectUnauthorized: false },
  });

  const rl = makeInterface();

  try {
    // The table must already exist — the operator runs the migration first.
    const { rows: tableCheck } = await db.query(
      `SELECT to_regclass('public.holdings_users') AS t`
    );
    if (!tableCheck[0].t) {
      fail(
        'Table holdings_users does not exist.\n' +
        '  Run the app once (migrations run on boot), or apply\n' +
        '  backend/src/models/migrations/012_holdings_auth.sql manually.'
      );
    }

    const { rows: existing } = await db.query(
      'SELECT id, email FROM holdings_users ORDER BY created_at ASC'
    );

    if (existing.length > 0 && !FORCE) {
      console.error(
        `\n✗ A holdings user already exists: ${existing[0].email}\n\n` +
        `  This module is single-user by design. To reset that user's password,\n` +
        `  re-run with --force:\n\n` +
        `      npm run holdings:create-user -- --force\n\n` +
        `  --force also bumps token_version, logging out all active sessions.\n`
      );
      process.exit(1);
    }

    console.log('\n── BreakoutIntel — Holdings operator user ──\n');
    if (FORCE && existing.length > 0) {
      console.log(`⚠  --force: resetting the password for ${existing[0].email}`);
      console.log('   All active sessions will be logged out.\n');
    }

    // Email and name first, via readline. The password prompts come last and
    // read stdin in raw mode — readline must be CLOSED by then, or the two
    // compete for the same 'data' events and the password reads as empty.
    const email = await ask(rl, 'Email: ');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      fail('That does not look like a valid email address.');
    }

    const name = await ask(rl, 'Name (optional): ');

    rl.close();
    rlClosed = true;

    console.log('\nThe password will not appear as you type — that is expected.');
    console.log('Keep typing, then press Enter.\n');

    const password = await askHidden(`Password (min ${MIN_PASSWORD_LENGTH} chars): `);
    if (password.length < MIN_PASSWORD_LENGTH) {
      fail(`Password must be at least ${MIN_PASSWORD_LENGTH} characters (got ${password.length}).`);
    }

    const confirm = await askHidden('Confirm password: ');
    if (password !== confirm) {
      fail('Passwords do not match.');
    }

    process.stdout.write('\nHashing (bcrypt cost 12, this takes a moment)... ');
    const hash = await hashPassword(password);
    process.stdout.write('done\n');

    if (FORCE && existing.length > 0) {
      // Reset in place: new hash, sessions revoked, lockout cleared.
      await db.query(
        `UPDATE holdings_users
            SET email              = $1,
                password_hash      = $2,
                name               = COALESCE(NULLIF($3, ''), name),
                token_version      = token_version + 1,
                failed_login_count = 0,
                locked_until       = NULL
          WHERE id = $4`,
        [email, hash, name, existing[0].id]
      );
      console.log(`\n✓ Password reset for ${email}. All sessions invalidated.\n`);
    } else {
      const { rows } = await db.query(
        `INSERT INTO holdings_users (email, password_hash, name)
         VALUES ($1, $2, NULLIF($3, ''))
         RETURNING id, email`,
        [email, hash, name]
      );
      console.log(`\n✓ Created holdings user ${rows[0].email} (${rows[0].id})\n`);
    }

    console.log('You can now sign in at https://breakoutintel-v2.onrender.com');
    console.log('  Click the lock chip in the top-right of the ribbon.\n');
  } catch (e) {
    fail(e.message);
  } finally {
    if (!rlClosed) rl.close();
    await db.end();
  }
}

// Only run when invoked directly — `require`ing this (e.g. from tests) must not
// launch the prompt flow.
if (require.main === module) {
  main();
}

module.exports = { askHidden };
