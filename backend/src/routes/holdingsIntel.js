// ── Holdings Intelligence Routes — PR-1a ─────────────────────────────────────
// Mounted at /holdings-intel in index.js.
//
//   POST   /holdings-intel/import      — Zerodha Console statement (XLSX or CSV)
//   GET    /holdings-intel/holdings    — holdings + derived metrics (?live=true)
//   GET    /holdings-intel/summary     — portfolio totals only
//   GET    /holdings-intel/audit       — import history
//   DELETE /holdings-intel/holdings    — purge (irreversible)
//
// EVERY route is behind requireHoldingsAuth. The user id comes from the verified
// JWT and nowhere else — `x-user-id`, which the rest of the app trusts, is
// structurally stripped by the middleware and can never authenticate here.

const express = require('express');
const rateLimit = require('express-rate-limit');
const requireHoldingsAuth = require('../auth/requireHoldingsAuth');

const MAX_UPLOAD_BYTES = 512 * 1024;

module.exports = function holdingsIntelRoutes(db, holdings, analytics = null, research = null, assistant = null) {
  const router = express.Router();

  router.use(requireHoldingsAuth(db));

  // Tighter than the app-wide 200/min. Import does file parsing plus a live-price
  // probe per row, so it is the expensive surface.
  const readLimiter   = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false });
  const importLimiter = rateLimit({
    windowMs: 60_000, max: 6, standardHeaders: true, legacyHeaders: false,
    message: { ok: false, error: 'Too many imports. Wait a minute and try again.' },
  });

  const ready = (res) => {
    if (!holdings) {
      res.status(503).json({ ok: false, error: 'Holdings service not ready' });
      return false;
    }
    return true;
  };

  // ── POST /import ─────────────────────────────────────────────────────────
  // The file arrives as raw bytes (application/octet-stream), not multipart —
  // that avoids a multer dependency entirely. The browser sends the File object
  // directly as the request body.
  router.post(
    '/import',
    importLimiter,
    express.raw({ type: '*/*', limit: MAX_UPLOAD_BYTES }),
    async (req, res) => {
      try {
        if (!ready(res)) return;

        const fileName = String(req.query.filename || 'holdings').slice(0, 120);
        const result = await holdings.importHoldings(req.holdingsUser.id, req.body, fileName);

        // 200 even when reconciliation fails: the rows DID import. The caller must
        // see reconciled=false and surface it rather than treat the import as clean.
        res.json({ ok: true, data: result });
      } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
      }
    }
  );

  // ── GET /holdings ────────────────────────────────────────────────────────
  router.get('/holdings', readLimiter, async (req, res) => {
    try {
      if (!ready(res)) return;
      const live = req.query.live === 'true';
      res.json({ ok: true, data: await holdings.getHoldings(req.holdingsUser.id, { live }) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── GET /summary ─────────────────────────────────────────────────────────
  router.get('/summary', readLimiter, async (req, res) => {
    try {
      if (!ready(res)) return;
      const live = req.query.live === 'true';
      const { totals, priceStatus, stalePrices } =
        await holdings.getHoldings(req.holdingsUser.id, { live });
      res.json({ ok: true, data: { ...totals, priceStatus, stalePrices } });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── GET /audit ───────────────────────────────────────────────────────────
  router.get('/audit', readLimiter, async (req, res) => {
    try {
      if (!ready(res)) return;
      res.json({ ok: true, data: await holdings.getAudit(req.holdingsUser.id) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Analytics (PR-1b) ────────────────────────────────────────────────────
  const analyticsReady = (res) => {
    if (!analytics) {
      res.status(503).json({ ok: false, error: 'Analytics service not ready' });
      return false;
    }
    return true;
  };

  // GET /allocation — sector / asset class / concentration / best + worst
  router.get('/allocation', readLimiter, async (req, res) => {
    try {
      if (!ready(res) || !analyticsReady(res)) return;
      const live = req.query.live !== 'false';
      res.json({ ok: true, data: await analytics.getAllocation(req.holdingsUser.id, { live }) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /risk — volatility, beta, drawdown, correlation.
  // Fetches a year of daily bars per holding, so it is the slow endpoint; it gets
  // its own tighter limiter rather than sharing the read budget.
  const riskLimiter = rateLimit({
    windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false,
    message: { ok: false, error: 'Risk analytics is rate limited. Wait a moment.' },
  });

  router.get('/risk', riskLimiter, async (req, res) => {
    try {
      if (!ready(res) || !analyticsReady(res)) return;
      res.json({ ok: true, data: await analytics.getRisk(req.holdingsUser.id) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /health — composite score with an explanation for every component
  router.get('/health', riskLimiter, async (req, res) => {
    try {
      if (!ready(res) || !analyticsReady(res)) return;
      res.json({ ok: true, data: await analytics.getHealth(req.holdingsUser.id) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Research + Assistant (PR-1c) ─────────────────────────────────────────
  // Both are DETERMINISTIC — no language model is involved. Every figure in a
  // response is computed from the user's own data, which is why none of it can
  // be fabricated.

  // GET /report/:symbol — per-holding research
  router.get('/report/:symbol', riskLimiter, async (req, res) => {
    try {
      if (!ready(res)) return;
      if (!research) return res.status(503).json({ ok: false, error: 'Research service not ready' });
      const data = await research.getReport(req.holdingsUser.id, req.params.symbol);
      res.json({ ok: true, data });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // POST /ask — natural-language question over the portfolio
  router.post('/ask', readLimiter, async (req, res) => {
    try {
      if (!ready(res)) return;
      if (!assistant) return res.status(503).json({ ok: false, error: 'Assistant not ready' });

      const question = String((req.body && req.body.question) || '').slice(0, 500);
      if (!question.trim()) {
        return res.status(400).json({ ok: false, error: 'question is required' });
      }

      const data = await assistant.ask(req.holdingsUser.id, question);
      res.json({ ok: true, data });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── DELETE /holdings ─────────────────────────────────────────────────────
  // Irreversible. Requires ?confirm=yes so a stray call cannot wipe the portfolio.
  router.delete('/holdings', readLimiter, async (req, res) => {
    try {
      if (!ready(res)) return;
      if (req.query.confirm !== 'yes') {
        return res.status(400).json({
          ok: false,
          error: 'Refusing to purge without ?confirm=yes — this deletes every holding and cannot be undone.',
        });
      }
      res.json({ ok: true, data: await holdings.purge(req.holdingsUser.id) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
};
