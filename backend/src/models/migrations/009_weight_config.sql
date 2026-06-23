-- 009_weight_config.sql
-- Tracks engine weight configurations over time for drift monitoring.
-- Each quarterly re-fit writes a new row; drift alerts trigger when
-- any weight moves more than ±5% from the prior version.

CREATE TABLE IF NOT EXISTS weight_config (
  id           BIGSERIAL    PRIMARY KEY,
  version      TEXT         NOT NULL UNIQUE,
  weights      JSONB        NOT NULL,
  fitted_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  drift_alert  BOOLEAN      NOT NULL DEFAULT FALSE,
  drift_detail JSONB,
  notes        TEXT
);

-- Baseline theory-driven priors (v1.0)
INSERT INTO weight_config (version, weights, notes)
VALUES (
  'v1.0-baseline',
  '{"emavol":0.20,"lux":0.20,"trendspider":0.20,"chartprime":0.22,"algoalpha":0.18}',
  'Theory-based priors. ChartPrime weighted highest: most independent engine. AlgoAlpha lowest: early-firing, false-positive prone. Re-fit quarterly via walk-forward on Nifty 500 history. Alert if any weight drifts >±5%.'
) ON CONFLICT (version) DO NOTHING;
