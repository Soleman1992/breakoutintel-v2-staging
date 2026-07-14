// ── Holdings Auth — unit tests ───────────────────────────────────────────────
// Uses Node's built-in test runner (node:test) — no new dev dependencies.
//
//   npm test
//
// No database required: the middleware is exercised against a fake db whose
// query() returns whatever the test needs.

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt    = require('jsonwebtoken');

// Must be set before the auth module reads it. 64 hex chars, as in production.
const TEST_SECRET = 'a'.repeat(64);
process.env.HOLDINGS_JWT_SECRET = TEST_SECRET;

const {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  getSecret,
  MIN_PASSWORD_LENGTH,
} = require('../src/auth/holdingsAuth');
const requireHoldingsAuth = require('../src/auth/requireHoldingsAuth');

const USER = { id: '11111111-2222-3333-4444-555555555555', token_version: 0 };

// ── Fakes ────────────────────────────────────────────────────────────────────
function fakeDb(rows) {
  return { query: async () => ({ rows }) };
}
function failingDb() {
  return { query: async () => { throw new Error('connection refused'); } };
}
function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b)   { this.body = b; return this; },
  };
}

// ── Password hashing ─────────────────────────────────────────────────────────
describe('password hashing', () => {
  test('a correct password verifies', async () => {
    const hash = await hashPassword('correct-horse-battery');
    assert.equal(await verifyPassword('correct-horse-battery', hash), true);
  });

  test('a wrong password does not verify', async () => {
    const hash = await hashPassword('correct-horse-battery');
    assert.equal(await verifyPassword('wrong-password-here', hash), false);
  });

  test('the same password hashes differently each time (salted)', async () => {
    const a = await hashPassword('correct-horse-battery');
    const b = await hashPassword('correct-horse-battery');
    assert.notEqual(a, b);
  });

  test('the minimum password length is 12', () => {
    assert.equal(MIN_PASSWORD_LENGTH, 12);
  });
});

// ── Secret handling ──────────────────────────────────────────────────────────
describe('HOLDINGS_JWT_SECRET', () => {
  beforeEach(() => { process.env.HOLDINGS_JWT_SECRET = TEST_SECRET; });

  test('throws when the secret is absent — the module must fail closed', () => {
    delete process.env.HOLDINGS_JWT_SECRET;
    assert.throws(() => getSecret(), /HOLDINGS_JWT_SECRET missing/);
    process.env.HOLDINGS_JWT_SECRET = TEST_SECRET;
  });

  test('throws when the secret is too short — no weak-key fallback', () => {
    process.env.HOLDINGS_JWT_SECRET = 'short';
    assert.throws(() => getSecret(), /too short/);
    process.env.HOLDINGS_JWT_SECRET = TEST_SECRET;
  });
});

// ── Token signing / verification ─────────────────────────────────────────────
describe('token verification', () => {
  test('a signed token round-trips with its claims intact', () => {
    const claims = verifyToken(signToken(USER));
    assert.equal(claims.sub, USER.id);
    assert.equal(claims.tv, 0);
  });

  test('rejects a token forged with alg:none', () => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const forged =
      `${b64({ alg: 'none', typ: 'JWT' })}.` +
      `${b64({ sub: USER.id, tv: 0, iss: 'breakoutintel-holdings', aud: 'holdings-intel' })}.`;
    assert.throws(() => verifyToken(forged));
  });

  test('rejects a token signed with a different secret', () => {
    const other = jwt.sign({ sub: USER.id, tv: 0 }, 'b'.repeat(64), {
      algorithm: 'HS256', issuer: 'breakoutintel-holdings', audience: 'holdings-intel',
    });
    assert.throws(() => verifyToken(other));
  });

  test('rejects a token with the wrong issuer', () => {
    const wrong = jwt.sign({ sub: USER.id, tv: 0 }, TEST_SECRET, {
      algorithm: 'HS256', issuer: 'somebody-else', audience: 'holdings-intel',
    });
    assert.throws(() => verifyToken(wrong));
  });

  test('rejects an expired token', () => {
    const expired = jwt.sign({ sub: USER.id, tv: 0 }, TEST_SECRET, {
      algorithm: 'HS256', issuer: 'breakoutintel-holdings',
      audience: 'holdings-intel', expiresIn: '-1s',
    });
    assert.throws(() => verifyToken(expired));
  });
});

// ── Middleware ───────────────────────────────────────────────────────────────
describe('requireHoldingsAuth middleware', () => {
  test('401s when no Authorization header is present', async () => {
    const res = fakeRes();
    let nexted = false;
    await requireHoldingsAuth(fakeDb([]))({ headers: {} }, res, () => { nexted = true; });

    assert.equal(res.statusCode, 401);
    assert.equal(nexted, false);
  });

  test('401s on a malformed token, without leaking why', async () => {
    const res = fakeRes();
    await requireHoldingsAuth(fakeDb([]))(
      { headers: { authorization: 'Bearer not-a-jwt' } }, res, () => {}
    );

    assert.equal(res.statusCode, 401);
    // Generic message only — never "jwt malformed" / "jwt expired".
    assert.equal(res.body.error, 'Invalid or expired token');
  });

  test('IGNORES x-user-id — the header the rest of the app trusts', async () => {
    const res = fakeRes();
    let nexted = false;
    const req = { headers: { 'x-user-id': USER.id } };   // no Bearer token

    await requireHoldingsAuth(fakeDb([{ ...USER, email: 'a@b.com' }]))(
      req, res, () => { nexted = true; }
    );

    // Must NOT authenticate, and must have stripped the header outright.
    assert.equal(res.statusCode, 401);
    assert.equal(nexted, false);
    assert.equal(req.headers['x-user-id'], undefined);
  });

  test('401s when the user no longer exists', async () => {
    const res = fakeRes();
    await requireHoldingsAuth(fakeDb([]))(
      { headers: { authorization: `Bearer ${signToken(USER)}` } }, res, () => {}
    );

    assert.equal(res.statusCode, 401);
  });

  test('401s when token_version is stale (i.e. after logout)', async () => {
    const token = signToken(USER);                       // minted at tv = 0
    const res = fakeRes();
    let nexted = false;

    // DB now says tv = 1 — logout bumped it.
    await requireHoldingsAuth(fakeDb([{ ...USER, token_version: 1, email: 'a@b.com' }]))(
      { headers: { authorization: `Bearer ${token}` } }, res, () => { nexted = true; }
    );

    assert.equal(res.statusCode, 401);
    assert.equal(nexted, false);
  });

  test('503s (not 401) when the auth DB is unreachable', async () => {
    const res = fakeRes();
    await requireHoldingsAuth(failingDb())(
      { headers: { authorization: `Bearer ${signToken(USER)}` } }, res, () => {}
    );

    assert.equal(res.statusCode, 503);
  });

  test('passes a valid token through and attaches the identity', async () => {
    const req = { headers: { authorization: `Bearer ${signToken(USER)}` } };
    const res = fakeRes();
    let nexted = false;

    await requireHoldingsAuth(fakeDb([{ ...USER, email: 'a@b.com', name: 'Sole' }]))(
      req, res, () => { nexted = true; }
    );

    assert.equal(nexted, true);
    assert.equal(res.statusCode, null);
    assert.equal(req.holdingsUser.id, USER.id);
    assert.equal(req.holdingsUser.email, 'a@b.com');
  });
});
