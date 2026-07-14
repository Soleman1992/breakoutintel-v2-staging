-- 011_holdings_auth.sql
-- Authentication for the Holdings module (/holdings-intel/*).
--
-- Deliberately a SEPARATE table from the existing `users`, which is seeded in
-- schema.sql with a well-known admin/admin123 credential and is used by the
-- no-auth placeholder flow (x-user-id header). Authenticating against `users`
-- would turn that dormant seed into a live login. Nothing here reads, writes,
-- or alters `users` or any other existing table.
--
-- Idempotent — safe to re-run on every startup.

CREATE TABLE IF NOT EXISTS holdings_users (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email              TEXT NOT NULL,
  password_hash      TEXT NOT NULL,          -- bcrypt, cost 12
  name               TEXT,

  -- Bumped on logout / password change. Every JWT carries the value it was
  -- minted with; a mismatch rejects the token. This is what makes stateless
  -- JWTs revocable without a session store.
  token_version      INTEGER NOT NULL DEFAULT 0,

  -- Brute-force backstop, in addition to the per-IP rate limiter on login.
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until       TIMESTAMPTZ,

  last_login_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Case-insensitive uniqueness without requiring the citext extension.
CREATE UNIQUE INDEX IF NOT EXISTS idx_holdings_users_email_lower
  ON holdings_users (LOWER(email));

-- Reuses the update_updated_at() function already defined in schema.sql.
CREATE OR REPLACE TRIGGER trg_holdings_users_updated
  BEFORE UPDATE ON holdings_users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- NO SEED ROW. The table ships empty; the only way a user comes into existence
-- is `npm run holdings:create-user`, run manually by the operator.
