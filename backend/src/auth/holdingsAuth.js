// ── Holdings Auth — crypto + token primitives ────────────────────────────────
// Pure functions. No Express, no DB — so this is trivially unit-testable and
// has no reason to reach into the rest of the app.
//
// Guards the /holdings-intel/* namespace only. The existing /portfolio/* routes
// and their x-user-id placeholder flow are untouched by this module.

const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');

const ISSUER      = 'breakoutintel-holdings';
const AUDIENCE    = 'holdings-intel';
const TTL         = '12h';
const BCRYPT_COST = 12;
const MIN_PASSWORD_LENGTH = 12;

/**
 * Read the signing secret from the environment.
 *
 * Env ONLY — no default, no fallback, no dev-mode key. A weak or absent secret
 * here is equivalent to having no authentication at all, so the correct
 * behaviour is to refuse to operate. Throwing means the auth router never
 * mounts, which means the Holdings routes never mount: the module fails CLOSED
 * rather than ending up reachable-but-unauthenticated.
 *
 * Generate with: openssl rand -hex 32
 */
function getSecret() {
  const s = process.env.HOLDINGS_JWT_SECRET;
  if (!s || s.length < 32) {
    throw new Error(
      'HOLDINGS_JWT_SECRET missing or too short (need >= 32 chars). ' +
      'Generate with: openssl rand -hex 32'
    );
  }
  return s;
}

const hashPassword   = (plain)       => bcrypt.hash(plain, BCRYPT_COST);
const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

/**
 * A throwaway bcrypt hash used to equalise response timing on login attempts
 * for emails that do not exist. Without this, a missing user returns in ~0ms
 * while a real user costs a full bcrypt compare (~300ms) — which tells an
 * attacker which emails are registered.
 *
 * Computed lazily and memoised so the ~300ms cost lands on the first failed
 * login rather than on every process boot.
 */
let _dummyHash = null;
function getDummyHash() {
  if (!_dummyHash) {
    _dummyHash = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), BCRYPT_COST);
  }
  return _dummyHash;
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, tv: user.token_version },
    getSecret(),
    {
      expiresIn: TTL,
      issuer:    ISSUER,
      audience:  AUDIENCE,
      algorithm: 'HS256',
    }
  );
}

/**
 * Throws on any invalid token. Callers must treat every throw identically —
 * never surface the library's message, which distinguishes expired from
 * malformed from bad-signature.
 */
function verifyToken(token) {
  // `algorithms` is pinned deliberately. Without it, jsonwebtoken will honour
  // the alg named in the token header, which allows alg:"none" forgery and
  // HS256/RS256 confusion attacks.
  return jwt.verify(token, getSecret(), {
    algorithms: ['HS256'],
    issuer:     ISSUER,
    audience:   AUDIENCE,
  });
}

module.exports = {
  getSecret,
  hashPassword,
  verifyPassword,
  getDummyHash,
  signToken,
  verifyToken,
  BCRYPT_COST,
  MIN_PASSWORD_LENGTH,
  TTL,
  ISSUER,
  AUDIENCE,
};
