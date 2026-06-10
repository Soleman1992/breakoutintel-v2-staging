require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { createClient } = require('redis');
const WebSocketServer = require('./services/websocket');
const MarketDataService = require('./services/marketData');
const ScannerService = require('./services/scanner');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Redis ─────────────────────────────────────────────────────────────────────
const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
redis.on('error', err => console.error('[Redis]', err.message));

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 60000, max: 100, standardHeaders: true }));

// ── Services ──────────────────────────────────────────────────────────────────
let market, scanner, wss;

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check (used by Docker healthcheck + load balancers)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: Date.now(), service: 'breakoutintel-api' });
});

// Market data endpoints
app.get('/market/indices', async (req, res) => {
  try {
    const data = await market.getIndices();
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/market/quote/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const nseSym = symbol.endsWith('.NS') ? symbol : `${symbol}.NS`;
    const data = await market.fetchYahooQuote(nseSym);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/market/sectors', async (req, res) => {
  try {
    const data = await market.getSectorPerformance();
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/market/snapshot', async (req, res) => {
  try {
    const cached = await redis.get('cache:dashboard_snapshot');
    if (cached) return res.json({ ok: true, data: JSON.parse(cached), cached: true });
    const data = await market.getDashboardSnapshot();
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/market/adv-dec', async (req, res) => {
  try {
    const data = await market.getAdvanceDecline();
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Scanner endpoints
app.get('/scanner/results', async (req, res) => {
  try {
    const cached = await redis.get('cache:scanner');
    if (cached) return res.json({ ok: true, data: JSON.parse(cached), cached: true });
    const data = await scanner.runScan();
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/scanner/rescan', async (req, res) => {
  try {
    await redis.del('scanner:results'); // Clear cache to force fresh scan
    res.json({ ok: true, message: 'Rescan triggered — results in 30s via WebSocket' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 52-week highs (real NSE data)
app.get('/market/52w-highs', async (req, res) => {
  try {
    const data = await market.get52WeekHighs();
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Portfolio (authenticated in production, open for dev)
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
    const { rows } = await db.query(
      `INSERT INTO positions (user_id, symbol, quantity, buy_price, stop_loss, strategy)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [userId, symbol, quantity, buyPrice, stopLoss, strategy]
    );
    res.json({ ok: true, data: rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// AI analysis endpoint
app.post('/ai/analyze', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(400).json({ ok: false, error: 'AI not configured' });
    }
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic();
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',  // cheapest, fast
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });
    res.json({ ok: true, data: message.content[0].text });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Start server ──────────────────────────────────────────────────────────────
async function start() {
  await redis.connect();
  console.log('[Redis] Connected');

  await db.connect();
  console.log('[PostgreSQL] Connected');

  market = new MarketDataService(redis);
  scanner = new ScannerService(redis);
  wss = new WebSocketServer(server, redis);

  const PORT = process.env.PORT || 4000;
  server.listen(PORT, () => {
    console.log(`[Server] BreakoutIntel API running on port ${PORT}`);
    console.log(`[Server] WebSocket streaming active on /ws`);
    console.log(`[Server] Market data: Yahoo Finance (free, ~15s latency)`);
  });
}

start().catch(err => {
  console.error('[Fatal]', err);
  process.exit(1);
});
