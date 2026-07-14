// ── Holdings Auth — Express middleware ───────────────────────────────────────
// Guards every /holdings-intel/* route. Identity is derived from the verified
// JWT and from nowhere else.
//
// Unused until PR-1 mounts the holdings routes behind it. It ships in PR-0 so
// the gate exists, and is tested, before anything valuable sits behind it.

const { verifyToken } = require('./holdingsAuth');

/**
 * @param {object} db — pg Pool instance
 */
module.exports = function requireHoldingsAuth(db) {
  return async (req, res, next) => {
    // Structurally ignore the legacy placeholder header. The rest of the app
    // trusts `x-user-id` verbatim; this module must never do that. Deleting it
    // here means no downstream handler in the /holdings-intel/* namespace can
    // read it even by accident.
    delete req.headers['x-user-id'];

    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    let claims;
    try {
      claims = verifyToken(token);
    } catch {
      // One generic message for every failure mode. The jwt library
      // distinguishes expired / malformed / bad-signature, and echoing that
      // back hands an attacker free information.
      return res.status(401).json({ ok: false, error: 'Invalid or expired token' });
    }

    let user;
    try {
      const { rows } = await db.query(
        'SELECT id, email, name, token_version FROM holdings_users WHERE id = $1',
        [claims.sub]
      );
      user = rows[0];
    } catch (e) {
      console.error('[HoldingsAuth] DB error during token check:', e.message);
      return res.status(503).json({ ok: false, error: 'Auth backend unavailable' });
    }

    // token_version mismatch => the token was minted before a logout or a
    // password change. This is what gives stateless JWTs revocation.
    if (!user || user.token_version !== claims.tv) {
      return res.status(401).json({ ok: false, error: 'Invalid or expired token' });
    }

    req.holdingsUser = { id: user.id, email: user.email, name: user.name };
    next();
  };
};
