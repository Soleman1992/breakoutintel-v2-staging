-- 010_scanner_alerts.sql
-- System-generated scanner alerts table.
-- Separate from the user-defined 'alerts' table.
-- Idempotent — safe to re-run on every startup.

CREATE TABLE IF NOT EXISTS scanner_alerts (
  id              BIGSERIAL PRIMARY KEY,
  alert_type      TEXT        NOT NULL,  -- 'breakout' | 'volume' | 'news'
  symbol          TEXT,
  company_name    TEXT,
  sector          TEXT,
  industry        TEXT,
  cap             TEXT,
  signal_source   TEXT,                  -- 'Breakout Scanner' | 'Volume Scanner' | 'News Intelligence'
  alert_title     TEXT        NOT NULL,
  alert_body      TEXT,
  impact_score    INTEGER,               -- 0–100
  confidence      INTEGER,               -- 0–100
  urgency         TEXT,                  -- 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  sentiment       TEXT,                  -- 'Bullish' | 'Bearish' | 'Neutral'
  vol_ratio       NUMERIC(8,2),
  avg_volume      BIGINT,
  cur_volume      BIGINT,
  cmp             NUMERIC(12,2),
  entry_price     NUMERIC(12,2),
  stop_price      NUMERIC(12,2),
  target1_price   NUMERIC(12,2),
  rs_score        INTEGER,
  reasons         TEXT[],
  dedup_key       TEXT        UNIQUE,    -- prevents duplicate alerts within time window
  triggered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ,
  raw_data        JSONB
);

CREATE INDEX IF NOT EXISTS idx_scanner_alerts_type
  ON scanner_alerts (alert_type);

CREATE INDEX IF NOT EXISTS idx_scanner_alerts_symbol
  ON scanner_alerts (symbol);

CREATE INDEX IF NOT EXISTS idx_scanner_alerts_triggered_at
  ON scanner_alerts (triggered_at DESC);

CREATE INDEX IF NOT EXISTS idx_scanner_alerts_urgency
  ON scanner_alerts (urgency);

CREATE INDEX IF NOT EXISTS idx_scanner_alerts_impact
  ON scanner_alerts (impact_score DESC NULLS LAST);
