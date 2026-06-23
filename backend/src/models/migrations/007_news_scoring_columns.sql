-- ── 007 News Intelligence — AI scoring columns (idempotent safety net) ─────────
--
-- HISTORY: This was added when 006's CREATE TABLE was silently skipped on
--   existing DBs. It used ADD COLUMN IF NOT EXISTS for AI scoring columns.
--
-- CURRENT ROLE: Migration 011 + updated schema.sql handle the real repair.
--   This file remains as a final-layer safety net — pure no-ops on any DB
--   that has gone through 011.
--
-- Idempotent: safe to re-run on every startup.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE news_items ADD COLUMN IF NOT EXISTS impact_score         SMALLINT;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS confidence           SMALLINT;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS trading_relevance    SMALLINT;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS urgency              TEXT;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS why_it_matters       TEXT;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS trading_implication  TEXT;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS affected_sectors     TEXT[];
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS affected_stocks      TEXT[];
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS ai_scored_at         TIMESTAMPTZ;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS ai_model             TEXT;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS source_url           TEXT;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS content_hash         TEXT;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS title                TEXT;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS summary              TEXT;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS link                 TEXT;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS company_name         TEXT;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS fetched_at           TIMESTAMPTZ;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS symbol               TEXT;

-- Ensure join table exists (no-op if 011 already created it correctly)
CREATE TABLE IF NOT EXISTS news_stock_mapping (
  id          BIGSERIAL    PRIMARY KEY,
  news_id     BIGINT       NOT NULL REFERENCES news_items(id) ON DELETE CASCADE,
  symbol      TEXT         NOT NULL,
  relevance   TEXT         NOT NULL DEFAULT 'mentioned',
  UNIQUE(news_id, symbol)
);

CREATE INDEX IF NOT EXISTS idx_news_published_at      ON news_items(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_fetched_at        ON news_items(fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_symbol            ON news_items(symbol);
CREATE INDEX IF NOT EXISTS idx_news_impact            ON news_items(impact_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_news_category          ON news_items(category);
CREATE INDEX IF NOT EXISTS idx_news_sentiment         ON news_items(sentiment);
CREATE INDEX IF NOT EXISTS idx_news_stock_map_symbol  ON news_stock_mapping(symbol);
CREATE INDEX IF NOT EXISTS idx_news_stock_map_news_id ON news_stock_mapping(news_id);
