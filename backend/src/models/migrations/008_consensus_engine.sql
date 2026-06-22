-- 008_consensus_engine.sql
-- Consensus engine tables for the BreakoutIntel ranking pipeline.
-- Idempotent: safe to run multiple times (IF NOT EXISTS guards throughout).
-- Runs automatically on startup via migrate.js.

-- ── scan_runs: one row per orchestrator scan execution ────────────────────────
-- Tracks scan metadata, universe size, and tier distribution per run.

CREATE TABLE IF NOT EXISTS scan_runs (
  run_id         TEXT         PRIMARY KEY,
  universe_size  INTEGER      NOT NULL DEFAULT 0,
  accepted       INTEGER      NOT NULL DEFAULT 0,
  rejected       INTEGER      NOT NULL DEFAULT 0,
  tier_counts    JSONB        NOT NULL DEFAULT '{}',
  completed_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── consensus_results: per-stock per-run ranking record ───────────────────────
-- One row per (run_id, ticker). ON CONFLICT upserts keep latest values.
-- JSONB columns (quality_dims, engine_scores, explain_data) allow schema
-- evolution without new migrations as engines change.

CREATE TABLE IF NOT EXISTS consensus_results (
  id                      BIGSERIAL    PRIMARY KEY,
  run_id                  TEXT         NOT NULL REFERENCES scan_runs(run_id) ON DELETE CASCADE,
  ticker                  TEXT         NOT NULL,
  category                TEXT         NOT NULL CHECK (category IN ('LARGECAP','MIDCAP','SMALLCAP','MICROCAP')),
  sector                  TEXT,
  last_price              NUMERIC(12,2),

  -- Core ranking fields
  consensus_score         SMALLINT     NOT NULL,
  tier                    TEXT         NOT NULL CHECK (tier IN ('S','A','B','C','REJECT')),
  direction               TEXT         NOT NULL CHECK (direction IN ('long','short','neutral')),

  -- Consensus metrics
  agreement_pct           SMALLINT,
  confidence_score        SMALLINT,
  institutional_prob      SMALLINT,
  trend_continuation_prob SMALLINT,
  breakout_prob           SMALLINT,
  false_bo_risk           SMALLINT,

  -- JSONB payloads
  quality_dims            JSONB        NOT NULL DEFAULT '{}',
  engine_scores           JSONB        NOT NULL DEFAULT '{}',
  explain_data            JSONB        NOT NULL DEFAULT '{}',

  created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  UNIQUE (run_id, ticker)
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
-- Covering index for the primary UI query: latest run, sort by score, filter by tier/category

CREATE INDEX IF NOT EXISTS idx_cr_run_score
  ON consensus_results (run_id, consensus_score DESC);

CREATE INDEX IF NOT EXISTS idx_cr_run_tier
  ON consensus_results (run_id, tier);

CREATE INDEX IF NOT EXISTS idx_cr_run_category
  ON consensus_results (run_id, category, consensus_score DESC);

CREATE INDEX IF NOT EXISTS idx_cr_ticker_time
  ON consensus_results (ticker, created_at DESC);

-- GIN index on flags array inside explain_data (enables flag-based filtering)
CREATE INDEX IF NOT EXISTS idx_cr_explain_flags
  ON consensus_results USING GIN ((explain_data -> 'keyFlags'));

-- ── Helper view: latest run ranking ──────────────────────────────────────────
-- Convenience view that always shows the most recent scan's results.
-- Used by Phase 7 API routes to avoid passing run_id in every query.

CREATE OR REPLACE VIEW latest_rankings AS
  SELECT cr.*
  FROM   consensus_results cr
  JOIN   scan_runs sr ON cr.run_id = sr.run_id
  WHERE  sr.completed_at = (SELECT MAX(completed_at) FROM scan_runs);
