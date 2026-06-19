// ── Intelligence Routes — Phase 5 ────────────────────────────────────────────
// Mounted at /portfolio/intelligence in index.js
// All endpoints require x-user-id header.

const express = require('express');

function userGuard(req, res) {
  const userId = req.headers['x-user-id'];
  if (!userId) {
    res.status(400).json({ ok: false, error: 'x-user-id header required' });
    return null;
  }
  return userId;
}

function serviceGuard(intelligence, res) {
  if (!intelligence) {
    res.status(503).json({ ok: false, error: 'Intelligence service not ready' });
    return false;
  }
  return true;
}

/**
 * @param {import('../services/intelligenceService')} intelligence
 */
module.exports = function intelligenceRouter(intelligence) {
  const router = express.Router();

  // ── GET /portfolio/intelligence ─────────────────────────────────────────
  // Aggregated full snapshot — all six modules, prices fetched once.
  router.get('/', async (req, res) => {
    try {
      if (!serviceGuard(intelligence, res)) return;
      const userId = userGuard(req, res); if (!userId) return;
      const live = req.query.live === 'true';

      // Fetch positions once, build shared price map
      const positions = await intelligence._getOpenPositions(userId);
      const pMap      = live ? await intelligence._fetchLivePrices(positions) : new Map();

      const [posData, exitData, portfolioData, tradeQualityData, marketData, alertsData] =
        await Promise.all([
          intelligence.getPositionIntelligence(userId, live, pMap),
          intelligence.getExitIntelligence(userId, live, pMap),
          intelligence.getPortfolioIntelligence(userId),
          intelligence.getTradeQualityIntelligence(userId),
          intelligence.getMarketContextIntelligence(userId, live, pMap),
          intelligence.getAlerts(userId, live),
        ]);

      const partialPrices = live && (
        (posData.partialPrices)  ||
        (exitData.partialPrices) ||
        (marketData.partialPrices)
      );

      res.json({
        ok: true,
        data: {
          positions:    posData,
          exit:         exitData,
          portfolio:    portfolioData,
          tradeQuality: tradeQualityData,
          market:       marketData,
          alerts:       alertsData,
          generatedAt:  new Date().toISOString(),
          partialPrices: !!partialPrices,
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── GET /portfolio/intelligence/positions ───────────────────────────────
  router.get('/positions', async (req, res) => {
    try {
      if (!serviceGuard(intelligence, res)) return;
      const userId = userGuard(req, res); if (!userId) return;
      const live = req.query.live === 'true';
      const data = await intelligence.getPositionIntelligence(userId, live);
      res.json({ ok: true, data });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── GET /portfolio/intelligence/exit ────────────────────────────────────
  router.get('/exit', async (req, res) => {
    try {
      if (!serviceGuard(intelligence, res)) return;
      const userId = userGuard(req, res); if (!userId) return;
      const live = req.query.live === 'true';
      const data = await intelligence.getExitIntelligence(userId, live);
      res.json({ ok: true, data });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── GET /portfolio/intelligence/portfolio ───────────────────────────────
  router.get('/portfolio', async (req, res) => {
    try {
      if (!serviceGuard(intelligence, res)) return;
      const userId = userGuard(req, res); if (!userId) return;
      const data = await intelligence.getPortfolioIntelligence(userId);
      res.json({ ok: true, data });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── GET /portfolio/intelligence/trade-quality ───────────────────────────
  router.get('/trade-quality', async (req, res) => {
    try {
      if (!serviceGuard(intelligence, res)) return;
      const userId = userGuard(req, res); if (!userId) return;
      const data = await intelligence.getTradeQualityIntelligence(userId);
      res.json({ ok: true, data });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── GET /portfolio/intelligence/market ──────────────────────────────────
  router.get('/market', async (req, res) => {
    try {
      if (!serviceGuard(intelligence, res)) return;
      const userId = userGuard(req, res); if (!userId) return;
      const live = req.query.live === 'true';
      const data = await intelligence.getMarketContextIntelligence(userId, live);
      res.json({ ok: true, data });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── GET /portfolio/intelligence/alerts ──────────────────────────────────
  // ?live=true   — enables CMP-based alerts
  // ?severity=   — filter by CRITICAL / WARNING / INFO
  router.get('/alerts', async (req, res) => {
    try {
      if (!serviceGuard(intelligence, res)) return;
      const userId = userGuard(req, res); if (!userId) return;
      const live     = req.query.live === 'true';
      const severity = (req.query.severity || '').toUpperCase();
      let data = await intelligence.getAlerts(userId, live);

      if (severity && ['CRITICAL', 'WARNING', 'INFO'].includes(severity)) {
        const filtered = data.alerts.filter(a => a.severity === severity);
        data = {
          ...data,
          alerts:         filtered,
          totalAlerts:    filtered.length,
          criticalAlerts: filtered.filter(a => a.severity === 'CRITICAL').length,
          warningAlerts:  filtered.filter(a => a.severity === 'WARNING').length,
          infoAlerts:     filtered.filter(a => a.severity === 'INFO').length,
        };
      }

      res.json({ ok: true, data });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
};
