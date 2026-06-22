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
let portfolio = null;
let transactions = null;
let analytics = null;
let intelligence = null;
let newsIntelligence = null;

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

// ── List query helper: pagination + search + sort for scanner/market arrays ──
// Query params supported on all list-returning endpoints:
//   ?search=<term>   case-insensitive match against sym/name/sector/industry/
//                     clientName/subject/stratName/strat
//   ?sort=<field>    sort by any field present on the result objects
//   ?order=asc|desc  sort direction (default: desc)
//   ?page=<n>        1-indexed page number (default: 1)
//   ?limit=<n>       items per page, 1-500 (default: 50)
function applyListParams(data, req) {
  let result = Array.isArray(data) ? [...data] : [];
  const totalUnfiltered = result.length;

  const q = (req.query.search || req.query.q || '').toString().trim().toLowerCase();
  if (q) {
    const searchFields = ['sym','name','sector','industry','clientName','subject','stratName','strat','category'];
    result = result.filter(item =>
      searchFields.some(k => item[k] != null && String(item[k]).toLowerCase().includes(q))
    );
  }

  const sortKey = req.query.sort;
  if (sortKey) {
    const order = (req.query.order || 'desc').toLowerCase() === 'asc' ? 1 : -1;
    result.sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string' || typeof bv === 'string') {
        return order * String(av).localeCompare(String(bv));
      }
      return order * (av - bv);
    });
  }

  const filteredTotal = result.length;
  let page  = Math.max(parseInt(req.query.page) || 1, 1);
  let limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 500);
  const totalPages = Math.max(1, Math.ceil(filteredTotal / limit));
  if (page > totalPages) page = totalPages;
  const start = (page - 1) * limit;

  return {
    data: result.slice(start, start + limit),
    pagination: { page, limit, total: filteredTotal, totalPages, totalUnfiltered },
  };
}

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
    let fullData;
    if (redisClient?.isReady) {
      const cached = await redisClient.get('cache:scanner').catch(() => null);
      fullData = cached ? JSON.parse(cached) : null;
    }
    if (!fullData) fullData = await scanner.runScan();
    const { data, pagination } = applyListParams(fullData, req);
    res.json({ ok: true, data, ...pagination });
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
    const fullData = scanner.getByStrategy(strategy);
    const { data, pagination } = applyListParams(fullData, req);
    res.json({ ok: true, data, strategy, ...pagination });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Scanner — volume alerts ───────────────────────────────────────────────────
app.get('/scanner/volume-alerts', async (req, res) => {
  try {
    if (!scanner) return res.json({ ok: true, data: [] });
    await scanner.runScan();
    const fullData = scanner.getVolumeAlerts();
    const { data, pagination } = applyListParams(fullData, req);
    res.json({ ok: true, data, ...pagination });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Scanner — breakout alerts ─────────────────────────────────────────────────
app.get('/scanner/breakout-alerts', async (req, res) => {
  try {
    if (!scanner) return res.json({ ok: true, data: [] });
    await scanner.runScan();
    const fullData = scanner.getBreakoutAlerts();
    const { data, pagination } = applyListParams(fullData, req);
    res.json({ ok: true, data, ...pagination });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Scanner — RS leaders ──────────────────────────────────────────────────────
app.get('/scanner/rs-leaders', async (req, res) => {
  try {
    if (!scanner) return res.json({ ok: true, data: [] });
    await scanner.runScan();
    const fullData = scanner.getRSLeaders();
    const { data, pagination } = applyListParams(fullData, req);
    res.json({ ok: true, data, ...pagination });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Scanner — Sector Leaders ──────────────────────────────────────────────────
app.get('/scanner/sector-leaders', async (req, res) => {
  try {
    if (!scanner) return res.json({ ok: true, data: [] });
    await scanner.runScan();
    const fullData = scanner.getSectorLeaders();
    const { data, pagination } = applyListParams(fullData, req);
    res.json({ ok: true, data, ...pagination });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Scanner — Industry Group Leaders ──────────────────────────────────────────
app.get('/scanner/industry-leaders', async (req, res) => {
  try {
    if (!scanner) return res.json({ ok: true, data: [] });
    await scanner.runScan();
    const fullData = scanner.getIndustryLeaders();
    const { data, pagination } = applyListParams(fullData, req);
    res.json({ ok: true, data, ...pagination });
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
    if (!result.ok) return res.json(result);
    const { data, pagination } = applyListParams(result.data, req);
    res.json({ ...result, data, ...pagination });
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
    if (!result.ok) return res.json(result);
    const { data, pagination } = applyListParams(result.data, req);
    res.json({ ...result, data, ...pagination });
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
    if (!result.ok) return res.json(result);
    const { data, pagination } = applyListParams(result.data, req);
    res.json({ ...result, data, ...pagination });
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
    if (!result.ok) return res.json(result);
    const { data, pagination } = applyListParams(result.data, req);
    res.json({ ...result, data, ...pagination });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Market — Corporate Announcements (real NSE data, filtered to universe) ───
app.get('/market/corporate-announcements', async (req, res) => {
  try {
    if (!scanner) return res.json({ ok: true, data: [] });
    // Note: getCorporateAnnouncementsForUniverse() fetches from NSE directly —
    // no runScan() needed here. The old runScan() call was triggering a full
    // 344-stock scan on every news page open, causing concurrent scan bursts.
    const result = await scanner.getCorporateAnnouncementsForUniverse();
    if (!result.ok) return res.json(result);
    const { data, pagination } = applyListParams(result.data, req);
    res.json({ ...result, data, ...pagination });
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

// ── Market — Health Score (deterministic rule-based, no randomness) ───────────
// Weights: Nifty50 30pts + BankNifty 15pts + Midcap 15pts + VIX 20pts + A/D 20pts
// Labels: >=75 STRONGLY BULLISH | >=60 BULLISH | >=45 NEUTRAL | >=30 BEARISH | <30 STRONGLY BEARISH
app.get('/market/health', async (req, res) => {
  try {
    if (!market) return res.json({ ok: false, score: null, label: 'Unavailable', dataComplete: false, message: 'Market service initializing' });
    const data = await market.getMarketHealth();
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Portfolio Routes — Phase 1 + Phase 2 ─────────────────────────────────────
// user_id is taken from the x-user-id header (placeholder until auth middleware
// is added in a later phase). If no DB, returns 503 gracefully.

// GET /portfolio/search?q=<term>
// Primary: in-memory search against UNIVERSE (346 stocks). Zero network calls.
// Fallback: if fewer than 3 results AND market service is ready, probe Yahoo
//           Finance to resolve the symbol so any NSE/BSE stock can be added.
// Returns: sym, nseSymbol, name, exchange, sector, industry, cap, capCategory
app.get('/portfolio/search', async (req, res) => {
  try {
    if (!portfolio) return res.status(503).json({ ok: false, error: 'Portfolio service not ready' });
    const q = (req.query.q || req.query.search || '').toString().trim();
    if (!q) return res.status(400).json({ ok: false, error: 'q parameter required' });

    const universeResults = portfolio.searchStocks(q).map(s => ({
      sym:         s.sym,
      nseSymbol:   s.nseSymbol,
      name:        s.name,
      exchange:    s.exchange,
      sector:      s.sector,
      industry:    s.industry,
      cap:         s.cap,
      capCategory: s.cap,
    }));

    // If we have good universe hits, return them immediately
    if (universeResults.length >= 3) {
      return res.json({ ok: true, data: universeResults, source: 'universe' });
    }

    // Fallback: try Yahoo Finance for the exact symbol (NSE first, then BSE)
    // This allows any listed NSE/BSE stock to be added, not just the 346 in universe
    if (market) {
      const base = q.replace(/\.(NS|BO)$/i, '').toUpperCase();
      const candidates = [`${base}.NS`, `${base}.BO`];
      const yahooHits = [];

      for (const sym of candidates) {
        try {
          const quote = await market.fetchYahooQuote(sym);
          if (quote && quote.ok && quote.price) {
            const exchange = sym.endsWith('.BO') ? 'BSE' : 'NSE';
            // Avoid duplicates already in universe results
            const alreadyIn = universeResults.some(r => r.nseSymbol === base);
            if (!alreadyIn) {
              yahooHits.push({
                sym:         sym,
                nseSymbol:   base,
                name:        quote.name || base,
                exchange,
                sector:      quote.sector   || null,
                industry:    quote.industry || null,
                cap:         null,
                capCategory: null,
                livePrice:   quote.price,
              });
            }
            break; // found on NSE, no need to try BSE
          }
        } catch (_) { /* ignore individual failures */ }
      }

      const combined = [...universeResults, ...yahooHits].slice(0, 10);
      return res.json({ ok: true, data: combined, source: combined.length > universeResults.length ? 'universe+yahoo' : 'universe' });
    }

    res.json({ ok: true, data: universeResults, source: 'universe' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /portfolio/positions          — plain DB (Phase 1 behaviour)
// GET /portfolio/positions?live=true — enriched with live prices (Phase 2)
app.get('/portfolio/positions', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok: false, error: 'Database not configured' });
    if (!portfolio) return res.status(503).json({ ok: false, error: 'Portfolio service not ready' });
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(400).json({ ok: false, error: 'x-user-id header required' });

    if (req.query.live === 'true') {
      const result = await portfolio.getEnrichedPositions(userId);
      return res.json({ ok: true, ...result });
    }

    const data = await portfolio.getPositions(userId);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /portfolio/summary — portfolio-level P&L summary with live prices
app.get('/portfolio/summary', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok: false, error: 'Database not configured' });
    if (!portfolio) return res.status(503).json({ ok: false, error: 'Portfolio service not ready' });
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(400).json({ ok: false, error: 'x-user-id header required' });
    const data = await portfolio.getPortfolioSummary(userId);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/portfolio/positions', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok: false, error: 'Database not configured' });
    if (!portfolio) return res.status(503).json({ ok: false, error: 'Portfolio service not ready' });
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(400).json({ ok: false, error: 'x-user-id header required' });
    const data = await portfolio.addPosition(userId, req.body);
    res.status(201).json({ ok: true, data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.put('/portfolio/positions/:id', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok: false, error: 'Database not configured' });
    if (!portfolio) return res.status(503).json({ ok: false, error: 'Portfolio service not ready' });
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(400).json({ ok: false, error: 'x-user-id header required' });
    const data = await portfolio.updatePosition(userId, req.params.id, req.body);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.delete('/portfolio/positions/:id', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok: false, error: 'Database not configured' });
    if (!portfolio) return res.status(503).json({ ok: false, error: 'Portfolio service not ready' });
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(400).json({ ok: false, error: 'x-user-id header required' });
    const data = await portfolio.deletePosition(userId, req.params.id);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── Portfolio Routes — Phase 3 (Transactions Engine) ─────────────────────────

// POST /portfolio/buy — create new position or average into existing
app.post('/portfolio/buy', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok: false, error: 'Database not configured' });
    if (!transactions) return res.status(503).json({ ok: false, error: 'Transaction service not ready' });
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(400).json({ ok: false, error: 'x-user-id header required' });
    const data = await transactions.buy(userId, req.body);
    res.status(201).json({ ok: true, data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// POST /portfolio/sell — partial or full exit
app.post('/portfolio/sell', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok: false, error: 'Database not configured' });
    if (!transactions) return res.status(503).json({ ok: false, error: 'Transaction service not ready' });
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(400).json({ ok: false, error: 'x-user-id header required' });
    const data = await transactions.sell(userId, req.body);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// GET /portfolio/history — full trade history (BUY/SELL/PARTIAL_SELL), newest first
app.get('/portfolio/history', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok: false, error: 'Database not configured' });
    if (!portfolio) return res.status(503).json({ ok: false, error: 'Portfolio service not ready' });
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(400).json({ ok: false, error: 'x-user-id header required' });
    const data = await portfolio.getTradeHistory(userId);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /portfolio/performance — realized P&L metrics (calculated live from DB)
app.get('/portfolio/performance', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok: false, error: 'Database not configured' });
    if (!portfolio) return res.status(503).json({ ok: false, error: 'Portfolio service not ready' });
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(400).json({ ok: false, error: 'x-user-id header required' });
    const data = await portfolio.getPerformance(userId);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Portfolio Routes — Phase 4 (Analytics) ───────────────────────────────────

const analyticsGuard = (res) => {
  if (!db)        return res.status(503).json({ ok: false, error: 'Database not configured' });
  if (!analytics) return res.status(503).json({ ok: false, error: 'Analytics service not ready' });
  return null;
};
const userGuard = (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) { res.status(400).json({ ok: false, error: 'x-user-id header required' }); return null; }
  return userId;
};

// GET /portfolio/analytics/allocation
// ?live=true adds unrealized P&L to sector performance and top 10 holdings
app.get('/portfolio/analytics/allocation', async (req, res) => {
  try {
    if (analyticsGuard(res)) return;
    const userId = userGuard(req, res); if (!userId) return;
    const live = req.query.live === 'true';
    const data = await analytics.getAllocation(userId, live);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /portfolio/analytics/risk
// HHI, concentration metrics, portfolio exposure
app.get('/portfolio/analytics/risk', async (req, res) => {
  try {
    if (analyticsGuard(res)) return;
    const userId = userGuard(req, res); if (!userId) return;
    const data = await analytics.getRisk(userId);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /portfolio/analytics/performance
// ?live=true adds top winners/losers and unrealized P&L
app.get('/portfolio/analytics/performance', async (req, res) => {
  try {
    if (analyticsGuard(res)) return;
    const userId = userGuard(req, res); if (!userId) return;
    const live = req.query.live === 'true';
    const data = await analytics.getPerformanceAnalytics(userId, live);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /portfolio/analytics/timeline
// Monthly + weekly P&L, holding period analysis
app.get('/portfolio/analytics/timeline', async (req, res) => {
  try {
    if (analyticsGuard(res)) return;
    const userId = userGuard(req, res); if (!userId) return;
    const data = await analytics.getTimeline(userId);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /portfolio/analytics/health
// Capital deployed, cash realized, win rate trend, profit factor trend
app.get('/portfolio/analytics/health', async (req, res) => {
  try {
    if (analyticsGuard(res)) return;
    const userId = userGuard(req, res); if (!userId) return;
    const data = await analytics.getHealth(userId);
    res.json({ ok: true, data });
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
        max: 3,                      // Supabase free tier: keep 2 slots free for admin/dashboard
        idleTimeoutMillis: 30000,    // release idle connections faster (free tier courtesy)
        connectionTimeoutMillis: 5000,
      });
      await db.query('SELECT 1');
      console.log('[PostgreSQL] Connected ✓');

      // Run schema + migrations (idempotent — safe on every startup)
      const runMigrations = require('./models/migrate');
      await runMigrations(db);

      // Instantiate portfolio service now that DB is available
      // market is passed after it is initialised in step 4 below;
      // portfolioService holds a reference so it will be live by the time
      // any route is called.
      const PortfolioService  = require('./services/portfolioService');
      const TransactionService = require('./services/transactionService');
      const AnalyticsService   = require('./services/analyticsService');
      portfolio    = new PortfolioService(db, null); // market injected after step 4
      transactions = new TransactionService(db);
      analytics    = new AnalyticsService(db, null); // market injected after step 4
      console.log('[Portfolio] Service ready ✓');
      console.log('[Transactions] Service ready ✓');
      console.log('[Analytics] Service ready ✓');

      const IntelligenceService = require('./services/intelligenceService');
      intelligence = new IntelligenceService(db, null, analytics, null);
      console.log('[Intelligence] Service ready ✓');

      // ── Register intelligence router now that the service is live ──────────
      // Must be registered here (not at module load time) so the router
      // receives the real IntelligenceService instance, not null.
      const intelligenceRouter = require('./routes/intelligence');
      app.use('/portfolio/intelligence', intelligenceRouter(intelligence));
      console.log('[Intelligence] Routes registered ✓');

      const NewsIntelligenceService = require('./services/newsIntelligence');
      newsIntelligence = new NewsIntelligenceService(db, redisClient || {
        get: async () => null, setEx: async () => null, del: async () => null,
      }, null); // nseData injected after market services init
      console.log('[NewsIntelligence] Service ready ✓');
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

    // Inject market into portfolio + analytics services
    if (portfolio) {
      portfolio.market = market;
      console.log('[Portfolio] Market service injected ✓');
    }
    if (analytics) {
      analytics.market = market;
      console.log('[Analytics] Market service injected ✓');
    }
    if (intelligence) {
      intelligence.market  = market;
      intelligence.scanner = scanner;
      console.log('[Intelligence] Market + Scanner injected ✓');
    }
    if (newsIntelligence) {
      newsIntelligence.nse = nseData;
      console.log('[NewsIntelligence] NSE data service injected ✓');

      // ── Startup refresh (free-tier compatible) ───────────────────────────────
      // No separate worker process on Render free tier. Instead, trigger the
      // first news refresh 90 seconds after startup — lets the health check
      // pass and the scanner settle before news work begins. Subsequent
      // refreshes are lazy-triggered by the first stale request (every 20 min).
      setTimeout(() => {
        if (!newsIntelligence) return;
        console.log('[NewsIntelligence] Running startup refresh...');
        newsIntelligence.refresh()
          .catch(e => console.warn('[NewsIntelligence] Startup refresh error:', e.message));
      }, 90_000);
      console.log('[NewsIntelligence] Startup refresh scheduled (90s) ✓');
    }
  } catch (e) {
    console.error('[Services] Load error (non-fatal):', e.message);
  }

  // ── News Intelligence Center ───────────────────────────────────────────────
  // All routes return { ok, data } — gracefully degrade when service not ready.

  // GET /news — paginated list with optional ?category=&sentiment= filters
  app.get('/news', async (req, res) => {
    try {
      if (!newsIntelligence) return res.json({ ok: true, data: [], message: 'News service initializing' });
      const limit    = Math.min(parseInt(req.query.limit  || '30'), 100);
      const offset   = Math.max(parseInt(req.query.offset || '0'),  0);
      const category = req.query.category  || null;
      const sentiment= req.query.sentiment || null;
      const result   = await newsIntelligence.getNews({ limit, offset, category, sentiment });
      res.json(result);
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // GET /news/breaking — items with impact_score >= 80 in last 6 hours
  app.get('/news/breaking', async (req, res) => {
    try {
      if (!newsIntelligence) return res.json({ ok: true, data: [] });
      res.json(await newsIntelligence.getBreaking());
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // GET /news/high-impact — items with impact_score >= 60 in last 24 hours
  app.get('/news/high-impact', async (req, res) => {
    try {
      if (!newsIntelligence) return res.json({ ok: true, data: [] });
      const limit = Math.min(parseInt(req.query.limit || '20'), 50);
      res.json(await newsIntelligence.getHighImpact({ limit }));
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // GET /news/watchlist?symbols=RELIANCE,TCS,INFY — cross-references portfolio symbols
  app.get('/news/watchlist', async (req, res) => {
    try {
      if (!newsIntelligence) return res.json({ ok: true, data: [] });
      const symbols = (req.query.symbols || '').split(',').map(s => s.trim()).filter(Boolean);
      res.json(await newsIntelligence.getWatchlistNews(symbols));
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // GET /news/stock/:symbol — all news for a specific NSE symbol
  app.get('/news/stock/:symbol', async (req, res) => {
    try {
      if (!newsIntelligence) return res.json({ ok: true, data: [] });
      res.json(await newsIntelligence.getByStock(req.params.symbol));
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // GET /news/sector/:sector — news affecting a sector
  app.get('/news/sector/:sector', async (req, res) => {
    try {
      if (!newsIntelligence) return res.json({ ok: true, data: [] });
      res.json(await newsIntelligence.getBySector(req.params.sector));
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // GET /news/trending — most-mentioned stocks in last 24 hours
  app.get('/news/trending', async (req, res) => {
    try {
      if (!newsIntelligence) return res.json({ ok: true, data: [] });
      res.json(await newsIntelligence.getTrending());
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // GET /news/stats — aggregate stats (total, scored, sentiment distribution)
  app.get('/news/stats', async (req, res) => {
    try {
      if (!newsIntelligence) return res.json({ ok: true, data: null });
      res.json(await newsIntelligence.getStats());
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // GET /news/search?q=<term> — title / symbol / company search
  app.get('/news/search', async (req, res) => {
    try {
      if (!newsIntelligence) return res.json({ ok: true, data: [] });
      const q     = (req.query.q || '').trim();
      if (!q) return res.status(400).json({ ok: false, error: 'q parameter required' });
      const limit = Math.min(parseInt(req.query.limit || '20'), 50);
      res.json(await newsIntelligence.search({ q, limit }));
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // GET /news/timeline?symbol=RELIANCE&days=30 — day-by-day aggregation
  app.get('/news/timeline', async (req, res) => {
    try {
      if (!newsIntelligence) return res.json({ ok: true, data: [] });
      const symbol = req.query.symbol || null;
      const days   = Math.min(parseInt(req.query.days || '30'), 90);
      res.json(await newsIntelligence.getTimeline({ symbol, days }));
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── Catch-all + error handler — registered last so API routes take priority ─
  app.get('*', (req, res) => {
    const indexPath = path.join(REPO_ROOT, 'index.html');
    res.sendFile(indexPath, (err) => {
      if (err) {
        console.error('[Static] index.html not found at:', indexPath);
        res.status(200).send('<h2>BreakoutIntel API running. <a href="/health">Health</a> | <a href="/market/indices">Indices</a></h2>');
      }
    });
  });

  app.use((err, req, res, next) => {
    console.error('[Error]', err.message);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  });

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
