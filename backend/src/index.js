require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const { createClient } = require('redis');

const app = express();
const server = http.createServer(app);

// ── PostgreSQL ────────────────────────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ── Redis (graceful — app works without Redis) ────────────────────────────────
const redis = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
  socket: { reconnectStrategy: (retries) => Math.min(retries * 100, 5000) },
});
redis.on('error', (err) => console.warn('[Redis] Not available:', err.message));

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 60000, max: 200, standardHeaders: true, legacyHeaders: false }));

// Serve the V2 dashboard frontend (index.html at repo root)
const path = require('path');
app.use(express.static(path.join(__dirname, '../../../')));

// ── Lazy-load services after Redis connects ───────────────────────────────────
let market = null;
let scanner = null;
let wss = null;

// ── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'breakoutintel-v2-api',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    redis: redis.isReady ? 'connected' : 'disconnected',
    database: db ? 'configured' : 'not configured',
  });
});

// ── Market Snapshot ───────────────────────────────────────────────────────────
app.get('/market/snapshot', async (req, res) => {
  try {
    if (!market) return res.json({ ok: true, data: {}, message: 'Market service initializing' });
    const data = await market.getDashboardSnapshot();
    res.json({ ok: true, data });
  } catch (e) {
    console.error('[/market/snapshot]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Individual Quote ──────────────────────────────────────────────────────────
app.get('/market/quote/:symbol', async (req, res) => {
  try {
    if (!market) return res.status(503).json({ ok: false, error: 'Market service initializing' });
    const symbol = req.params.symbol.toUpperCase();
    const nseSym = symbol.endsWith('.NS') ? symbol : `${symbol}.NS`;
    const data = await market.fetchYahooQuote(nseSym);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Indices ───────────────────────────────────────────────────────────────────
app.get('/market/indices', async (req, res) => {
  try {
    if (!market) return res.json({ ok: true, data: {} });
    const data = await market.getIndices();
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Sector Performance ────────────────────────────────────────────────────────
app.get('/market/sectors', async (req, res) => {
  try {
    if (!market) return res.json({ ok: true, data: [] });
    const data = await market.getSectorPerformance();
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Advance / Decline ─────────────────────────────────────────────────────────
app.get('/market/adv-dec', async (req, res) => {
  try {
    if (!market) return res.json({ ok: true, data: {} });
    const data = await market.getAdvanceDecline();
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Scanner Results ───────────────────────────────────────────────────────────
app.get('/scanner/results', async (req, res) => {
  try {
    if (!scanner) return res.json({ ok: true, data: [], message: 'Scanner initializing' });
    // Check cache first
    if (redis.isReady) {
      const cached = await redis.get('cache:scanner');
      if (cached) return res.json({ ok: true, data: JSON.parse(cached), cached: true });
    }
    const data = await scanner.runScan();
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Force Rescan ──────────────────────────────────────────────────────────────
app.post('/scanner/rescan', async (req, res) => {
  try {
    if (redis.isReady) await redis.del('scanner:results').catch(() => {});
    res.json({ ok: true, message: 'Rescan triggered — results available in ~30s at /scanner/results' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Portfolio ─────────────────────────────────────────────────────────────────
app.get('/portfolio/:userId', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM positions WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC',
      [req.params.userId, 'open']
    );
    res.json({ ok: true, data: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/portfolio', async (req, res) => {
  try {
    const { userId, symbol, quantity, buyPrice, stopLoss, strategy } = req.body;
    if (!userId || !symbol || !quantity || !buyPrice) {
      return res.status(400).json({ ok: false, error: 'Missing required fields: userId, symbol, quantity, buyPrice' });
    }
    const { rows } = await db.query(
      `INSERT INTO positions (user_id, symbol, quantity, buy_price, stop_loss, strategy)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [userId, symbol.toUpperCase(), quantity, buyPrice, stopLoss || null, strategy || null]
    );
    res.json({ ok: true, data: rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── AI Analysis ───────────────────────────────────────────────────────────────
app.post('/ai/analyze', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ ok: false, error: 'prompt is required' });
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(400).json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' });
    }
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });
    res.json({ ok: true, data: message.content[0].text });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ ok: false, error: `Route ${req.method} ${req.path} not found` });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

// ── Startup ───────────────────────────────────────────────────────────────────
async function start() {
  const PORT = parseInt(process.env.PORT || '4000', 10);

  // Connect Redis (non-blocking — app starts even if Redis is unavailable)
  try {
    await redis.connect();
    console.log('[Redis] Connected ✓');
  } catch (e) {
    console.warn('[Redis] Not available — running without cache:', e.message);
  }

  // Connect PostgreSQL (non-blocking — routes that need DB will handle errors)
  try {
    await db.connect();
    console.log('[PostgreSQL] Connected ✓');
  } catch (e) {
    console.warn('[PostgreSQL] Not available — running without DB:', e.message);
  }

  // Load market services after connections are established
  try {
    const MarketDataService = require('./services/marketData');
    const ScannerService = require('./services/scanner');
    const WebSocketServer = require('./services/websocket');

    market = new MarketDataService(redis);
    scanner = new ScannerService(redis);
    wss = new WebSocketServer(server, redis);

    console.log('[Market] Data service ready ✓');
    console.log('[Scanner] Breakout scanner ready ✓');
    console.log('[WebSocket] Streaming server ready ✓');
  } catch (e) {
    console.error('[Services] Failed to load:', e.message);
    // Continue without services — health check still works
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║   BreakoutIntel V2 — API Server          ║');
    console.log(`║   Running on port ${PORT}                    ║`);
    console.log('║   Dashboard: /                           ║');
    console.log('║   Health:    /health                     ║');
    console.log('║   WebSocket: /ws                         ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
    console.log('[Data] Yahoo Finance (free, ~15s delayed)');
    console.log('[Data] NSE India (public endpoints)');
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('[Shutdown] Graceful shutdown initiated...');
    server.close();
    await db.end().catch(() => {});
    await redis.quit().catch(() => {});
    process.exit(0);
  });
}

start().catch((err) => {
  console.error('[Fatal] Server failed to start:', err);
  process.exit(1);
});
