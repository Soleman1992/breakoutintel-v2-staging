-- ── 006 News Intelligence Center (rewritten — idempotent safety net) ──────────
--
-- HISTORY: Original 006 used CREATE TABLE IF NOT EXISTS news_items with
--   id BIGSERIAL. But schema.sql already created news_items with id UUID,
--   so the CREATE was silently skipped. Then news_stock_mapping FK
--   (news_id BIGINT → news_items.id UUID) failed with "cannot be implemented".
--
-- CURRENT ROLE: schema.sql now creates news_items + news_stock_mapping with the
--   correct schema (BIGSERIAL id, all required columns). Migration 011 repairs
--   any existing DB that had the old schema. This file is now a pure
--   ADD COLUMN IF NOT EXISTS safety net — harmless no-ops on a correctly
--   migrated DB, insurance on any edge-case DB state.
--
-- Idempotent: safe to re-run on every startup.
-- ─────────────────────────────────────────────────────────────────────────────

-- Core columns (schema.sql should have created these; ADD IF NOT EXISTS = no-op)
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS source               TEXT;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS source_url           TEXT;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS content_hash         TEXT;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS title                TEXT;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS summary              TEXT;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS link                 TEXT;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS symbol               TEXT;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS company_name         TEXT;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS category             TEXT;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS published_at         TIMESTAMPTZ;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS fetched_at           TIMESTAMPTZ;

-- AI scoring columns
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS impact_score         SMALLINT;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS confidence           SMALLINT;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS trading_relevance    SMALLINT;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS sentiment            TEXT;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS urgency              TEXT;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS why_it_matters       TEXT;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS trading_implication  TEXT;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS affected_sectors     TEXT[];
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS affected_stocks      TEXT[];
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS ai_scored_at         TIMESTAMPTZ;
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS ai_model             TEXT;

-- Join table (schema.sql creates this; IF NOT EXISTS = no-op if already correct)
CREATE TABLE IF NOT EXISTS news_stock_mapping (
  id          BIGSERIAL    PRIMARY KEY,
  news_id     BIGINT       NOT NULL REFERENCES news_items(id) ON DELETE CASCADE,
  symbol      TEXT         NOT NULL,
  relevance   TEXT         NOT NULL DEFAULT 'mentioned',
  UNIQUE(news_id, symbol)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_news_published_at      ON news_items(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_fetched_at        ON news_items(fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_symbol            ON news_items(symbol);
CREATE INDEX IF NOT EXISTS idx_news_impact            ON news_items(impact_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_news_category          ON news_items(category);
CREATE INDEX IF NOT EXISTS idx_news_sentiment         ON news_items(sentiment);
CREATE INDEX IF NOT EXISTS idx_news_stock_map_symbol  ON news_stock_mapping(symbol);
CREATE INDEX IF NOT EXISTS idx_news_stock_map_news_id ON news_stock_mapping(news_id);
