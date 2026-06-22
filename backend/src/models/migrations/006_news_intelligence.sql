-- ── 006 News Intelligence Center ─────────────────────────────────────────────
-- news_items: raw ingested items + AI-derived scoring on same row (lean schema)
-- news_stock_mapping: join table for efficient per-symbol queries
-- All statements use IF NOT EXISTS / idempotent guards — safe to re-run.

CREATE TABLE IF NOT EXISTS news_items (
  id                   BIGSERIAL PRIMARY KEY,

  -- Source identification
  source               TEXT        NOT NULL,  -- 'NSE', 'BSE', 'RSS:moneycontrol', etc.
  source_url           TEXT,
  content_hash         TEXT        UNIQUE NOT NULL,  -- SHA-256 of source+title; dedup key

  -- Raw content (headline + snippet only — no full article text)
  title                TEXT        NOT NULL,
  summary              TEXT,
  link                 TEXT,

  -- Stock / company linkage (primary — set at ingestion time from NSE data)
  symbol               TEXT,        -- NSE symbol e.g. RELIANCE (no .NS suffix)
  company_name         TEXT,
  category             TEXT,        -- Earnings | Bulk Deal | Insider Buying | ...

  -- Timestamps
  published_at         TIMESTAMPTZ,
  fetched_at           TIMESTAMPTZ DEFAULT NOW(),

  -- ── AI scoring columns (NULL until scored by Claude) ─────────────────────
  impact_score         SMALLINT,    -- 0-100; NULL = not yet scored
  confidence           SMALLINT,    -- 0-100
  trading_relevance    SMALLINT,    -- 0-100
  sentiment            TEXT,        -- 'Bullish' | 'Bearish' | 'Neutral'
  urgency              TEXT,        -- 'Immediate' | 'Short-Term' | 'Long-Term' | 'Background'
  why_it_matters       TEXT,        -- 1-2 sentence human-readable reasoning
  trading_implication  TEXT,        -- 1-2 sentence actionable takeaway
  affected_sectors     TEXT[],      -- validated sector names from our SECTORS list
  affected_stocks      TEXT[],      -- validated NSE symbols from our UNIVERSE (no .NS)
  ai_scored_at         TIMESTAMPTZ,
  ai_model             TEXT         -- e.g. 'claude-sonnet-4-6'
);

-- Stock-level join table for fast per-symbol queries
CREATE TABLE IF NOT EXISTS news_stock_mapping (
  id          BIGSERIAL PRIMARY KEY,
  news_id     BIGINT      NOT NULL REFERENCES news_items(id) ON DELETE CASCADE,
  symbol      TEXT        NOT NULL,   -- NSE symbol without .NS
  relevance   TEXT        NOT NULL DEFAULT 'mentioned',  -- 'primary' | 'mentioned'
  UNIQUE(news_id, symbol)
);

-- Indexes for the query patterns we need
CREATE INDEX IF NOT EXISTS idx_news_published_at       ON news_items(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_symbol             ON news_items(symbol);
CREATE INDEX IF NOT EXISTS idx_news_impact             ON news_items(impact_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_news_category           ON news_items(category);
CREATE INDEX IF NOT EXISTS idx_news_sentiment          ON news_items(sentiment);
CREATE INDEX IF NOT EXISTS idx_news_fetched_at         ON news_items(fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_stock_map_symbol   ON news_stock_mapping(symbol);
CREATE INDEX IF NOT EXISTS idx_news_stock_map_news_id  ON news_stock_mapping(news_id);
