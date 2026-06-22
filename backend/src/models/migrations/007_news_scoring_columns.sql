-- ── 007 News Intelligence — add AI scoring columns (idempotent) ───────────────
-- Root cause: 006 used CREATE TABLE IF NOT EXISTS which was silently skipped
-- because news_items already existed in Supabase without the AI columns.
-- This migration adds each missing column safely with ADD COLUMN IF NOT EXISTS.
-- Safe to run multiple times — IF NOT EXISTS guard on every statement.

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

-- Ensure news_stock_mapping exists (may also have been skipped)
CREATE TABLE IF NOT EXISTS news_stock_mapping (
  id          BIGSERIAL PRIMARY KEY,
  news_id     BIGINT      NOT NULL REFERENCES news_items(id) ON DELETE CASCADE,
  symbol      TEXT        NOT NULL,
  relevance   TEXT        NOT NULL DEFAULT 'mentioned',
  UNIQUE(news_id, symbol)
);

-- Ensure all indexes exist (CREATE INDEX IF NOT EXISTS is idempotent)
CREATE INDEX IF NOT EXISTS idx_news_published_at      ON news_items(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_symbol            ON news_items(symbol);
CREATE INDEX IF NOT EXISTS idx_news_impact            ON news_items(impact_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_news_category          ON news_items(category);
CREATE INDEX IF NOT EXISTS idx_news_sentiment         ON news_items(sentiment);
CREATE INDEX IF NOT EXISTS idx_news_fetched_at        ON news_items(fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_stock_map_symbol  ON news_stock_mapping(symbol);
CREATE INDEX IF NOT EXISTS idx_news_stock_map_news_id ON news_stock_mapping(news_id);
