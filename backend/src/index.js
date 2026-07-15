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
let rankingOrch  = null;
let validationEng = null;
let alertsEngine  = null;
let holdingsAuthed = false;   // Holdings module auth gate (PR-0)
let brokerHoldings = null;    // Holdings Intelligence service (PR-1a)
let holdingsAnalytics = null; // Holdings allocation / risk / health (PR-1b)
let holdingsResearch  = null; // Holdings per-stock research — deterministic (PR-1c)
let holdingsAssistant = null; // Holdings Q&A — deterministic (PR-1c)

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

// ── Market — Internals (A/D, 52W H/L, Volume from Yahoo Finance scanner data) ──
// NSE API is blocked from cloud server IPs, so we derive these from the
// scanner's last results which are fetched from Yahoo Finance (~1000 stocks).
// No new API calls — reads scanner.lastResults which is Redis-cached.
// FII/DII is genuinely unavailable without a licensed data feed.
app.get('/market/internals', async (req, res) => {
  try {
    if (!scanner) return res.json({ ok: false, message: 'Scanner not ready', data: null });

    const results = scanner.lastResults || [];
    const meta    = scanner.lastMeta   || {};

    if (!results.length) {
      return res.json({ ok: false, message: 'Scanner warming up — check back in ~2 minutes', data: null });
    }

    let advances = 0, declines = 0, unchanged = 0;
    let newHigh  = 0, newLow   = 0;
    let totalVolume = 0;

    results.forEach(r => {
      // Advance / Decline (>0.05% threshold avoids noise from perfectly flat ticks)
      if (r.chg >  0.05) advances++;
      else if (r.chg < -0.05) declines++;
      else unchanged++;

      // Near 52W High — within 1% of year high
      if (r.hi52w && r.cmp && r.cmp >= r.hi52w * 0.99) newHigh++;
      // Near 52W Low — within 1% of year low
      if (r.lo52w && r.cmp && r.cmp <= r.lo52w * 1.01) newLow++;

      totalVolume += (r.curVolume || 0);
    });

    res.json({
      ok:   true,
      data: {
        advances,
        declines,
        unchanged,
        newHigh,
        newLow,
        totalVolume,
        fiiNet:       null,  // requires licensed data — not available on free tier
        diiNet:       null,
        stocksScanned: results.length,
        lastScanAt:   meta.lastScanAt || null,
      },
      source: 'Yahoo Finance · scanner universe (~1000 stocks)',
    });
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

  // 2. Connect Redis (optional — MUST NOT block startup)
  //
  // It previously did block, despite the comment. The reconnect strategy always
  // returned a delay, so the client retried forever; on a bad credential
  // (WRONGPASS) connect() neither resolved nor rejected, the await hung, the
  // catch never fired, and PostgreSQL below was never reached. A wrong Redis
  // password took the whole application down — no database, no Holdings module —
  // while /health still cheerfully reported "ok".
  //
  // Now: give up after a few attempts, and cap the whole thing with a timeout so
  // no Redis failure mode can stall the boot. Redis is a cache; losing it must
  // degrade performance, never availability.
  if (process.env.REDIS_URL) {
    try {
      const { createClient } = require('redis');
      redisClient = createClient({
        url: process.env.REDIS_URL,
        socket: {
          connectTimeout: 5000,
          // Returning an Error ends the retry loop and rejects connect().
          reconnectStrategy: (retries) =>
            retries >= 3 ? new Error('Redis unreachable after 3 attempts') : Math.min(retries * 300, 1000),
        },
      });
      redisClient.on('error', (e) => console.warn('[Redis]', e.message));

      // Belt and braces: even a client that never settles cannot hold up boot.
      await Promise.race([
        redisClient.connect(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('connect timed out after 10s')), 10000)),
      ]);

      console.log('[Redis] Connected ✓');
      // Init shared NSE session manager with Redis (UA rotation + cookie cache)
      require('./services/nseSession').init(redisClient);
    } catch (e) {
      console.warn('[Redis] Unavailable — running without cache:', e.message);
      try { await redisClient?.destroy?.(); } catch { /* already dead */ }
      redisClient = null;
      require('./services/nseSession').init(null);
    }
  } else {
    console.log('[Redis] No REDIS_URL set — running without cache');
    require('./services/nseSession').init(null); // no Redis — session works without cache
  }

  // 3. Connect PostgreSQL (optional — never blocks startup)
  if (process.env.DATABASE_URL) {
    try {
      const { Pool } = require('pg');
      db = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 3,                      // free tier: keep headroom for the DB console
        idleTimeoutMillis: 30000,    // release idle connections faster (free tier courtesy)
        // Neon auto-suspends its compute when idle, and a cold start can take
        // well over 5s. The old 5s timeout meant a sleeping database would fail
        // the probe below, hit the catch, and set db = null for the ENTIRE life
        // of the process — no retry, no recovery until the next deploy. That is
        // what leaves the app running databaseless with every DB-backed route
        // returning 503.
        connectionTimeoutMillis: 20000,
      });

      // Retry the probe with backoff: the first attempt is what wakes a
      // suspended Neon compute, so it is the one most likely to time out.
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await db.query('SELECT 1');
          break;
        } catch (e) {
          if (attempt === 3) throw e;
          console.warn(`[PostgreSQL] Probe ${attempt}/3 failed (${e.message}) — retrying...`);
          await new Promise(r => setTimeout(r, 2000 * attempt));
        }
      }
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

      // ── Holdings Auth (PR-0) ───────────────────────────────────────────────
      // Guards the /holdings-intel/* namespace only. The existing /portfolio/*
      // routes and their x-user-id placeholder flow are untouched.
      //
      // Own try/catch on purpose: the enclosing catch sets db = null, so an
      // unguarded throw here (e.g. a missing HOLDINGS_JWT_SECRET) would take
      // down the existing portfolio, intelligence and news services with it.
      //
      // Fails CLOSED: if the secret is absent the router never mounts, and the
      // guard registered before the SPA catch-all answers the whole namespace
      // with 503. It can never become reachable-but-unauthenticated.
      try {
        const holdingsAuthRoutes = require('./routes/holdingsAuthRoutes');
        app.use('/holdings-intel/auth', holdingsAuthRoutes(db));
        holdingsAuthed = true;
        console.log('[HoldingsAuth] Routes registered ✓');

        // ── Holdings Intelligence (PR-1a) ────────────────────────────────────
        // Broker-synced personal holdings, imported from Zerodha Console exports.
        // Entirely separate from the scanner trade journal behind /portfolio/*.
        // Mounted only when auth is live — the data must never be reachable
        // without a verified identity.
        const BrokerHoldingsService = require('./holdings/brokerHoldingsService');
        brokerHoldings = new BrokerHoldingsService(db, null); // market injected after step 4

        const HoldingsAnalyticsService = require('./holdings/holdingsAnalyticsService');
        holdingsAnalytics = new HoldingsAnalyticsService(brokerHoldings, null); // market injected after step 4

        // Research + assistant are DETERMINISTIC — no LLM, no API key, no cost.
        const HoldingsResearchService = require('./holdings/holdingsResearchService');
        const HoldingsAssistant       = require('./holdings/holdingsAssistant');
        holdingsResearch  = new HoldingsResearchService(brokerHoldings, null, db);
        holdingsAssistant = new HoldingsAssistant(brokerHoldings, holdingsAnalytics, null);

        const holdingsIntelRoutes = require('./routes/holdingsIntel');
        app.use('/holdings-intel', holdingsIntelRoutes(
          db, brokerHoldings, holdingsAnalytics, holdingsResearch, holdingsAssistant
        ));
        console.log('[HoldingsIntel] Service + analytics + research + assistant registered ✓');
      } catch (e) {
        holdingsAuthed = false;
        brokerHoldings = null;
        holdingsAnalytics = null;
        holdingsResearch  = null;
        holdingsAssistant = null;
        console.warn('[HoldingsAuth] Disabled (non-fatal):', e.message);
      }
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
    // Pass existing instances — WebSocket reuses them instead of creating a second scanner
    // AlertsEngine — must be created before WebSocket so WS can broadcast alerts
    const AlertsEngine = require('./services/alertsEngine');
    alertsEngine = new AlertsEngine(db, safeRedis);
    console.log('[AlertsEngine] System alert pipeline ready ✓');

    wss      = new WebSocketServer(server, safeRedis, { market, scanner, alerts: alertsEngine });

    console.log('[Market] Data service ready ✓');
    console.log('[NSEData] NSE data service ready ✓');
    console.log('[Scanner] Breakout scanner ready ✓');
    console.log('[WebSocket] Streaming on /ws ✓');

    // Give MarketDataService the scanner, so getAdvanceDecline() can read the
    // scanner's Yahoo-priced universe instead of NSE (which blocks datacenter IPs
    // and hung the top-bar A/D, Market Health, and Market Sentiment).
    if (market && scanner) {
      market.scanner = scanner;
      console.log('[Market] Scanner injected for breadth ✓');
    }

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
    if (brokerHoldings) {
      brokerHoldings.market = market;
      console.log('[HoldingsIntel] Market service injected ✓');
    }
    if (holdingsAnalytics) {
      holdingsAnalytics.market = market;
      console.log('[HoldingsAnalytics] Market service injected ✓');
    }
    if (holdingsResearch)  holdingsResearch.market  = market;
    if (holdingsAssistant) holdingsAssistant.market = market;
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

  // 5. Ranking Orchestrator (consensus engine pipeline)
  try {
    const RankingOrchestrator = require('./services/rankingOrchestrator');
    rankingOrch = new RankingOrchestrator(market, db, redisClient, wss);
    rankingOrch.startScheduler();
    console.log('[RankingOrch] Consensus engine pipeline ready ✓');
    // Initial scan deferred 120s to let server fully stabilise
    setTimeout(() => {
      if (!rankingOrch) return;
      console.log('[RankingOrch] Running initial scan...');
      rankingOrch.runScan({ categoryFilter: ['LARGECAP'] })
        .catch(e => console.warn('[RankingOrch] Initial scan error:', e.message));
    }, 120_000);
    console.log('[RankingOrch] Initial scan scheduled (120s) ✓');
  } catch (e) {
    console.warn('[RankingOrch] Failed to start (non-fatal):', e.message);
  }

  // 6. Validation Engine (Phase 8)
  try {
    const ValidationEngine = require('./engines/validationEngine');
    validationEng = new ValidationEngine(db);
    console.log('[Validation] Anti-overfitting engine ready ✓');
  } catch (e) {
    console.warn('[Validation] Failed to start (non-fatal):', e.message);
  }

  // ── Alert Intelligence Routes ─────────────────────────────────────────────
  // System-generated alerts from scanner + news. No user auth required.

  // GET /alerts/breakout — live breakout alerts (from last scanner run)
  app.get('/alerts/breakout', async (req, res) => {
    try {
      if (!alertsEngine) return res.json({ ok: true, data: [], message: 'Alert engine initializing' });
      const live = alertsEngine.getBreakoutAlerts();
      if (live.length) {
        const { data, pagination } = applyListParams(live, req);
        return res.json({ ok: true, data, ...pagination, source: 'live' });
      }
      // Fallback: fetch from DB if in-memory cache is empty (cold start)
      const hist = await alertsEngine.getHistoricalAlerts({ type: 'breakout', hours: 8 });
      const { data, pagination } = applyListParams(hist.data || [], req);
      res.json({ ok: true, data, ...pagination, source: 'historical' });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // GET /alerts/volume — live volume alerts (from last scanner run)
  app.get('/alerts/volume', async (req, res) => {
    try {
      if (!alertsEngine) return res.json({ ok: true, data: [], message: 'Alert engine initializing' });
      const live = alertsEngine.getVolumeAlerts();
      if (live.length) {
        const { data, pagination } = applyListParams(live, req);
        return res.json({ ok: true, data, ...pagination, source: 'live' });
      }
      const hist = await alertsEngine.getHistoricalAlerts({ type: 'volume', hours: 8 });
      const { data, pagination } = applyListParams(hist.data || [], req);
      res.json({ ok: true, data, ...pagination, source: 'historical' });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // GET /alerts/news — live news alerts (from news_items with AI scoring)
  app.get('/alerts/news', async (req, res) => {
    try {
      if (!alertsEngine) return res.json({ ok: true, data: [], message: 'Alert engine initializing' });
      const alerts = await alertsEngine.generateNewsAlerts();
      const { data, pagination } = applyListParams(alerts, req);
      res.json({ ok: true, data, ...pagination, source: 'news_intelligence' });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // GET /alerts/recent — all recent alerts from DB (combined)
  app.get('/alerts/recent', async (req, res) => {
    try {
      if (!alertsEngine) return res.json({ ok: true, data: [], message: 'Alert engine initializing' });
      const hours  = Math.min(parseInt(req.query.hours || '24'), 72);
      const type   = req.query.type || null;
      const result = await alertsEngine.getHistoricalAlerts({ type, hours });
      const { data, pagination } = applyListParams(result.data || [], req);
      res.json({ ok: true, data, ...pagination, total: result.total });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // GET /alerts/stats — alert statistics
  app.get('/alerts/stats', async (req, res) => {
    try {
      if (!alertsEngine) return res.json({ ok: true, data: null, message: 'Alert engine initializing' });
      res.json(await alertsEngine.getStats());
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

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

  // ── Rankings API (consensus engine — Phase 7) ───────────────────────────────

  // GET /rankings — top ranked stocks, filterable by category/tier/minScore
  app.get('/rankings', async (req, res) => {
    try {
      if (!rankingOrch) return res.json({ ok: true, data: [], message: 'Ranking engine initializing' });
      const category = req.query.category?.toUpperCase() || null;
      const tier     = req.query.tier?.toUpperCase()     || null;
      const minScore = parseInt(req.query.minScore || '0');
      const limit    = Math.min(parseInt(req.query.limit || '50'), 200);
      const data = await rankingOrch.getTopRankings({ category, tier, minScore, limit });
      res.json({ ok: true, data, count: data.length, source: 'redis' });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // GET /rankings/status — scan state + last run metadata
  app.get('/rankings/status', async (req, res) => {
    try {
      const status = rankingOrch?.getStatus() ?? { isRunning: false, lastRunId: null };
      res.json({ ok: true, data: status });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // GET /rankings/stock/:ticker — full consensus record for one stock
  app.get('/rankings/stock/:ticker', async (req, res) => {
    try {
      if (!rankingOrch) return res.status(503).json({ ok: false, error: 'Ranking engine initializing' });
      const data = await rankingOrch.getStockConsensus(req.params.ticker.toUpperCase());
      if (!data) return res.status(404).json({ ok: false, error: 'Stock not in latest ranking snapshot' });
      res.json({ ok: true, data });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // POST /rankings/scan — manually trigger a full scan (admin use)
  app.post('/rankings/scan', async (req, res) => {
    try {
      if (!rankingOrch) return res.status(503).json({ ok: false, error: 'Ranking engine not ready' });
      if (rankingOrch.isRunning) return res.json({ ok: true, message: 'Scan already running' });
      const categoryFilter = req.body?.categoryFilter || null;
      res.json({ ok: true, message: 'Scan triggered', runningAt: new Date().toISOString() });
      rankingOrch.runScan(categoryFilter ? { categoryFilter } : {})
        .catch(e => console.warn('[RankingOrch] Manual scan error:', e.message));
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // GET /rankings/validate — Phase 8 anti-overfitting validation report
  app.get('/rankings/validate', async (req, res) => {
    try {
      if (!validationEng) return res.status(503).json({ ok: false, error: 'Validation engine not ready' });
      const report = await validationEng.runValidation();
      res.json(report);
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

  // ── Holdings namespace fail-closed guard (PR-0) ────────────────────────────
  // Registered immediately before the SPA catch-all, so it can only be reached
  // by a /holdings-intel/* request that no mounted holdings route handled.
  //
  // Without this, an unmounted holdings route falls through to app.get('*')
  // below and returns index.html with a 200 — which would silently mask a
  // misconfiguration (e.g. a missing HOLDINGS_JWT_SECRET) behind what looks
  // like a successful response. The namespace must always answer as an API.
  app.use('/holdings-intel', (req, res) => {
    if (!holdingsAuthed) {
      return res.status(503).json({
        ok: false,
        error: 'Holdings module unavailable — HOLDINGS_JWT_SECRET is not configured',
      });
    }
    return res.status(404).json({ ok: false, error: 'Not found' });
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
