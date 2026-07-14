-- 013_broker_holdings.sql
-- Personal Portfolio Intelligence — Phase 1 (file import only, no broker API).
--
-- DISTINCT FROM the existing 'positions' / 'trade_history' tables, which are a
-- scanner trade journal (manually-entered breakout ideas tracked to stop/target).
-- These tables hold REAL broker holdings imported from Zerodha Console exports.
-- Nothing here reads, writes, or alters any existing table.
--
-- Phase 1 stores NO broker credentials: there is no broker_connections table and
-- no encryption key. A future Kite/Upstox adapter adds that in its own migration;
-- 'kite_api' is already permitted in the source CHECKs so that phase needs no
-- constraint changes.
--
-- FKs point at holdings_users (012), NOT the legacy no-auth `users` table.
-- Idempotent — safe to re-run on every startup.

-- ── Holdings ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS broker_holdings (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES holdings_users(id) ON DELETE CASCADE,
  broker            TEXT NOT NULL DEFAULT 'zerodha',
  source            TEXT NOT NULL DEFAULT 'file_import'
                      CHECK (source IN ('file_import','manual','kite_api')),

  symbol            TEXT NOT NULL,                 -- as the broker writes it (may carry -T/-XT/-E)
  exchange          TEXT NOT NULL DEFAULT 'NSE' CHECK (exchange IN ('NSE','BSE')),

  -- The Zerodha holdings statement has NO exchange column. Exchange is resolved
  -- against UNIVERSE_MAP, then by probing for a live quote. Record HOW we decided,
  -- so an unresolved symbol surfaces in the UI instead of silently having no price.
  exchange_source   TEXT NOT NULL DEFAULT 'assumed'
                      CHECK (exchange_source IN ('universe','probe','assumed','manual')),

  isin              TEXT,
  company_name      TEXT,

  -- Two sector taxonomies, deliberately kept apart:
  --   broker_sector — Zerodha's own ('SOFTWARE SERVICES', 'AUTO ANCILLARY', ...)
  --   sector        — the app's UNIVERSE taxonomy, so allocation views line up
  --                   with the rest of BreakoutIntel. Either may be NULL.
  broker_sector     TEXT,
  sector            TEXT,
  industry          TEXT,
  cap_category      TEXT,

  -- ETFs are present in real exports (ISINs beginning INF). Treating them as
  -- equities would corrupt sector allocation and any PE/ROE-style analysis.
  asset_class       TEXT NOT NULL DEFAULT 'EQUITY'
                      CHECK (asset_class IN ('EQUITY','ETF','MF','OTHER')),

  -- Zerodha splits quantity across five columns. Keep the components rather than
  -- flattening them: pledged shares are still owned, and a flattened total makes
  -- a pledge look like a sale on the next import.
  quantity          NUMERIC(18,4) NOT NULL DEFAULT 0,   -- the total we transact on
  qty_available     NUMERIC(18,4) NOT NULL DEFAULT 0,
  qty_long_term     NUMERIC(18,4) NOT NULL DEFAULT 0,
  qty_discrepant    NUMERIC(18,4) NOT NULL DEFAULT 0,
  qty_pledged_margin NUMERIC(18,4) NOT NULL DEFAULT 0,
  qty_pledged_loan  NUMERIC(18,4) NOT NULL DEFAULT 0,

  -- avg_buy_price is what the broker DISPLAYS. It is NOT a reliable cost basis:
  -- after a corporate action Zerodha's displayed average and the average implied
  -- by its own P&L can disagree (observed on LLOYDSENGG: displayed 70.6420,
  -- implied 85.3490 — an 8,618 rupee gap on one row alone).
  --
  -- invested_value is therefore STORED, not derived. It is a historical fact as
  -- of the statement — invested = (quantity x prev_close) - unrealized_pnl —
  -- and must not move when live prices move. Everything downstream (current
  -- value, live P&L, returns) is computed against THIS, never against
  -- quantity x avg_buy_price.
  avg_buy_price     NUMERIC(18,4) NOT NULL DEFAULT 0,
  invested_value    NUMERIC(20,4) NOT NULL DEFAULT 0,

  -- As reported by the broker at statement time. Kept for reconciliation, so an
  -- import can be checked against the file's own summary block.
  stmt_prev_close   NUMERIC(18,4),
  stmt_unrealized_pnl     NUMERIC(20,4),
  stmt_unrealized_pnl_pct NUMERIC(12,4),
  stmt_as_of        DATE,

  -- Live price snapshot. Current value, live P&L and portfolio weight are
  -- COMPUTED IN THE SERVICE, never stored — storing them guarantees stale numbers.
  last_price        NUMERIC(18,4),
  day_change_pct    NUMERIC(10,4),
  last_price_at     TIMESTAMPTZ,
  price_ok          BOOLEAN NOT NULL DEFAULT FALSE,   -- FALSE = no live quote

  is_active         BOOLEAN NOT NULL DEFAULT TRUE,    -- FALSE = gone from latest import
  raw_data          JSONB,                            -- whitelisted source fields only

  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (user_id, broker, symbol, exchange)          -- upsert key for re-import
);

CREATE INDEX IF NOT EXISTS idx_broker_holdings_user_active
  ON broker_holdings (user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_broker_holdings_symbol
  ON broker_holdings (symbol);
CREATE INDEX IF NOT EXISTS idx_broker_holdings_sector
  ON broker_holdings (user_id, sector);
CREATE INDEX IF NOT EXISTS idx_broker_holdings_asset_class
  ON broker_holdings (user_id, asset_class);

-- ── Transactions (append-only ledger: trades, dividends, corporate actions) ──
CREATE TABLE IF NOT EXISTS broker_transactions (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES holdings_users(id) ON DELETE CASCADE,
  broker            TEXT NOT NULL DEFAULT 'zerodha',
  source            TEXT NOT NULL DEFAULT 'file_import'
                      CHECK (source IN ('file_import','manual','kite_api')),

  -- The broker's own trade/order id from the tradebook export. Makes re-import
  -- idempotent: re-uploading the same file cannot double-count a trade.
  -- Postgres treats NULLs as distinct, so manual entries are never deduped.
  external_id       TEXT,

  symbol            TEXT NOT NULL,
  exchange          TEXT NOT NULL DEFAULT 'NSE' CHECK (exchange IN ('NSE','BSE')),
  isin              TEXT,

  txn_type          TEXT NOT NULL
                      CHECK (txn_type IN ('BUY','SELL','DIVIDEND','BONUS','SPLIT','CHARGE')),
  quantity          NUMERIC(18,4),
  price             NUMERIC(18,4),
  amount            NUMERIC(20,4),                  -- signed net cash impact
  fees              NUMERIC(18,4),

  traded_at         TIMESTAMPTZ NOT NULL,
  notes             TEXT,
  raw_data          JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (user_id, broker, external_id)
);

CREATE INDEX IF NOT EXISTS idx_broker_txns_user_time
  ON broker_transactions (user_id, traded_at DESC);
CREATE INDEX IF NOT EXISTS idx_broker_txns_symbol
  ON broker_transactions (user_id, symbol);
CREATE INDEX IF NOT EXISTS idx_broker_txns_type
  ON broker_transactions (user_id, txn_type);

-- ── Cash balance history ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS broker_cash_snapshots (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES holdings_users(id) ON DELETE CASCADE,
  broker            TEXT NOT NULL DEFAULT 'zerodha',
  source            TEXT NOT NULL DEFAULT 'file_import'
                      CHECK (source IN ('file_import','manual','kite_api')),

  cash_balance      NUMERIC(20,4) NOT NULL,
  as_of             DATE NOT NULL,                  -- one row per day per broker
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (user_id, broker, as_of)                   -- re-import overwrites the day
);

CREATE INDEX IF NOT EXISTS idx_broker_cash_user_time
  ON broker_cash_snapshots (user_id, as_of DESC);

-- ── Import audit log ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS holdings_sync_audit (
  id                BIGSERIAL PRIMARY KEY,
  user_id           UUID NOT NULL REFERENCES holdings_users(id) ON DELETE CASCADE,
  broker            TEXT NOT NULL DEFAULT 'zerodha',

  operation         TEXT NOT NULL
                      CHECK (operation IN ('holdings_import','tradebook_import','funds_import',
                                           'manual_edit','purge','kite_sync')),
  status            TEXT NOT NULL
                      CHECK (status IN ('success','partial','failed')),

  -- Counts and metadata ONLY. Deliberately no payload column: audit rows must
  -- never be capable of holding financial or credential data.
  rows_seen         INTEGER NOT NULL DEFAULT 0,
  rows_imported     INTEGER NOT NULL DEFAULT 0,
  rows_skipped      INTEGER NOT NULL DEFAULT 0,
  error_message     TEXT,
  file_name         TEXT,
  file_checksum     TEXT,                           -- sha256; detects a re-upload

  -- Did the imported rows reconcile against the file's own summary block?
  -- A silent mismatch here is how a portfolio ends up quietly wrong.
  reconciled        BOOLEAN,
  reconcile_note    TEXT,

  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at       TIMESTAMPTZ,
  duration_ms       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_holdings_audit_user_time
  ON holdings_sync_audit (user_id, started_at DESC);

CREATE OR REPLACE TRIGGER trg_broker_holdings_updated
  BEFORE UPDATE ON broker_holdings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
