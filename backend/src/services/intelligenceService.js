// ── Intelligence Service — Phase 5 ───────────────────────────────────────────
// Pure computation layer. Reads from positions, trade_history, analyticsService,
// scanner.lastResults, and MarketDataService. Writes nothing to the database.
//
// All six intelligence methods share a single _fetchLivePrices() call when
// invoked from getAlerts() or the aggregated GET /portfolio/intelligence endpoint.
// No symbol is fetched more than once per request.

function r2(n) {
  return n == null ? null : Math.round(n * 100) / 100;
}

function toYahooSym(symbol, exchange) {
  const base = symbol.replace(/\.(NS|BO)$/, '').toUpperCase();
  const suffix = (exchange || 'NSE').toUpperCase() === 'BSE' ? '.BO' : '.NS';
  return `${base}${suffix}`;
}

function daysBetween(dateStr) {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

function scannerAge(lastScanAt) {
  if (!lastScanAt) return null;
  const ms = Date.now() - new Date(lastScanAt).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

// ── Position scoring helpers ──────────────────────────────────────────────────

function scorePnl(pnlPct) {
  if (pnlPct == null) return 10; // neutral fallback
  if (pnlPct >= 20) return 25;
  if (pnlPct >= 10) return 20;
  if (pnlPct >= 5)  return 15;
  if (pnlPct >= 0)  return 10;
  if (pnlPct >= -5) return 6;
  if (pnlPct >= -10) return 3;
  return 0;
}

function scoreStopDistance(cmp, stopLoss) {
  if (stopLoss == null || stopLoss === 0) return 8; // neutral
  if (cmp == null) return 8; // neutral fallback
  if (cmp < stopLoss) return 0; // breached
  const pct = (cmp - stopLoss) / cmp * 100;
  if (pct >= 15) return 20;
  if (pct >= 10) return 16;
  if (pct >= 7)  return 12;
  if (pct >= 4)  return 8;
  if (pct >= 2)  return 4;
  return 0;
}

function scoreTargetDistance(cmp, target) {
  if (target == null || target === 0) return 10; // neutral
  if (cmp == null) return 10; // neutral fallback
  if (cmp >= target) return 2; // target reached
  const pct = (target - cmp) / cmp * 100;
  if (pct >= 20) return 20;
  if (pct >= 10) return 16;
  if (pct >= 5)  return 12;
  if (pct >= 2)  return 8;
  return 4;
}

function scoreHoldingPeriod(daysHeld) {
  if (daysHeld >= 365) return 3;
  if (daysHeld >= 181) return 6;
  if (daysHeld >= 91)  return 12;
  if (daysHeld >= 15)  return 15;
  return 8;
}

function scoreAllocation(allocationPct) {
  if (allocationPct == null) return 5; // neutral
  if (allocationPct <= 10) return 10;
  if (allocationPct <= 15) return 7;
  if (allocationPct <= 20) return 4;
  return 1;
}

function scoreDrawdown(cmp, hi52) {
  if (cmp == null || hi52 == null || hi52 === 0) return 5; // neutral
  const pct = (hi52 - cmp) / hi52 * 100;
  if (pct <= 5)  return 10;
  if (pct <= 15) return 8;
  if (pct <= 25) return 5;
  if (pct <= 40) return 2;
  return 0;
}

function scoreToLabel(score) {
  if (score >= 75) return 'Strong Hold';
  if (score >= 55) return 'Hold';
  if (score >= 40) return 'Reduce';
  if (score >= 25) return 'Watch Closely';
  return 'High Risk';
}

// ── Profit factor label ───────────────────────────────────────────────────────

function profitFactorLabel(pf) {
  if (pf == null) return 'Insufficient data';
  if (pf >= 3.0) return 'Excellent';
  if (pf >= 2.0) return 'Strong';
  if (pf >= 1.5) return 'Good';
  if (pf >= 1.0) return 'Breakeven';
  return 'Losing';
}

// ─────────────────────────────────────────────────────────────────────────────

class IntelligenceService {
  /**
   * @param {object} db        — pg Pool
   * @param {object} market    — MarketDataService (injected after startup)
   * @param {object} analytics — AnalyticsService (Phase 4)
   * @param {object} scanner   — ScannerService (injected after startup)
   */
  constructor(db, market = null, analytics = null, scanner = null) {
    this.db        = db;
    this.market    = market;
    this.analytics = analytics;
    this.scanner   = scanner;
  }

  // ── Shared price fetch ────────────────────────────────────────────────────
  // Returns Map<symbol, quote>. Called once per request; passed to sub-methods.
  async _fetchLivePrices(positions) {
    const map = new Map();
    if (!this.market || !positions || positions.length === 0) return map;

    const results = await Promise.allSettled(
      positions.map(p => this.market.fetchYahooQuote(toYahooSym(p.symbol, p.exchange)))
    );
    positions.forEach((p, i) => {
      const r = results[i];
      if (r.status === 'fulfilled' && r.value?.ok && r.value.price) {
        map.set(p.symbol, r.value);
      }
    });
    return map;
  }

  // ── Fetch open positions from DB ──────────────────────────────────────────
  async _getOpenPositions(userId) {
    const { rows } = await this.db.query(
      `SELECT id, symbol, exchange, company_name, sector, industry,
              cap_category, quantity, average_buy_price, buy_date,
              stop_loss, target, realized_pnl, status
         FROM positions
        WHERE user_id = $1
          AND status IN ('open','partial')
        ORDER BY (quantity::numeric * average_buy_price::numeric) DESC`,
      [userId]
    );
    return rows;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 1. POSITION INTELLIGENCE
  // ══════════════════════════════════════════════════════════════════════════
  async getPositionIntelligence(userId, live = false, priceMap = null) {
    const positions = await this._getOpenPositions(userId);
    const generatedAt = new Date().toISOString();

    if (positions.length === 0) {
      return {
        positions: [],
        summary: { strongHold: 0, hold: 0, reduce: 0, watchClosely: 0, highRisk: 0, portfolioHealthScore: null },
        partialPrices: false,
        generatedAt,
      };
    }

    // Fetch prices if live and no shared map provided
    let pMap = priceMap;
    if (live && !pMap) pMap = await this._fetchLivePrices(positions);

    const totalInvested = positions.reduce(
      (s, p) => s + Number(p.quantity) * Number(p.average_buy_price), 0
    );

    const missingPrices = [];
    const scored = positions.map(p => {
      const invested     = Number(p.quantity) * Number(p.average_buy_price);
      const allocationPct = totalInvested > 0 ? (invested / totalInvested) * 100 : 0;
      const daysHeld     = daysBetween(p.buy_date);
      const quote        = live && pMap ? pMap.get(p.symbol) : null;
      const priceOk      = !!(quote && quote.price);

      if (live && !priceOk) missingPrices.push(p.symbol);

      const cmp    = priceOk ? quote.price : null;
      const hi52   = priceOk ? quote.fiftyTwoWeekHigh : null;
      const pnlPct = priceOk ? ((cmp - Number(p.average_buy_price)) / Number(p.average_buy_price)) * 100 : null;

      const stopLossVal  = p.stop_loss  ? Number(p.stop_loss)  : null;
      const targetVal    = p.target     ? Number(p.target)     : null;

      const stopLossDistance = (priceOk && stopLossVal)
        ? r2((cmp - stopLossVal) / cmp * 100) : null;
      const targetDistance = (priceOk && targetVal)
        ? r2((targetVal - cmp) / cmp * 100) : null;

      const pnlScore            = scorePnl(pnlPct);
      const stopDistanceScore   = scoreStopDistance(cmp, stopLossVal);
      const targetDistanceScore = scoreTargetDistance(cmp, targetVal);
      const holdingPeriodScore  = scoreHoldingPeriod(daysHeld);
      const allocationScore     = scoreAllocation(allocationPct);
      const drawdownScore       = scoreDrawdown(cmp, hi52);

      const score = pnlScore + stopDistanceScore + targetDistanceScore +
                    holdingPeriodScore + allocationScore + drawdownScore;
      const label = scoreToLabel(score);
      const scorePartial = !priceOk;

      return {
        positionId:    p.id,
        symbol:        p.symbol,
        exchange:      p.exchange,
        company_name:  p.company_name,
        sector:        p.sector,
        cap_category:  p.cap_category,
        score,
        label,
        scorePartial,
        scoreBreakdown: {
          pnlScore,
          stopDistanceScore,
          targetDistanceScore,
          holdingPeriodScore,
          allocationScore,
          drawdownScore,
        },
        cmp:              cmp != null ? r2(cmp) : null,
        pnlPct:           pnlPct != null ? r2(pnlPct) : null,
        stopLossDistance,
        targetDistance,
        daysHeld,
        allocationPct:    r2(allocationPct),
        priceOk,
      };
    });

    // Summary counts
    const summary = { strongHold: 0, hold: 0, reduce: 0, watchClosely: 0, highRisk: 0 };
    for (const s of scored) {
      if (s.label === 'Strong Hold')   summary.strongHold++;
      else if (s.label === 'Hold')     summary.hold++;
      else if (s.label === 'Reduce')   summary.reduce++;
      else if (s.label === 'Watch Closely') summary.watchClosely++;
      else summary.highRisk++;
    }

    // Portfolio health score — allocation-weighted average
    const withAlloc = scored.filter(s => s.allocationPct != null && s.allocationPct > 0);
    const totalAllocUsed = withAlloc.reduce((s, p) => s + p.allocationPct, 0);
    const portfolioHealthScore = (withAlloc.length > 0 && totalAllocUsed > 0)
      ? Math.round(withAlloc.reduce((s, p) => s + p.score * p.allocationPct, 0) / totalAllocUsed)
      : null;

    summary.portfolioHealthScore = portfolioHealthScore;

    return {
      positions:     scored,
      summary,
      partialPrices: missingPrices.length > 0,
      missingPrices: live ? missingPrices : undefined,
      generatedAt,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 2. EXIT INTELLIGENCE
  // ══════════════════════════════════════════════════════════════════════════
  async getExitIntelligence(userId, live = false, priceMap = null) {
    const generatedAt = new Date().toISOString();

    if (!live) {
      return {
        signals: [],
        criticalCount: 0,
        warningCount: 0,
        infoCount: 0,
        partialPrices: false,
        message: 'live=true required for exit signals',
        generatedAt,
      };
    }

    const positions = await this._getOpenPositions(userId);
    if (positions.length === 0) {
      return { signals: [], criticalCount: 0, warningCount: 0, infoCount: 0, partialPrices: false, generatedAt };
    }

    let pMap = priceMap;
    if (!pMap) pMap = await this._fetchLivePrices(positions);

    const signals = [];
    const missingPrices = [];

    for (const p of positions) {
      const quote   = pMap.get(p.symbol);
      const priceOk = !!(quote && quote.price);
      if (!priceOk) { missingPrices.push(p.symbol); continue; }

      const cmp        = quote.price;
      const avgCost    = Number(p.average_buy_price);
      const stopLoss   = p.stop_loss ? Number(p.stop_loss) : null;
      const target     = p.target    ? Number(p.target)    : null;
      const pnlPct     = ((cmp - avgCost) / avgCost) * 100;

      const base = {
        positionId:   p.id,
        symbol:       p.symbol,
        exchange:     p.exchange,
        company_name: p.company_name,
        cmp:          r2(cmp),
        stopLoss:     stopLoss != null ? r2(stopLoss) : null,
        target:       target   != null ? r2(target)   : null,
        pnlPct:       r2(pnlPct),
      };

      // Stop loss signals
      if (stopLoss != null) {
        if (cmp < stopLoss) {
          signals.push({ ...base, signalType: 'STOP_LOSS_BREACHED', severity: 'CRITICAL',
            message: `CMP ₹${r2(cmp)} is below stop loss ₹${r2(stopLoss)}` });
        } else {
          const dist = (cmp - stopLoss) / cmp * 100;
          if (dist < 3) {
            signals.push({ ...base, signalType: 'STOP_LOSS_NEAR', severity: 'WARNING',
              message: `CMP ₹${r2(cmp)} is within ${r2(dist)}% of stop loss ₹${r2(stopLoss)}` });
          }
        }
      }

      // Target signals
      if (target != null) {
        if (cmp >= target) {
          signals.push({ ...base, signalType: 'TARGET_REACHED', severity: 'WARNING',
            message: `CMP ₹${r2(cmp)} has reached target ₹${r2(target)}` });
        } else {
          const dist = (target - cmp) / cmp * 100;
          if (dist <= 5) {
            signals.push({ ...base, signalType: 'TARGET_NEAR', severity: 'INFO',
              message: `CMP ₹${r2(cmp)} is within ${r2(dist)}% of target ₹${r2(target)}` });
          }
        }
      }

      // Drawdown signals — mutually exclusive
      if (pnlPct <= -25) {
        signals.push({ ...base, signalType: 'CRITICAL_DRAWDOWN', severity: 'CRITICAL',
          message: `Position is down ${r2(Math.abs(pnlPct))}% — critical drawdown` });
      } else if (pnlPct <= -15) {
        signals.push({ ...base, signalType: 'EXCESSIVE_DRAWDOWN', severity: 'WARNING',
          message: `Position is down ${r2(Math.abs(pnlPct))}% — excessive drawdown` });
      } else if (pnlPct <= -10) {
        // LARGE_UNREALIZED_LOSS only fires in range (-15%, -10%]
        signals.push({ ...base, signalType: 'LARGE_UNREALIZED_LOSS', severity: 'WARNING',
          message: `Position has a large unrealized loss of ${r2(Math.abs(pnlPct))}%` });
      }

      // Large gain
      if (pnlPct >= 25) {
        signals.push({ ...base, signalType: 'LARGE_UNREALIZED_GAIN', severity: 'INFO',
          message: `Position has a large unrealized gain of ${r2(pnlPct)}%` });
      }
    }

    const criticalCount = signals.filter(s => s.severity === 'CRITICAL').length;
    const warningCount  = signals.filter(s => s.severity === 'WARNING').length;
    const infoCount     = signals.filter(s => s.severity === 'INFO').length;

    return {
      signals,
      criticalCount,
      warningCount,
      infoCount,
      partialPrices: missingPrices.length > 0,
      missingPrices,
      generatedAt,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3. PORTFOLIO INTELLIGENCE
  // ══════════════════════════════════════════════════════════════════════════
  async getPortfolioIntelligence(userId) {
    const generatedAt = new Date().toISOString();

    if (!this.analytics) {
      return { warnings: [], riskLevel: 'LOW', hhiScore: 0, hhiLabel: 'Diversified', exposurePct: 0, warningCount: 0, generatedAt };
    }

    const [risk, allocation] = await Promise.all([
      this.analytics.getRisk(userId),
      this.analytics.getAllocation(userId, false),
    ]);

    const warnings = [];

    // Overweight position
    if (risk.largestPositionPct != null) {
      if (risk.largestPositionPct > 30) {
        warnings.push({
          type: 'OVERWEIGHT_POSITION', severity: 'CRITICAL',
          symbol: risk.largestPositionSymbol,
          value: risk.largestPositionPct, threshold: 30,
          message: `${risk.largestPositionSymbol} is ${risk.largestPositionPct}% of portfolio — exceeds 30% critical limit`,
        });
      } else if (risk.largestPositionPct > 20) {
        warnings.push({
          type: 'OVERWEIGHT_POSITION', severity: 'WARNING',
          symbol: risk.largestPositionSymbol,
          value: risk.largestPositionPct, threshold: 20,
          message: `${risk.largestPositionSymbol} is ${risk.largestPositionPct}% of portfolio — exceeds 20% single-stock limit`,
        });
      }
    }

    // Overweight sector
    if (allocation.sectorAllocation) {
      for (const sec of allocation.sectorAllocation) {
        if (sec.pct > 50) {
          warnings.push({
            type: 'OVERWEIGHT_SECTOR', severity: 'CRITICAL',
            sector: sec.sector, value: sec.pct, threshold: 50,
            message: `${sec.sector} sector is ${sec.pct}% of portfolio — exceeds 50% critical limit`,
          });
        } else if (sec.pct > 35) {
          warnings.push({
            type: 'OVERWEIGHT_SECTOR', severity: 'WARNING',
            sector: sec.sector, value: sec.pct, threshold: 35,
            message: `${sec.sector} sector is ${sec.pct}% of portfolio — exceeds 35% limit`,
          });
        }
      }
    }

    // HHI concentration
    if (risk.hhiScore != null) {
      if (risk.hhiScore > 2500) {
        warnings.push({
          type: 'CONCENTRATION_WARNING', severity: 'CRITICAL',
          value: risk.hhiScore, threshold: 2500,
          message: `Portfolio HHI is ${risk.hhiScore} — highly concentrated`,
        });
      } else if (risk.hhiScore > 1500) {
        warnings.push({
          type: 'CONCENTRATION_WARNING', severity: 'WARNING',
          value: risk.hhiScore, threshold: 1500,
          message: `Portfolio HHI is ${risk.hhiScore} — moderate concentration`,
        });
      }
    }

    // Exposure
    if (risk.exposurePct != null) {
      if (risk.exposurePct > 95) {
        warnings.push({
          type: 'EXPOSURE_WARNING', severity: 'CRITICAL',
          value: risk.exposurePct, threshold: 95,
          message: `${risk.exposurePct}% of capital is deployed — critically high exposure`,
        });
      } else if (risk.exposurePct > 85) {
        warnings.push({
          type: 'EXPOSURE_WARNING', severity: 'WARNING',
          value: risk.exposurePct, threshold: 85,
          message: `${risk.exposurePct}% of capital is deployed — high exposure`,
        });
      }
    }

    // Risk escalation — both stock and sector concentration HIGH
    if (risk.stockConcentrationRisk === 'HIGH' && risk.sectorConcentrationRisk === 'HIGH') {
      warnings.push({
        type: 'RISK_ESCALATION', severity: 'WARNING',
        message: 'Both stock and sector concentration are HIGH — portfolio risk is elevated',
      });
    }

    const hasCritical = warnings.some(w => w.severity === 'CRITICAL');
    const hasWarning  = warnings.some(w => w.severity === 'WARNING');
    const riskLevel   = hasCritical ? 'HIGH' : hasWarning ? 'MEDIUM' : 'LOW';

    return {
      warnings,
      riskLevel,
      hhiScore:     risk.hhiScore,
      hhiLabel:     risk.hhiLabel,
      exposurePct:  risk.exposurePct,
      warningCount: warnings.length,
      generatedAt,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 4. TRADE QUALITY INTELLIGENCE
  // ══════════════════════════════════════════════════════════════════════════
  async getTradeQualityIntelligence(userId) {
    const generatedAt = new Date().toISOString();

    if (!this.analytics) {
      return {
        sectorPerformance: { best: null, worst: null, all: [] },
        tradePatterns: { best: null, worst: null, all: [] },
        avgWinner: null, avgLoser: null,
        profitFactor: null, profitFactorLabel: 'Insufficient data',
        holdingPeriod: { avgDays: null, avgDaysWinners: null, avgDaysLosers: null, insight: 'Insufficient data' },
        winRate: null, closedTrades: 0, generatedAt,
      };
    }

    // Parallel fetch of Phase 4 analytics + holding period bucket query
    const [allocation, health, timeline, bucketResult] = await Promise.all([
      this.analytics.getAllocation(userId, false),
      this.analytics.getHealth(userId),
      this.analytics.getTimeline(userId),
      this.db.query(
        `SELECT
           CASE
             WHEN holding_days <= 3   THEN 'Scalp (≤3d)'
             WHEN holding_days <= 14  THEN 'Short Hold (4–14d)'
             WHEN holding_days <= 60  THEN 'Swing (15–60d)'
             WHEN holding_days <= 180 THEN 'Position (61–180d)'
             ELSE                          'Long Hold (>180d)'
           END AS pattern,
           COUNT(*)                                                        AS trade_count,
           ROUND(AVG(pnl_pct), 2)                                         AS avg_pnl_pct,
           COUNT(*) FILTER (WHERE pnl > 0)                                AS wins,
           ROUND(
             COUNT(*) FILTER (WHERE pnl > 0)::numeric / NULLIF(COUNT(*),0) * 100, 1
           )                                                               AS win_rate
         FROM trade_history
        WHERE user_id = $1
          AND transaction_type IN ('SELL','PARTIAL_SELL')
          AND holding_days IS NOT NULL
        GROUP BY 1
        ORDER BY avg_pnl_pct DESC NULLS LAST`,
        [userId]
      ),
    ]);

    // Sector performance — best/worst by totalPnL (realized only, live=false)
    const sectorPerf = (allocation.sectorPerformance || []).filter(s => s.closedCount > 0);
    const bestSector  = sectorPerf.length > 0 ? sectorPerf[0] : null;
    const worstSector = sectorPerf.length > 0 ? sectorPerf[sectorPerf.length - 1] : null;

    // Trade patterns
    const BUCKET_ORDER = ['Scalp (≤3d)', 'Short Hold (4–14d)', 'Swing (15–60d)', 'Position (61–180d)', 'Long Hold (>180d)'];
    const bucketMap = {};
    for (const row of bucketResult.rows) {
      bucketMap[row.pattern] = {
        pattern:    row.pattern,
        avgPnLPct:  row.avg_pnl_pct != null ? Number(row.avg_pnl_pct) : null,
        winRate:    row.win_rate    != null ? Number(row.win_rate)    : null,
        count:      parseInt(row.trade_count) || 0,
      };
    }
    const allBuckets = BUCKET_ORDER.map(name => bucketMap[name] || { pattern: name, avgPnLPct: null, winRate: null, count: 0 });
    const qualified  = allBuckets.filter(b => b.count >= 3 && b.avgPnLPct != null);
    const bestPattern  = qualified.length > 0 ? qualified[0] : null;
    const worstPattern = qualified.length > 0 ? qualified[qualified.length - 1] : null;

    // Holding period insight
    const hp = timeline.holdingPeriod || {};
    let insight = 'Insufficient data for holding period comparison';
    if (hp.avgDaysWinners != null && hp.avgDaysLosers != null && hp.avgDaysLosers > 0) {
      const ratio = Math.round((hp.avgDaysWinners / hp.avgDaysLosers) * 10) / 10;
      insight = `Winners held ${ratio}x longer than losers`;
    }

    return {
      sectorPerformance: {
        best:  bestSector  ? { sector: bestSector.sector,  totalPnL: bestSector.totalPnL,  winRate: null, tradeCount: bestSector.closedCount  } : null,
        worst: worstSector ? { sector: worstSector.sector, totalPnL: worstSector.totalPnL, winRate: null, tradeCount: worstSector.closedCount } : null,
        all:   allocation.sectorPerformance || [],
      },
      tradePatterns: {
        best:  bestPattern,
        worst: worstPattern,
        all:   allBuckets,
      },
      avgWinner:         health.avgWinner    != null ? r2(health.avgWinner)    : null,
      avgLoser:          health.avgLoser     != null ? r2(health.avgLoser)     : null,
      profitFactor:      health.profitFactor != null ? r2(health.profitFactor) : null,
      profitFactorLabel: profitFactorLabel(health.profitFactor),
      holdingPeriod: {
        avgDays:        hp.avgDays        != null ? Number(hp.avgDays)        : null,
        avgDaysWinners: hp.avgDaysWinners != null ? Number(hp.avgDaysWinners) : null,
        avgDaysLosers:  hp.avgDaysLosers  != null ? Number(hp.avgDaysLosers)  : null,
        insight,
      },
      winRate:      health.winRate     != null ? r2(health.winRate)     : null,
      closedTrades: health.closedTrades || 0,
      generatedAt,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 5. MARKET CONTEXT INTELLIGENCE
  // ══════════════════════════════════════════════════════════════════════════
  async getMarketContextIntelligence(userId, live = false, priceMap = null) {
    const generatedAt = new Date().toISOString();
    const positions   = await this._getOpenPositions(userId);

    if (positions.length === 0) {
      return {
        signals: [], rsLeaders: [], rsWeakness: [],
        rsSignalCoverage: 'scanner_only',
        scannerAge: this.scanner ? scannerAge(this.scanner.lastMeta?.lastScanAt) : null,
        positionsChecked: 0, signalCount: 0, partialPrices: false, generatedAt,
      };
    }

    // Build scanner lookup map (sym -> result)
    const scannerMap = new Map();
    if (this.scanner && this.scanner.lastResults) {
      for (const r of this.scanner.lastResults) {
        scannerMap.set(r.sym, r);
      }
    }

    // Fetch live prices if needed (for 52wk signals)
    let pMap = priceMap;
    if (live && !pMap) pMap = await this._fetchLivePrices(positions);

    const signals    = [];
    const rsLeaders  = [];
    const rsWeakness = [];
    const missingPrices = [];

    for (const p of positions) {
      const scanResult = scannerMap.get(p.symbol);
      const quote      = live && pMap ? pMap.get(p.symbol) : null;
      const priceOk    = !!(quote && quote.price);
      if (live && !priceOk) missingPrices.push(p.symbol);

      const cmp = priceOk ? quote.price : (scanResult?.cmp ?? null);

      const base = {
        positionId:   p.id,
        symbol:       p.symbol,
        exchange:     p.exchange,
        company_name: p.company_name,
        cmp:          cmp != null ? r2(cmp) : null,
      };

      // Scanner-based signals
      if (scanResult) {
        if (scanResult.cat === 'active') {
          signals.push({
            ...base,
            signalType: 'IN_BREAKOUT',
            stratName:  scanResult.stratName || scanResult.strat,
            category:   scanResult.cat,
            rs:         scanResult.rs,
            conf:       scanResult.conf,
            message:    `${p.symbol} is in an active ${scanResult.stratName || scanResult.strat} breakout (conf: ${scanResult.conf}/10)`,
          });
        }

        if (scanResult.vol >= 2.5) {
          signals.push({
            ...base,
            signalType: 'VOLUME_SURGE',
            volRatio:   scanResult.vol,
            message:    `${p.symbol} has a ${scanResult.vol}x volume surge today`,
          });
        }

        if (scanResult.rs >= 80) {
          rsLeaders.push(p.symbol);
          signals.push({
            ...base,
            signalType: 'RS_LEADER',
            rs:         scanResult.rs,
            message:    `${p.symbol} is a relative strength leader (RS: ${scanResult.rs})`,
          });
        } else if (scanResult.rs < 40) {
          rsWeakness.push(p.symbol);
          signals.push({
            ...base,
            signalType: 'RS_WEAKNESS',
            rs:         scanResult.rs,
            message:    `${p.symbol} shows relative weakness (RS: ${scanResult.rs})`,
          });
        }
      }

      // Live-price-based 52wk signals
      if (priceOk) {
        const hi52 = quote.fiftyTwoWeekHigh;
        const lo52 = quote.fiftyTwoWeekLow;

        if (hi52 && hi52 > 0) {
          const distFromHigh = (hi52 - quote.price) / hi52 * 100;
          if (distFromHigh <= 5) {
            signals.push({
              ...base,
              signalType:   'NEAR_52W_HIGH',
              proximity52w: r2(100 - distFromHigh),
              message:      `${p.symbol} is within ${r2(distFromHigh)}% of its 52-week high`,
            });
          }
        }

        if (lo52 && lo52 > 0) {
          const distFromLow = (quote.price - lo52) / lo52 * 100;
          if (distFromLow <= 5) {
            signals.push({
              ...base,
              signalType: 'NEAR_52W_LOW',
              message:    `${p.symbol} is within ${r2(distFromLow)}% above its 52-week low`,
            });
          }
        }
      }
    }

    return {
      signals,
      rsLeaders,
      rsWeakness,
      rsSignalCoverage:  'scanner_only',
      scannerAge:        this.scanner ? scannerAge(this.scanner.lastMeta?.lastScanAt) : null,
      positionsChecked:  positions.length,
      signalCount:       signals.length,
      partialPrices:     missingPrices.length > 0,
      missingPrices:     live ? missingPrices : undefined,
      generatedAt,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 6. ALERTS — aggregated, price-fetch deduplicated
  // ══════════════════════════════════════════════════════════════════════════
  async getAlerts(userId, live = false) {
    const generatedAt = new Date().toISOString();
    const positions   = await this._getOpenPositions(userId);

    // Fetch prices once — shared across all sub-modules
    const pMap = live ? await this._fetchLivePrices(positions) : new Map();

    // Run all modules in parallel, passing the shared price map
    const [exitData, portfolioData, marketData] = await Promise.all([
      this.getExitIntelligence(userId, live, pMap),
      this.getPortfolioIntelligence(userId),
      this.getMarketContextIntelligence(userId, live, pMap),
    ]);

    const alerts = [];

    // Exit alerts
    for (const sig of exitData.signals || []) {
      alerts.push({
        id:           `exit_${sig.symbol}_${sig.signalType}`,
        type:         sig.signalType,
        severity:     sig.severity,
        symbol:       sig.symbol,
        company_name: sig.company_name,
        message:      sig.message,
        module:       'exit',
        data:         { cmp: sig.cmp, stopLoss: sig.stopLoss, target: sig.target, pnlPct: sig.pnlPct },
        generatedAt,
      });
    }

    // Portfolio alerts
    for (const warn of portfolioData.warnings || []) {
      alerts.push({
        id:           `portfolio_${warn.symbol || warn.sector || warn.type}_${warn.type}`,
        type:         warn.type,
        severity:     warn.severity,
        symbol:       warn.symbol || null,
        company_name: null,
        message:      warn.message,
        module:       'portfolio',
        data:         { value: warn.value, threshold: warn.threshold, sector: warn.sector || null },
        generatedAt,
      });
    }

    // Market alerts
    const marketAlertTypeMap = {
      IN_BREAKOUT:   'PORTFOLIO_STOCK_BREAKOUT',
      VOLUME_SURGE:  'PORTFOLIO_STOCK_VOLUME_SURGE',
      NEAR_52W_HIGH: 'PORTFOLIO_STOCK_NEAR_52W_HIGH',
      NEAR_52W_LOW:  'PORTFOLIO_STOCK_NEAR_52W_LOW',
      RS_LEADER:     'RS_LEADER_IN_PORTFOLIO',
      RS_WEAKNESS:   'RS_WEAKNESS_IN_PORTFOLIO',
    };
    const marketSeverityMap = {
      IN_BREAKOUT:   'INFO',
      VOLUME_SURGE:  'INFO',
      NEAR_52W_HIGH: 'INFO',
      NEAR_52W_LOW:  'WARNING',
      RS_LEADER:     'INFO',
      RS_WEAKNESS:   'WARNING',
    };
    for (const sig of marketData.signals || []) {
      const alertType = marketAlertTypeMap[sig.signalType] || sig.signalType;
      const severity  = marketSeverityMap[sig.signalType]  || 'INFO';
      alerts.push({
        id:           `market_${sig.symbol}_${alertType}`,
        type:         alertType,
        severity,
        symbol:       sig.symbol,
        company_name: sig.company_name,
        message:      sig.message,
        module:       'market',
        data:         { cmp: sig.cmp, volRatio: sig.volRatio || null, rs: sig.rs || null },
        generatedAt,
      });
    }

    // Sort: CRITICAL → WARNING → INFO, then by module: exit → portfolio → market
    const severityOrder = { CRITICAL: 0, WARNING: 1, INFO: 2 };
    const moduleOrder   = { exit: 0, portfolio: 1, market: 2 };
    alerts.sort((a, b) => {
      const sd = (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3);
      if (sd !== 0) return sd;
      return (moduleOrder[a.module] ?? 3) - (moduleOrder[b.module] ?? 3);
    });

    const criticalAlerts = alerts.filter(a => a.severity === 'CRITICAL').length;
    const warningAlerts  = alerts.filter(a => a.severity === 'WARNING').length;
    const infoAlerts     = alerts.filter(a => a.severity === 'INFO').length;

    return {
      alerts,
      totalAlerts:    alerts.length,
      criticalAlerts,
      warningAlerts,
      infoAlerts,
      generatedAt,
    };
  }
}

module.exports = IntelligenceService;
