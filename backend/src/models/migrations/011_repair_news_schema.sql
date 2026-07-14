-- ── 011 Repair News Schema ────────────────────────────────────────────────────
--
-- ROOT CAUSE (documented):
--   schema.sql created news_items with id UUID PRIMARY KEY (old design).
--   Migration 006 then tried to create news_stock_mapping with:
--     news_id BIGINT NOT NULL REFERENCES news_items(id)
--   PostgreSQL rejects a FK from BIGINT → UUID: "cannot be implemented".
--   Both 006 and 007 failed every startup because of this type mismatch.
--   As a result:
--     - news_stock_mapping was never created
--     - columns source_url, content_hash, title, link, company_name, fetched_at
--       were never added (they are not in schema.sql)
--   newsIntelligenceService.js INSERT references all these missing columns
--   → 40+ "[News] Upsert error: column source_url does not exist" per minute
--
-- WHY DROP + RECREATE is safe:
--   news_items is a pure feed cache (NSE announcements + RSS headlines).
--   It contains NO user-generated data. Content is re-fetched and re-inserted
--   automatically within 90 seconds of startup by the news refresh cycle.
--   Wiping and rebuilding is the correct fix — no data loss for the user.
--
-- IDEMPOTENT: Safe to run on every startup.
--   - The drop below is CONDITIONAL — it fires only on the broken legacy schema
--   - All CREATE statements use IF NOT EXISTS
--   - On an already-repaired database, this file is a true no-op
--
-- NOTE (fix): the drops used to be unconditional `DROP TABLE IF EXISTS`, which
-- is NOT a no-op on a repaired database — it drops the good table too. Because
-- migrations run on every boot, that wiped the news cache on every restart, and
-- the feed only came back if the 90s refresh happened to succeed. On a free tier
-- that restarts whenever it spins down, news was empty much of the time.
-- The drop is now gated on the actual defect (id of type uuid), so it repairs a
-- legacy database exactly as before and leaves a correct one untouched.
--
-- Run order in migrate.js: after 010, before any future migrations.
-- ─────────────────────────────────────────────────────────────────────────────

-- Steps 1 & 2: Drop ONLY if news_items still has the broken UUID id.
-- A repaired database (id = BIGSERIAL) falls straight through, keeping its data.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'news_items'
       AND column_name  = 'id'
       AND data_type    = 'uuid'
  ) THEN
    RAISE NOTICE '[011] Legacy news_items (uuid id) found — rebuilding.';
    DROP TABLE IF EXISTS news_stock_mapping;   -- join table first (FK order)
    DROP TABLE IF EXISTS news_items;
  END IF;
END $$;

-- Step 3: Recreate news_items with the correct schema matching newsIntelligence.js
--   id           BIGSERIAL          — matches news_stock_mapping.news_id BIGINT FK
--   content_hash TEXT UNIQUE NOT NULL — SHA-256 dedup key (was missing entirely)
--   title        TEXT NOT NULL      — service uses 'title' (old schema had 'headline')
--   source_url   TEXT               — service field (old schema had 'url')
--   link         TEXT               — article link (separate from source_url)
--   sentiment    TEXT               — no CHECK constraint (service uses Title Case)
--   fetched_at   TIMESTAMPTZ        — ingestion timestamp (was missing)
--   All AI scoring columns included (avoids any future 007-style ADD COLUMN patch)

CREATE TABLE IF NOT EXISTS news_items (
  id                   BIGSERIAL    PRIMARY KEY,

  -- Source identification
  source               TEXT         NOT NULL,
  source_url           TEXT,
  content_hash         TEXT         UNIQUE NOT NULL,

  -- Raw content
  title                TEXT         NOT NULL,
  summary              TEXT,
  link                 TEXT,

  -- Stock / company linkage
  symbol               TEXT,
  company_name         TEXT,
  category             TEXT,

  -- Timestamps
  published_at         TIMESTAMPTZ,
  fetched_at           TIMESTAMPTZ  DEFAULT NOW(),

  -- AI scoring (NULL until scored)
  impact_score         SMALLINT,
  confidence           SMALLINT,
  trading_relevance    SMALLINT,
  sentiment            TEXT,
  urgency              TEXT,
  why_it_matters       TEXT,
  trading_implication  TEXT,
  affected_sectors     TEXT[],
  affected_stocks      TEXT[],
  ai_scored_at         TIMESTAMPTZ,
  ai_model             TEXT
);

-- Step 4: Recreate news_stock_mapping — now FK works (BIGINT → BIGSERIAL)
CREATE TABLE IF NOT EXISTS news_stock_mapping (
  id          BIGSERIAL    PRIMARY KEY,
  news_id     BIGINT       NOT NULL REFERENCES news_items(id) ON DELETE CASCADE,
  symbol      TEXT         NOT NULL,
  relevance   TEXT         NOT NULL DEFAULT 'mentioned',
  UNIQUE(news_id, symbol)
);

-- Step 5: All indexes
CREATE INDEX IF NOT EXISTS idx_news_published_at      ON news_items(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_fetched_at        ON news_items(fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_symbol            ON news_items(symbol);
CREATE INDEX IF NOT EXISTS idx_news_impact            ON news_items(impact_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_news_category          ON news_items(category);
CREATE INDEX IF NOT EXISTS idx_news_sentiment         ON news_items(sentiment);
CREATE INDEX IF NOT EXISTS idx_news_content_hash      ON news_items(content_hash);
CREATE INDEX IF NOT EXISTS idx_news_stock_map_symbol  ON news_stock_mapping(symbol);
CREATE INDEX IF NOT EXISTS idx_news_stock_map_news_id ON news_stock_mapping(news_id);
