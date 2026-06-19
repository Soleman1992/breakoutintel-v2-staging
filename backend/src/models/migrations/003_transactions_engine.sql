-- Migration 003: Transactions Engine
-- Adds realized P&L tracking to positions and enriches trade_history
-- Run: psql -U biuser -d breakoutintel -f 003_transactions_engine.sql

-- ── positions: add realized P&L + close tracking ──────────────────────────────
ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS realized_pnl  DECIMAL(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS closed_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS exit_price    DECIMAL(12,2);

-- ── trade_history: add position link + enriched fields ───────────────────────
ALTER TABLE trade_history
  ADD COLUMN IF NOT EXISTS position_id       UUID REFERENCES positions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS exchange          VARCHAR(10),
  ADD COLUMN IF NOT EXISTS company_name      VARCHAR(150),
  ADD COLUMN IF NOT EXISTS transaction_type  VARCHAR(20)
    CHECK (transaction_type IN ('BUY','SELL','PARTIAL_SELL')),
  ADD COLUMN IF NOT EXISTS total_value       DECIMAL(14,2),
  ADD COLUMN IF NOT EXISTS notes             TEXT;

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_trade_history_position_id
  ON trade_history(position_id);

CREATE INDEX IF NOT EXISTS idx_trade_history_user_executed
  ON trade_history(user_id, executed_at DESC);

CREATE INDEX IF NOT EXISTS idx_positions_user_status
  ON positions(user_id, status);
