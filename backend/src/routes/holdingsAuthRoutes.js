// ── Holdings Auth Routes — PR-0 ──────────────────────────────────────────────
// Mounted at /holdings-intel/auth in index.js.
//
//   POST /holdings-intel/auth/login   — email + password  -> JWT
//   POST /holdings-intel/auth/logout  — authed; revokes all outstanding JWTs
//   GET  /holdings-intel/auth/me      — authed; current user
//
// There is deliberately NO signup route. The single operator user is created
// once, out of band, via `npm run holdings:create-user`. An open registration
// endpoint on a single-user app is pure attack surface.

const express   = require('express');
const rateLimit = require('express-rate-limit');

const {
  verifyPassword,
  getDummyHash,
  signToken,
  getSecret,
} = require('../auth/holdingsAuth');
const requireHoldingsAuth = require('../auth/requireHoldingsAuth');

// Lockout policy — a backstop behind the per-IP rate limiter, in case an
// attacker has many source IPs.
const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_MINUTES     = 15;

// One generic message for wrong-email, wrong-password, and locked-out alike.
// Distinguishing them tells an attacker which emails are real and when they've
// tripped the lockout.
const GENERIC_LOGIN_ERROR = 'Invalid credentials';

/**
 * @param {object} db — pg Pool instance
 */
module.exports = function holdingsAuthRoutes(db) {
  // Fail closed at mount time if the signing secret is absent or weak. index.js
  // catches this and leaves the rest of the app running, with the entire
  // /holdings-intel/* namespace unmounted.
  getSecret();

  const router = express.Router();

  // Tighter than the app-wide limiter (200/min). This is the brute-force
  // surface, so it gets its own budget.
  //
  // Note: the default store is in-memory, i.e. per-process. Correct on Render's
  // free tier (single instance). If this ever scales out, it needs the Redis
  // store — redis is already a dependency.
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    // A successful login must not burn the budget — otherwise a legitimate
    // operator logging in twice a day slowly locks themselves out.
    skipSuccessfulRequests: true,
    message: { ok: false, error: 'Too many login attempts. Try again later.' },
  });

  // ── POST /login ───────────────────────────────────────────────────────────
  router.post('/login', loginLimiter, async (req, res) => {
    try {
      const { email, password } = req.body || {};

      if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
        return res.status(400).json({ ok: false, error: 'email and password are required' });
      }

      const { rows } = await db.query(
        `SELECT id, email, name, password_hash, token_version,
                failed_login_count, locked_until
           FROM holdings_users
          WHERE LOWER(email) = LOWER($1)`,
        [email]
      );
      const user = rows[0] || null;

      // Always run a bcrypt compare, even when the user does not exist, so the
      // response time does not reveal whether the email is registered.
      const hash  = user ? user.password_hash : getDummyHash();
      const match = await verifyPassword(password, hash);

      // Check the lock AFTER the compare, so a locked account and a wrong
      // password cost the same wall-clock time.
      const locked = !!(user && user.locked_until && new Date(user.locked_until) > new Date());

      if (!user || !match || locked) {
        if (user && !locked) {
          const next = (user.failed_login_count || 0) + 1;
          if (next >= MAX_FAILED_ATTEMPTS) {
            await db.query(
              `UPDATE holdings_users
                  SET failed_login_count = $1,
                      locked_until = NOW() + ($2 || ' minutes')::INTERVAL
                WHERE id = $3`,
              [next, String(LOCKOUT_MINUTES), user.id]
            );
          } else {
            await db.query(
              'UPDATE holdings_users SET failed_login_count = $1 WHERE id = $2',
              [next, user.id]
            );
          }
        }
        // Never log the submitted password, and never log which branch failed.
        return res.status(401).json({ ok: false, error: GENERIC_LOGIN_ERROR });
      }

      await db.query(
        `UPDATE holdings_users
            SET failed_login_count = 0,
                locked_until = NULL,
                last_login_at = NOW()
          WHERE id = $1`,
        [user.id]
      );

      const token = signToken({ id: user.id, token_version: user.token_version });

      return res.json({
        ok: true,
        token,
        expiresIn: 12 * 60 * 60,
        user: { id: user.id, email: user.email, name: user.name },
      });
    } catch (e) {
      console.error('[HoldingsAuth] Login error:', e.message);
      return res.status(500).json({ ok: false, error: 'Login failed' });
    }
  });

  // ── POST /logout ──────────────────────────────────────────────────────────
  // Bumps token_version, which instantly invalidates every outstanding JWT for
  // this user — including any copy an attacker may hold.
  router.post('/logout', requireHoldingsAuth(db), async (req, res) => {
    try {
      await db.query(
        'UPDATE holdings_users SET token_version = token_version + 1 WHERE id = $1',
        [req.holdingsUser.id]
      );
      return res.json({ ok: true, message: 'Logged out. All sessions invalidated.' });
    } catch (e) {
      console.error('[HoldingsAuth] Logout error:', e.message);
      return res.status(500).json({ ok: false, error: 'Logout failed' });
    }
  });

  // ── GET /me ───────────────────────────────────────────────────────────────
  // Never returns password_hash or token_version.
  router.get('/me', requireHoldingsAuth(db), (req, res) => {
    return res.json({ ok: true, user: req.holdingsUser });
  });

  return router;
};
