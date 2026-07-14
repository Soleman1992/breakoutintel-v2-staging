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

// ── Prompt helpers ───────────────────────────────────────────────────────────
function ask(rl, question) {
  return new Promise(resolve => rl.question(question, a => resolve(a.trim())));
}

// Suppresses terminal echo so the password is never displayed or scrolled back.
function askHidden(rl, question) {
  return new Promise(resolve => {
    rl.muted = false;
    rl.question(question, answer => {
      rl.muted = false;
      rl.output.write('\n');
      resolve(answer);
    });
    rl.muted = true;
  });
}

function makeInterface() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  const original = rl._writeToOutput.bind(rl);
  rl._writeToOutput = function (str) {
    if (rl.muted) {
      // Redraw the prompt only — swallow the typed characters entirely.
      rl.output.write('');
      return;
    }
    original(str);
  };
  return rl;
}

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
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
        '  backend/src/models/migrations/011_holdings_auth.sql manually.'
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

    const email = await ask(rl, 'Email: ');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      fail('That does not look like a valid email address.');
    }

    const password = await askHidden(rl, `Password (min ${MIN_PASSWORD_LENGTH} chars): `);
    if (password.length < MIN_PASSWORD_LENGTH) {
      fail(`Password must be at least ${MIN_PASSWORD_LENGTH} characters (got ${password.length}).`);
    }

    const confirm = await askHidden(rl, 'Confirm password: ');
    if (password !== confirm) {
      fail('Passwords do not match.');
    }

    const name = await ask(rl, 'Name (optional): ');

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

    console.log('Next: set HOLDINGS_JWT_SECRET in your environment.');
    console.log('  Generate with:  openssl rand -hex 32');
    console.log('  Set it in Render\'s dashboard — never commit it.\n');
  } catch (e) {
    fail(e.message);
  } finally {
    rl.close();
    await db.end();
  }
})();
