require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);

// ── PORT — Render sets this dynamically, MUST use process.env.PORT ────────────
const PORT = process.env.PORT || 4000;

// ── Optional services (app works without them) ────────────────────────────────
let redisClient = null;
let db = null;
let market = null;
let scanner = null;
let nseData = null;
let wss = null;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression());
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 60000, max: 200, standardHeaders: true, legacyHeaders: false }));

// ── Serve V2 Dashboard (index.html at repo root) ──────────────────────────────
// File structure: repo-root/index.html, repo-root/backend/src/index.js
// So we go 3 levels up from src/ to reach repo root
const REPO_ROOT = path.join(__dirname, '..', '..');  // backend/src -> backend -> repo-root
app.use(express.static(REPO_ROOT));

// ── Health Check — Render pings this to confirm deploy success ────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'breakoutintel-v2',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    port: PORT,
    redis: redisClient?.isReady ? 'connected' : 'not configured',
    database: db ? 'connected' : 'not configured',
    market: market ? 'ready' : 'initializing',
  });
});

// ── Market Routes ─────────────────────────────────────────────────────────────
app.get('/market/snapshot', async (req, res) => {
  try {
    if (!market) return res.json({ ok: true, data: {}, message: 'Market service initializing — try again in 30s' });
    const data = await market.getDashboardSnapshot();
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/market/indices', async (req, res) => {
  try {
    if (!market) return res.json({ ok: true, data: {} });
    const data = await market.getIndices();
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/market/sectors', async (req, res) => {
  try {
    if (!market) return res.json({ ok: true, data: [] });
    const data = await market.getSectorPerformance();
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/market/adv-dec', async (req, res) => {
  try {
    if (!market) return res.json({ ok: true, data: {} });
    const data = await market.getAdvanceDecline();
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/market/quote/:symbol', async (req, res) => {
  try {
    if (!market) return res.status(503).json({ ok: false, error: 'Market service initializing' });
    const sym = req.params.symbol.toUpperCase();
    const nseSym = sym.endsWith('.NS') ? sym : `${sym}.NS`;
    const data = await market.fetchYahooQuote(nseSym);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Scanner Routes ────────────────────────────────────────────────────────────
app.get('/scanner/results', async (req, res) => {
  try {
    if (!scanner) return res.json({ ok: true, data: [], message: 'Scanner initializing' });
    if (redisClient?.isReady) {
      const cached = await redisClient.get('cache:scanner').catch(() => null);
      if (cached) return res.json({ ok: true, data: JSON.parse(cached), cached: true });
    }
    const data = await scanner.runScan();
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/scanner/rescan', async (req, res) => {
  try {
    if (redisClient?.isReady) await redisClient.del('scanner:results').catch(() => {});
    res.json({ ok: true, message: 'Rescan triggered — results at /scanner/results in ~30s' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


// ── Scanner — strategy filter ─────────────────────────────────────────────────
app.get('/scanner/by-strategy', async (req, res) => {
  try {
    if (!scanner) return res.json({ ok: true, data: [], message: 'Scanner initializing' });
    await scanner.runScan(); // ensures lastResults is populated (cached)
    const strategy = req.query.strategy || 'all';
    const data = scanner.getByStrategy(strategy);
    res.json({ ok: true, data, strategy, total: data.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Scanner — volume alerts ───────────────────────────────────────────────────
app.get('/scanner/volume-alerts', async (req, res) => {
  try {
    if (!scanner) return res.json({ ok: true, data: [] });
    await scanner.runScan();
    const data = scanner.getVolumeAlerts();
    res.json({ ok: true, data, total: data.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Scanner — breakout alerts ─────────────────────────────────────────────────
app.get('/scanner/breakout-alerts', async (req, res) => {
  try {
    if (!scanner) return res.json({ ok: true, data: [] });
    await scanner.runScan();
    const data = scanner.getBreakoutAlerts();
    res.json({ ok: true, data, total: data.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Scanner — RS leaders ──────────────────────────────────────────────────────
app.get('/scanner/rs-leaders', async (req, res) => {
  try {
    if (!scanner) return res.json({ ok: true, data: [] });
    await scanner.runScan();
    const data = scanner.getRSLeaders();
    res.json({ ok: true, data, total: data.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Scanner — Sector Leaders ──────────────────────────────────────────────────
app.get('/scanner/sector-leaders', async (req, res) => {
  try {
    if (!scanner) return res.json({ ok: true, data: [] });
    await scanner.runScan();
    const data = scanner.getSectorLeaders();
    res.json({ ok: true, data, total: data.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Scanner — Industry Group Leaders ──────────────────────────────────────────
app.get('/scanner/industry-leaders', async (req, res) => {
  try {
    if (!scanner) return res.json({ ok: true, data: [] });
    await scanner.runScan();
    const data = scanner.getIndustryLeaders();
    res.json({ ok: true, data, total: data.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Scanner — Stats (universe before/after, scan duration, last scan time) ───
app.get('/scanner/stats', async (req, res) => {
  try {
    if (!scanner) return res.json({ ok: true, data: null, message: 'Scanner initializing' });
    const meta = scanner.getMeta();
    res.json({ ok: true, data: meta });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Scanner — Bulk Deal Scanner (real NSE data) ───────────────────────────────
app.get('/scanner/bulk-deals', async (req, res) => {
  try {
    if (!scanner) return res.json({ ok: true, data: [] });
    await scanner.runScan();
    const result = await scanner.getBulkDealScanner();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Scanner — Block Deal Scanner (real NSE data) ──────────────────────────────
app.get('/scanner/block-deals', async (req, res) => {
  try {
    if (!scanner) return res.json({ ok: true, data: [] });
    await scanner.runScan();
    const result = await scanner.getBlockDealScanner();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Scanner — Delivery Volume Scanner (real NSE bhav copy delivery %) ────────
app.get('/scanner/delivery-volume', async (req, res) => {
  try {
    if (!scanner) return res.json({ ok: true, data: [] });
    await scanner.runScan();
    const result = await scanner.getDeliveryVolumeScanner();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Scanner — Institutional Accumulation (real NSE bulk deals + delivery %) ──
app.get('/scanner/institutional', async (req, res) => {
  try {
    if (!scanner) return res.json({ ok: true, data: [] });
    await scanner.runScan();
    const result = await scanner.getInstitutionalAccumulationReal();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Market — Corporate Announcements (real NSE data, filtered to universe) ───
app.get('/market/corporate-announcements', async (req, res) => {
  try {
    if (!scanner) return res.json({ ok: true, data: [] });
    await scanner.runScan();
    const result = await scanner.getCorporateAnnouncementsForUniverse();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Market — Breadth Dashboard (real NSE advance/decline) ─────────────────────
app.get('/market/breadth', async (req, res) => {
  try {
    if (!scanner) return res.json({ ok: false, data: null, message: 'Scanner initializing' });
    const result = await scanner.getMarketBreadthData();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── AI Analysis ───────────────────────────────────────────────────────────────
app.post('/ai/analyze', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ ok: false, error: 'prompt required' });
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(400).json({ ok: false, error: 'ANTHROPIC_API_KEY not set' });
    }
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });
    res.json({ ok: true, data: msg.content[0].text });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Catch-all: serve index.html for any unknown route ────────────────────────
app.get('*', (req, res) => {
  const indexPath = path.join(REPO_ROOT, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      console.error('[Static] index.html not found at:', indexPath);
      res.status(200).send('<h2>BreakoutIntel API running. <a href="/health">Health</a> | <a href="/market/indices">Indices</a></h2>');
    }
  });
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  // 1. Start HTTP server FIRST — Render health check must pass quickly
  server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('┌─────────────────────────────────────────────┐');
    console.log('│  BreakoutIntel V2 — Live                    │');
    console.log(`│  Port: ${PORT}                                   │`);
    console.log('│  Dashboard: /                               │');
    console.log('│  Health:    /health                         │');
    console.log('│  API:       /market/indices                 │');
    console.log('└─────────────────────────────────────────────┘');
  });

  // 2. Connect Redis (optional — never blocks startup)
  if (process.env.REDIS_URL) {
    try {
      const { createClient } = require('redis');
      redisClient = createClient({
        url: process.env.REDIS_URL,
        socket: { reconnectStrategy: (r) => Math.min(r * 500, 10000) },
      });
      redisClient.on('error', (e) => console.warn('[Redis]', e.message));
      await redisClient.connect();
      console.log('[Redis] Connected ✓');
    } catch (e) {
      console.warn('[Redis] Unavailable — running without cache:', e.message);
      redisClient = null;
    }
  } else {
    console.log('[Redis] No REDIS_URL set — running without cache');
  }

  // 3. Connect PostgreSQL (optional — never blocks startup)
  if (process.env.DATABASE_URL) {
    try {
      const { Pool } = require('pg');
      db = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 5,
        connectionTimeoutMillis: 5000,
      });
      await db.query('SELECT 1');
      console.log('[PostgreSQL] Connected ✓');
    } catch (e) {
      console.warn('[PostgreSQL] Unavailable — running without DB:', e.message);
      db = null;
    }
  } else {
    console.log('[PostgreSQL] No DATABASE_URL set — running without DB');
  }

  // 4. Load market services
  try {
    const MarketDataService = require('./services/marketData');
    const ScannerService = require('./services/scanner');
    const NSEDataService = require('./services/nseData');
    const WebSocketServer = require('./services/websocket');

    // Pass null-safe redis (services handle null gracefully)
    const safeRedis = redisClient || {
      get: async () => null,
      set: async () => null,
      setEx: async () => null,
      del: async () => null,
      isReady: false,
    };

    market   = new MarketDataService(safeRedis);
    nseData  = new NSEDataService(safeRedis);
    scanner  = new ScannerService(safeRedis, nseData);
    wss      = new WebSocketServer(server, safeRedis);

    console.log('[Market] Data service ready ✓');
    console.log('[NSEData] NSE data service ready ✓');
    console.log('[Scanner] Breakout scanner ready ✓');
    console.log('[WebSocket] Streaming on /ws ✓');
  } catch (e) {
    console.error('[Services] Load error (non-fatal):', e.message);
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[Shutdown] Graceful shutdown...');
    server.close();
    if (db) await db.end().catch(() => {});
    if (redisClient?.isReady) await redisClient.quit().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((err) => {
  console.error('[Fatal]', err.message);
  process.exit(1);
});
