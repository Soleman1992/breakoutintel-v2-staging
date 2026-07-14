-- BreakoutIntel PostgreSQL Schema
-- Run: psql -U biuser -d breakoutintel -f schema.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Users ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email       VARCHAR(255) UNIQUE NOT NULL,
    password    VARCHAR(255) NOT NULL,
    name        VARCHAR(100),
    plan        VARCHAR(20) DEFAULT 'free' CHECK (plan IN ('free','trader','pro','institutional')),
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Watchlists ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS watchlists (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
    name        VARCHAR(100) NOT NULL DEFAULT 'My Watchlist',
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS watchlist_stocks (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    watchlist_id  UUID REFERENCES watchlists(id) ON DELETE CASCADE,
    symbol        VARCHAR(20) NOT NULL,
    added_at      TIMESTAMPTZ DEFAULT NOW(),
    notes         TEXT,
    UNIQUE(watchlist_id, symbol)
);

-- ── Portfolio Positions ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS positions (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
    symbol        VARCHAR(20) NOT NULL,
    quantity      DECIMAL(12, 2) NOT NULL,
    buy_price     DECIMAL(12, 2) NOT NULL,
    buy_date      DATE NOT NULL DEFAULT CURRENT_DATE,
    stop_loss     DECIMAL(12, 2),
    target1       DECIMAL(12, 2),
    target2       DECIMAL(12, 2),
    strategy      VARCHAR(50),
    status        VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open','closed','partial')),
    notes         TEXT,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Trade History ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trade_history (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
    symbol        VARCHAR(20) NOT NULL,
    action        VARCHAR(10) CHECK (action IN ('BUY','SELL','PARTIAL')),
    quantity      DECIMAL(12, 2) NOT NULL,
    price         DECIMAL(12, 2) NOT NULL,
    strategy      VARCHAR(50),
    pnl           DECIMAL(12, 2),
    pnl_pct       DECIMAL(8, 4),
    holding_days  INTEGER,
    executed_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ── Scanner Results (time-series) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scanner_results (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    symbol        VARCHAR(20) NOT NULL,
    pattern       VARCHAR(30) NOT NULL,
    category      VARCHAR(20) NOT NULL,
    cmp           DECIMAL(12, 2),
    entry         DECIMAL(12, 2),
    stop_loss     DECIMAL(12, 2),
    target1       DECIMAL(12, 2),
    target2       DECIMAL(12, 2),
    rr_ratio      DECIMAL(5, 2),
    confidence    SMALLINT,
    vol_ratio     DECIMAL(6, 2),
    rs_score      SMALLINT,
    scanned_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scanner_symbol ON scanner_results(symbol);
CREATE INDEX IF NOT EXISTS idx_scanner_scanned_at ON scanner_results(scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_scanner_confidence ON scanner_results(confidence DESC);

-- ── Market Data Cache (fallback when live feeds fail) ─────────────────────────
CREATE TABLE IF NOT EXISTS market_snapshots (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    symbol        VARCHAR(20) NOT NULL,
    price         DECIMAL(12, 2),
    change_pct    DECIMAL(8, 4),
    volume        BIGINT,
    open          DECIMAL(12, 2),
    high          DECIMAL(12, 2),
    low           DECIMAL(12, 2),
    prev_close    DECIMAL(12, 2),
    snapshot_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_snapshot_symbol_time ON market_snapshots(symbol, snapshot_at DESC);

-- ── Alerts ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alerts (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
    symbol        VARCHAR(20) NOT NULL,
    alert_type    VARCHAR(30) CHECK (alert_type IN ('breakout','volume','price_target','stop_loss','gap_up','gap_down','earnings')),
    trigger_value DECIMAL(12, 2),
    condition     VARCHAR(10) CHECK (condition IN ('above','below','crosses')),
    message       TEXT,
    is_triggered  BOOLEAN DEFAULT FALSE,
    triggered_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── News Intelligence ─────────────────────────────────────────────────────────
-- ── News Intelligence ────────────────────────────────────────────────────────
-- Schema matches newsIntelligenceService.js exactly.
-- id BIGSERIAL (not UUID) so news_stock_mapping FK works (BIGINT → BIGSERIAL).
-- content_hash TEXT UNIQUE NOT NULL — SHA-256 dedup key.
-- sentiment TEXT (no CHECK constraint) — service uses 'Bullish'/'Bearish'/'Neutral'.
-- See migration 011 for the history of why this was rewritten.
CREATE TABLE IF NOT EXISTS news_items (
    id                   BIGSERIAL    PRIMARY KEY,
    source               TEXT         NOT NULL,
    source_url           TEXT,
    content_hash         TEXT         UNIQUE NOT NULL,
    title                TEXT         NOT NULL,
    summary              TEXT,
    link                 TEXT,
    symbol               TEXT,
    company_name         TEXT,
    category             TEXT,
    published_at         TIMESTAMPTZ,
    fetched_at           TIMESTAMPTZ  DEFAULT NOW(),
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
CREATE INDEX IF NOT EXISTS idx_news_content_hash      ON news_items(content_hash);
CREATE INDEX IF NOT EXISTS idx_news_stock_map_symbol  ON news_stock_mapping(symbol);
CREATE INDEX IF NOT EXISTS idx_news_stock_map_news_id ON news_stock_mapping(news_id);

-- ── Strategies Config ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_strategies (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
    strategy_id   VARCHAR(50) NOT NULL,
    enabled       BOOLEAN DEFAULT TRUE,
    custom_params JSONB DEFAULT '{}',
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── API Keys (for future SaaS) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_keys (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
    key_hash      VARCHAR(255) UNIQUE NOT NULL,
    name          VARCHAR(100),
    last_used     TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    expires_at    TIMESTAMPTZ,
    is_active     BOOLEAN DEFAULT TRUE
);

-- ── Trigger: update updated_at ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_users_updated
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER trg_positions_updated
    BEFORE UPDATE ON positions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Seed: default admin user ──────────────────────────────────────────────────
-- Password: admin123 (change immediately in production!)
INSERT INTO users (email, password, name, plan)
VALUES ('admin@breakoutintel.com', '$2b$10$rQnY8vJ5D2mK3LpN6xT1e.8Y3xKZQ0W2cH7bP4mN9sVtA6wR1uX8K', 'Admin', 'pro')
ON CONFLICT (email) DO NOTHING;
