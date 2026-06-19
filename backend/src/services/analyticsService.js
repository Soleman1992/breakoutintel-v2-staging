// ── Analytics Service — Phase 4 ───────────────────────────────────────────────
// All metrics calculated live from positions + trade_history.
// No aggregate tables. No new migrations beyond 004.
// Live prices used only when market is available and caller passes live=true.

const { UNIVERSE_MAP } = require('./universe');

// Helper: resolve cap_category from UNIVERSE_MAP for a symbol
function resolveCap(symbol, exchange) {
  const suffix = (exchange || 'NSE').toUpperCase() === 'BSE' ? '.BO' : '.NS';
  const key = `${symbol.toUpperCase()}${suffix}`;
  return UNIVERSE_MAP[key]?.cap || 'Unknown';
}

// Helper: build Yahoo symbol
function toYahooSym(symbol, exchange) {
  const base = symbol.replace(/\.(NS|BO)$/, '').toUpperCase();
  const suffix = (exchange || 'NSE').toUpperCase() === 'BSE' ? '.BO' : '.NS';
  return `${base}${suffix}`;
}

// Helper: round to 2 decimal places
function r2(n) {
  return n == null ? null : Math.round(n * 100) / 100;
}

class AnalyticsService {
  /**
   * @param {object} db     — pg Pool
   * @param {object} market — MarketDataService (may be null)
   */
  constructor(db, market = null) {
    this.db     = db;
    this.market = market;
  }

  // ── ALLOCATION ANALYTICS ──────────────────────────────────────────────────
  // GET /portfolio/analytics/allocation
  // ?live=true adds unrealized P&L to sector performance
  async getAllocation(userId, live = false) {
    // Fetch all open/partial positions
    const { rows: positions } = await this.db.query(
      `SELECT id, symbol, exchange, company_name, sector, industry,
              cap_category, quantity, average_buy_price, realized_pnl, status
         FROM positions
        WHERE user_id = $1
          AND status IN ('open','partial')
        ORDER BY (quantity::numeric * average_buy_price::numeric) DESC`,
      [userId]
    );

    // Fetch closed positions for sector realized P&L
    const { rows: closedPositions } = await this.db.query(
      `SELECT sector, realized_pnl, symbol
         FROM positions
        WHERE user_id = $1 AND status = 'closed'`,
      [userId]
    );

    // Total invested (open/partial only)
    const totalInvested = positions.reduce(
      (s, p) => s + Number(p.quantity) * Number(p.average_buy_price), 0
    );

    // Live prices (if requested)
    let liveMap = {}; // symbol -> { cmp, pnl }
    let partialPrices = false;
    const missingPrices = [];

    if (live && this.market && positions.length > 0) {
      const results = await Promise.allSettled(
        positions.map(p => this.market.fetchYahooQuote(toYahooSym(p.symbol, p.exchange)))
      );
      positions.forEach((p, i) => {
        const r = results[i];
        if (r.status === 'fulfilled' && r.value?.ok && r.value.price) {
          const cmp = r.value.price;
          const invested = Number(p.quantity) * Number(p.average_buy_price);
          liveMap[p.symbol] = {
            cmp,
            unrealizedPnl: (cmp - Number(p.average_buy_price)) * Number(p.quantity),
            currentValue: cmp * Number(p.quantity),
            investedValue: invested,
          };
        } else {
          missingPrices.push(p.symbol);
          partialPrices = true;
        }
      });
    }

    // ── Sector Allocation ────────────────────────────────────────────────────
    const sectorMap = {};
    for (const p of positions) {
      const sec = p.sector || 'Unknown';
      const invested = Number(p.quantity) * Number(p.average_buy_price);
      if (!sectorMap[sec]) sectorMap[sec] = { sector: sec, invested: 0, positionCount: 0 };
      sectorMap[sec].invested += invested;
      sectorMap[sec].positionCount++;
    }
    const sectorAllocation = Object.values(sectorMap)
      .map(s => ({ ...s, invested: r2(s.invested), pct: r2(totalInvested > 0 ? (s.invested / totalInvested) * 100 : 0) }))
      .sort((a, b) => b.invested - a.invested);

    // ── Industry Allocation ──────────────────────────────────────────────────
    const industryMap = {};
    for (const p of positions) {
      const ind = p.industry || 'Unknown';
      const invested = Number(p.quantity) * Number(p.average_buy_price);
      if (!industryMap[ind]) industryMap[ind] = { industry: ind, invested: 0, positionCount: 0 };
      industryMap[ind].invested += invested;
      industryMap[ind].positionCount++;
    }
    const industryAllocation = Object.values(industryMap)
      .map(i => ({ ...i, invested: r2(i.invested), pct: r2(totalInvested > 0 ? (i.invested / totalInvested) * 100 : 0) }))
      .sort((a, b) => b.invested - a.invested);

    // ── Cap Allocation ───────────────────────────────────────────────────────
    const capMap = {};
    for (const p of positions) {
      const cap = p.cap_category || resolveCap(p.symbol, p.exchange);
      const invested = Number(p.quantity) * Number(p.average_buy_price);
      if (!capMap[cap]) capMap[cap] = { cap, invested: 0, positionCount: 0 };
      capMap[cap].invested += invested;
      capMap[cap].positionCount++;
    }
    const capAllocation = Object.values(capMap)
      .map(c => ({ ...c, invested: r2(c.invested), pct: r2(totalInvested > 0 ? (c.invested / totalInvested) * 100 : 0) }))
      .sort((a, b) => b.invested - a.invested);

    // ── Top 10 Holdings ──────────────────────────────────────────────────────
    const top10Holdings = positions.slice(0, 10).map(p => {
      const invested = Number(p.quantity) * Number(p.average_buy_price);
      const lv = liveMap[p.symbol];
      return {
        symbol:       p.symbol,
        company_name: p.company_name,
        sector:       p.sector,
        invested:     r2(invested),
        pct:          r2(totalInvested > 0 ? (invested / totalInvested) * 100 : 0),
        currentValue: lv ? r2(lv.currentValue) : null,
        unrealizedPnl: lv ? r2(lv.unrealizedPnl) : null,
      };
    });

    // ── Sector Performance ───────────────────────────────────────────────────
    // Combine open + closed positions per sector
    const sectorPerfMap = {};

    // Open/partial — unrealized
    for (const p of positions) {
      const sec = p.sector || 'Unknown';
      if (!sectorPerfMap[sec]) {
        sectorPerfMap[sec] = {
          sector: sec, investedValue: 0, allocationPct: 0,
          realizedPnL: 0, unrealizedPnL: null,
          openCount: 0, closedCount: 0,
          positions: [],
        };
      }
      const invested = Number(p.quantity) * Number(p.average_buy_price);
      sectorPerfMap[sec].investedValue += invested;
      sectorPerfMap[sec].openCount++;
      const lv = liveMap[p.symbol];
      if (lv) {
        sectorPerfMap[sec].unrealizedPnL = (sectorPerfMap[sec].unrealizedPnL || 0) + lv.unrealizedPnl;
      }
      sectorPerfMap[sec].positions.push({
        symbol: p.symbol,
        pnl: lv ? lv.unrealizedPnl : null,
        realized: Number(p.realized_pnl) || 0,
      });
    }

    // Closed — realized
    for (const p of closedPositions) {
      const sec = p.sector || 'Unknown';
      if (!sectorPerfMap[sec]) {
        sectorPerfMap[sec] = {
          sector: sec, investedValue: 0, allocationPct: 0,
          realizedPnL: 0, unrealizedPnL: null,
          openCount: 0, closedCount: 0,
          positions: [],
        };
      }
      sectorPerfMap[sec].realizedPnL += Number(p.realized_pnl) || 0;
      sectorPerfMap[sec].closedCount++;
      sectorPerfMap[sec].positions.push({
        symbol: p.symbol,
        pnl: Number(p.realized_pnl) || 0,
        realized: Number(p.realized_pnl) || 0,
      });
    }

    const sectorPerformance = Object.values(sectorPerfMap).map(s => {
      // Best/worst position within sector
      const withPnl = s.positions.filter(p => p.pnl != null);
      const best  = withPnl.length > 0 ? withPnl.reduce((a, b) => a.pnl > b.pnl ? a : b).symbol : null;
      const worst = withPnl.length > 0 ? withPnl.reduce((a, b) => a.pnl < b.pnl ? a : b).symbol : null;
      const totalPnL = s.unrealizedPnL != null
        ? r2(s.realizedPnL + s.unrealizedPnL)
        : r2(s.realizedPnL);
      return {
        sector:        s.sector,
        investedValue: r2(s.investedValue),
        allocationPct: r2(totalInvested > 0 ? (s.investedValue / totalInvested) * 100 : 0),
        realizedPnL:   r2(s.realizedPnL),
        unrealizedPnL: s.unrealizedPnL != null ? r2(s.unrealizedPnL) : null,
        totalPnL,
        openCount:     s.openCount,
        closedCount:   s.closedCount,
        bestPosition:  best,
        worstPosition: worst,
      };
    }).sort((a, b) => (b.totalPnL || 0) - (a.totalPnL || 0));

    const bestSector  = sectorPerformance[0]?.sector || null;
    const worstSector = sectorPerformance[sectorPerformance.length - 1]?.sector || null;

    return {
      totalInvested:     r2(totalInvested),
      positionCount:     positions.length,
      sectorAllocation,
      industryAllocation,
      capAllocation,
      top10Holdings,
      sectorPerformance,
      bestSector,
      worstSector,
      ...(live ? { partialPrices, missingPrices } : {}),
    };
  }

  // ── RISK ANALYTICS ────────────────────────────────────────────────────────
  // GET /portfolio/analytics/risk
  async getRisk(userId) {
    const { rows: positions } = await this.db.query(
      `SELECT symbol, exchange, sector, quantity, average_buy_price, cap_category
         FROM positions
        WHERE user_id = $1 AND status IN ('open','partial')`,
      [userId]
    );

    // Cash realized
    const { rows: cashRows } = await this.db.query(
      `SELECT COALESCE(SUM(total_value), 0) AS cash_realized
         FROM trade_history
        WHERE user_id = $1 AND transaction_type IN ('SELL','PARTIAL_SELL')`,
      [userId]
    );

    if (positions.length === 0) {
      return {
        positionCount: 0, largestPositionPct: null, largestPositionSymbol: null,
        top5PositionsPct: null, stockConcentrationRisk: 'LOW',
        sectorConcentrationRisk: 'LOW', topSector: null, topSectorPct: null,
        hhiScore: 0, hhiLabel: 'Diversified',
        capitalDeployed: 0, cashRealized: r2(Number(cashRows[0].cash_realized)),
        totalCapital: r2(Number(cashRows[0].cash_realized)), exposurePct: 0,
      };
    }

    const positionsWithValue = positions.map(p => ({
      symbol:   p.symbol,
      sector:   p.sector || 'Unknown',
      invested: Number(p.quantity) * Number(p.average_buy_price),
    }));

    const totalInvested = positionsWithValue.reduce((s, p) => s + p.invested, 0);
    const sorted = [...positionsWithValue].sort((a, b) => b.invested - a.invested);

    // Largest position
    const largest = sorted[0];
    const largestPct = totalInvested > 0 ? (largest.invested / totalInvested) * 100 : 0;

    // Top 5 positions
    const top5 = sorted.slice(0, 5);
    const top5Pct = totalInvested > 0
      ? (top5.reduce((s, p) => s + p.invested, 0) / totalInvested) * 100
      : 0;

    // Sector concentration
    const sectorMap = {};
    for (const p of positionsWithValue) {
      sectorMap[p.sector] = (sectorMap[p.sector] || 0) + p.invested;
    }
    const topSectorEntry = Object.entries(sectorMap).sort((a, b) => b[1] - a[1])[0];
    const topSectorPct = totalInvested > 0 ? (topSectorEntry[1] / totalInvested) * 100 : 0;

    // HHI — Herfindahl-Hirschman Index
    const hhi = positionsWithValue.reduce((s, p) => {
      const w = totalInvested > 0 ? p.invested / totalInvested : 0;
      return s + w * w * 10000;
    }, 0);
    const hhiLabel = hhi < 1500 ? 'Diversified' : hhi < 2500 ? 'Moderate' : 'Concentrated';

    // Concentration risk labels
    const stockRisk   = largestPct > 20 ? 'HIGH' : largestPct > 10 ? 'MEDIUM' : 'LOW';
    const sectorRisk  = topSectorPct > 40 ? 'HIGH' : topSectorPct > 25 ? 'MEDIUM' : 'LOW';

    // Portfolio Exposure
    const capitalDeployed = totalInvested;
    const cashRealized    = Number(cashRows[0].cash_realized) || 0;
    const totalCapital    = capitalDeployed + cashRealized;
    const exposurePct     = totalCapital > 0 ? (capitalDeployed / totalCapital) * 100 : 0;

    return {
      positionCount:           positions.length,
      largestPositionPct:      r2(largestPct),
      largestPositionSymbol:   largest.symbol,
      top5PositionsPct:        r2(top5Pct),
      stockConcentrationRisk:  stockRisk,
      sectorConcentrationRisk: sectorRisk,
      topSector:               topSectorEntry[0],
      topSectorPct:            r2(topSectorPct),
      hhiScore:                Math.round(hhi),
      hhiLabel,
      capitalDeployed:         r2(capitalDeployed),
      cashRealized:            r2(cashRealized),
      totalCapital:            r2(totalCapital),
      exposurePct:             r2(exposurePct),
    };
  }

  // ── PERFORMANCE ANALYTICS ─────────────────────────────────────────────────
  // GET /portfolio/analytics/performance
  // ?live=true adds unrealized P&L for open positions
  async getPerformanceAnalytics(userId, live = false) {
    // Closed positions — realized
    const { rows: closed } = await this.db.query(
      `SELECT id, symbol, company_name, sector, realized_pnl,
              average_buy_price, exit_price, closed_at,
              quantity, buy_date
         FROM positions
        WHERE user_id = $1 AND status = 'closed'
        ORDER BY realized_pnl DESC`,
      [userId]
    );

    // Open/partial positions
    const { rows: open } = await this.db.query(
      `SELECT id, symbol, exchange, company_name, sector,
              quantity, average_buy_price, buy_date, stop_loss, target
         FROM positions
        WHERE user_id = $1 AND status IN ('open','partial')`,
      [userId]
    );

    // Realized totals
    const totalRealized = closed.reduce((s, p) => s + Number(p.realized_pnl), 0);
    const totalOpenInvested = open.reduce(
      (s, p) => s + Number(p.quantity) * Number(p.average_buy_price), 0
    );

    // Best / worst closed trade
    const bestTrade  = closed.length > 0 ? closed[0] : null;
    const worstTrade = closed.length > 0 ? closed[closed.length - 1] : null;

    // Live enrichment for open positions
    let unrealizedTotal = null;
    let topWinners = [];
    let topLosers  = [];
    let partialPrices = false;
    const missingPrices = [];

    if (live && this.market && open.length > 0) {
      const results = await Promise.allSettled(
        open.map(p => this.market.fetchYahooQuote(toYahooSym(p.symbol, p.exchange)))
      );
      const enriched = open.map((p, i) => {
        const r = results[i];
        if (r.status === 'fulfilled' && r.value?.ok && r.value.price) {
          const cmp = r.value.price;
          const invested = Number(p.quantity) * Number(p.average_buy_price);
          const pnl = (cmp - Number(p.average_buy_price)) * Number(p.quantity);
          const pnlPct = (pnl / invested) * 100;
          const daysHeld = Math.floor((Date.now() - new Date(p.buy_date).getTime()) / 86400000);
          return { ...p, cmp, pnl, pnlPct, daysHeld, priceOk: true };
        } else {
          missingPrices.push(p.symbol);
          partialPrices = true;
          return { ...p, cmp: null, pnl: null, pnlPct: null, daysHeld: null, priceOk: false };
        }
      });

      const withPrices = enriched.filter(p => p.priceOk);
      unrealizedTotal = withPrices.reduce((s, p) => s + p.pnl, 0);

      const sortedByPnlPct = [...withPrices].sort((a, b) => b.pnlPct - a.pnlPct);
      topWinners = sortedByPnlPct.slice(0, 5).map(p => ({
        symbol: p.symbol, company_name: p.company_name, sector: p.sector,
        cmp: r2(p.cmp), pnl: r2(p.pnl), pnlPct: r2(p.pnlPct), daysHeld: p.daysHeld,
      }));
      topLosers = sortedByPnlPct.slice(-5).reverse().map(p => ({
        symbol: p.symbol, company_name: p.company_name, sector: p.sector,
        cmp: r2(p.cmp), pnl: r2(p.pnl), pnlPct: r2(p.pnlPct), daysHeld: p.daysHeld,
      }));
    }

    return {
      // Realized
      closedTradeCount:   closed.length,
      totalRealizedPnL:   r2(totalRealized),
      bestTrade: bestTrade ? {
        symbol:       bestTrade.symbol,
        company_name: bestTrade.company_name,
        realizedPnL:  r2(Number(bestTrade.realized_pnl)),
        closedAt:     bestTrade.closed_at,
      } : null,
      worstTrade: worstTrade ? {
        symbol:       worstTrade.symbol,
        company_name: worstTrade.company_name,
        realizedPnL:  r2(Number(worstTrade.realized_pnl)),
        closedAt:     worstTrade.closed_at,
      } : null,
      // Unrealized
      openTradeCount:     open.length,
      totalOpenInvested:  r2(totalOpenInvested),
      totalUnrealizedPnL: unrealizedTotal != null ? r2(unrealizedTotal) : null,
      totalPnL:           unrealizedTotal != null ? r2(totalRealized + unrealizedTotal) : null,
      // Live winners/losers
      topWinners,
      topLosers,
      // Open vs closed
      openVsClosed: {
        openCount:   open.length,
        closedCount: closed.length,
        openInvested: r2(totalOpenInvested),
        realizedPnL:  r2(totalRealized),
      },
      ...(live ? { partialPrices, missingPrices } : {}),
    };
  }

  // ── TIMELINE ANALYTICS ────────────────────────────────────────────────────
  // GET /portfolio/analytics/timeline
  async getTimeline(userId) {
    // Monthly performance
    const { rows: monthly } = await this.db.query(
      `SELECT
         TO_CHAR(DATE_TRUNC('month', executed_at), 'YYYY-MM') AS month,
         COALESCE(SUM(pnl) FILTER (WHERE pnl > 0), 0)         AS gross_profit,
         COALESCE(ABS(SUM(pnl) FILTER (WHERE pnl < 0)), 0)    AS gross_loss,
         COALESCE(SUM(pnl), 0)                                 AS net_pnl,
         COUNT(*) FILTER (WHERE pnl > 0)                       AS wins,
         COUNT(*) FILTER (WHERE pnl < 0)                       AS losses,
         COUNT(*)                                               AS total_trades
       FROM trade_history
      WHERE user_id = $1
        AND transaction_type IN ('SELL','PARTIAL_SELL')
      GROUP BY DATE_TRUNC('month', executed_at)
      ORDER BY DATE_TRUNC('month', executed_at) DESC`,
      [userId]
    );

    // Weekly performance (last 12 weeks)
    const { rows: weekly } = await this.db.query(
      `SELECT
         TO_CHAR(DATE_TRUNC('week', executed_at), 'YYYY-MM-DD') AS week_start,
         COALESCE(SUM(pnl) FILTER (WHERE pnl > 0), 0)           AS gross_profit,
         COALESCE(ABS(SUM(pnl) FILTER (WHERE pnl < 0)), 0)      AS gross_loss,
         COALESCE(SUM(pnl), 0)                                   AS net_pnl,
         COUNT(*) FILTER (WHERE pnl > 0)                         AS wins,
         COUNT(*) FILTER (WHERE pnl < 0)                         AS losses
       FROM trade_history
      WHERE user_id = $1
        AND transaction_type IN ('SELL','PARTIAL_SELL')
        AND executed_at >= NOW() - INTERVAL '12 weeks'
      GROUP BY DATE_TRUNC('week', executed_at)
      ORDER BY DATE_TRUNC('week', executed_at) DESC`,
      [userId]
    );

    // Holding period stats
    const { rows: holdRows } = await this.db.query(
      `SELECT
         ROUND(AVG(holding_days), 1)                              AS avg_holding_days,
         ROUND(AVG(holding_days) FILTER (WHERE pnl > 0),  1)     AS avg_days_winners,
         ROUND(AVG(holding_days) FILTER (WHERE pnl <= 0), 1)     AS avg_days_losers,
         MIN(holding_days)                                         AS min_holding_days,
         MAX(holding_days)                                         AS max_holding_days
       FROM trade_history
      WHERE user_id = $1
        AND transaction_type IN ('SELL','PARTIAL_SELL')
        AND holding_days IS NOT NULL`,
      [userId]
    );

    const h = holdRows[0];

    return {
      monthly: monthly.map(m => ({
        month:       m.month,
        grossProfit: r2(Number(m.gross_profit)),
        grossLoss:   r2(Number(m.gross_loss)),
        netPnL:      r2(Number(m.net_pnl)),
        wins:        parseInt(m.wins),
        losses:      parseInt(m.losses),
        totalTrades: parseInt(m.total_trades),
        winRate:     parseInt(m.total_trades) > 0
          ? r2((parseInt(m.wins) / parseInt(m.total_trades)) * 100)
          : null,
      })),
      weekly: weekly.map(w => ({
        weekStart:   w.week_start,
        grossProfit: r2(Number(w.gross_profit)),
        grossLoss:   r2(Number(w.gross_loss)),
        netPnL:      r2(Number(w.net_pnl)),
        wins:        parseInt(w.wins),
        losses:      parseInt(w.losses),
      })),
      holdingPeriod: {
        avgDays:        h.avg_holding_days ? Number(h.avg_holding_days) : null,
        avgDaysWinners: h.avg_days_winners ? Number(h.avg_days_winners) : null,
        avgDaysLosers:  h.avg_days_losers  ? Number(h.avg_days_losers)  : null,
        minDays:        h.min_holding_days != null ? Number(h.min_holding_days) : null,
        maxDays:        h.max_holding_days != null ? Number(h.max_holding_days) : null,
      },
    };
  }

  // ── PORTFOLIO HEALTH ──────────────────────────────────────────────────────
  // GET /portfolio/analytics/health
  async getHealth(userId) {
    // Capital deployed (open/partial)
    const { rows: deployedRows } = await this.db.query(
      `SELECT COALESCE(SUM(quantity::numeric * average_buy_price::numeric), 0) AS capital_deployed
         FROM positions
        WHERE user_id = $1 AND status IN ('open','partial')`,
      [userId]
    );

    // Cash realized (total sell proceeds)
    const { rows: cashRows } = await this.db.query(
      `SELECT COALESCE(SUM(total_value), 0) AS cash_realized
         FROM trade_history
        WHERE user_id = $1 AND transaction_type IN ('SELL','PARTIAL_SELL')`,
      [userId]
    );

    // Overall performance metrics
    const { rows: perfRows } = await this.db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'closed')                       AS closed_trades,
         COUNT(*) FILTER (WHERE status IN ('open','partial'))            AS open_trades,
         COUNT(*) FILTER (WHERE status = 'closed' AND realized_pnl > 0) AS winning_trades,
         COUNT(*) FILTER (WHERE status = 'closed' AND realized_pnl <= 0) AS losing_trades,
         COALESCE(SUM(realized_pnl) FILTER (WHERE status = 'closed'), 0) AS total_realized_pnl,
         COALESCE(SUM(realized_pnl) FILTER (WHERE status = 'closed' AND realized_pnl > 0), 0) AS gross_profit,
         COALESCE(ABS(SUM(realized_pnl) FILTER (WHERE status = 'closed' AND realized_pnl <= 0)), 0) AS gross_loss
       FROM positions
      WHERE user_id = $1`,
      [userId]
    );

    // Win rate trend: last 90 days vs prior 90 days
    const { rows: trendRows } = await this.db.query(
      `SELECT
         COUNT(*) FILTER (WHERE executed_at >= NOW() - INTERVAL '90 days')                                AS current_total,
         COUNT(*) FILTER (WHERE executed_at >= NOW() - INTERVAL '90 days' AND pnl > 0)                   AS current_wins,
         COALESCE(SUM(pnl) FILTER (WHERE executed_at >= NOW() - INTERVAL '90 days' AND pnl > 0), 0)      AS current_profit,
         COALESCE(ABS(SUM(pnl) FILTER (WHERE executed_at >= NOW() - INTERVAL '90 days' AND pnl < 0)), 0) AS current_loss,
         COUNT(*) FILTER (WHERE executed_at BETWEEN NOW() - INTERVAL '180 days' AND NOW() - INTERVAL '90 days') AS prior_total,
         COUNT(*) FILTER (WHERE executed_at BETWEEN NOW() - INTERVAL '180 days' AND NOW() - INTERVAL '90 days' AND pnl > 0) AS prior_wins,
         COALESCE(SUM(pnl) FILTER (WHERE executed_at BETWEEN NOW() - INTERVAL '180 days' AND NOW() - INTERVAL '90 days' AND pnl > 0), 0) AS prior_profit,
         COALESCE(ABS(SUM(pnl) FILTER (WHERE executed_at BETWEEN NOW() - INTERVAL '180 days' AND NOW() - INTERVAL '90 days' AND pnl < 0)), 0) AS prior_loss
       FROM trade_history
      WHERE user_id = $1
        AND transaction_type IN ('SELL','PARTIAL_SELL')`,
      [userId]
    );

    const p = perfRows[0];
    const t = trendRows[0];

    const closedTrades  = parseInt(p.closed_trades)  || 0;
    const winningTrades = parseInt(p.winning_trades) || 0;
    const losingTrades  = parseInt(p.losing_trades)  || 0;
    const grossProfit   = Number(p.gross_profit)      || 0;
    const grossLoss     = Number(p.gross_loss)        || 0;

    const currentTotal  = parseInt(t.current_total) || 0;
    const currentWins   = parseInt(t.current_wins)  || 0;
    const priorTotal    = parseInt(t.prior_total)   || 0;
    const priorWins     = parseInt(t.prior_wins)    || 0;
    const currentProfit = Number(t.current_profit)  || 0;
    const currentLoss   = Number(t.current_loss)    || 0;
    const priorProfit   = Number(t.prior_profit)    || 0;
    const priorLoss     = Number(t.prior_loss)      || 0;

    const currentWinRate = currentTotal > 0 ? (currentWins / currentTotal) * 100 : null;
    const priorWinRate   = priorTotal   > 0 ? (priorWins   / priorTotal)   * 100 : null;
    const winRateTrend   = (currentWinRate != null && priorWinRate != null)
      ? r2(currentWinRate - priorWinRate) : null;

    const currentPF = currentLoss > 0 ? r2(currentProfit / currentLoss) : null;
    const priorPF   = priorLoss   > 0 ? r2(priorProfit   / priorLoss)   : null;
    const pfTrend   = (currentPF != null && priorPF != null) ? r2(currentPF - priorPF) : null;

    const capitalDeployed = Number(deployedRows[0].capital_deployed) || 0;
    const cashRealized    = Number(cashRows[0].cash_realized)        || 0;

    return {
      capitalDeployed:    r2(capitalDeployed),
      cashRealized:       r2(cashRealized),
      totalCapital:       r2(capitalDeployed + cashRealized),
      exposurePct:        r2((capitalDeployed + cashRealized) > 0
        ? (capitalDeployed / (capitalDeployed + cashRealized)) * 100 : 0),
      closedTrades,
      openTrades:         parseInt(p.open_trades) || 0,
      winningTrades,
      losingTrades,
      winRate:            closedTrades > 0 ? r2((winningTrades / closedTrades) * 100) : null,
      lossRate:           closedTrades > 0 ? r2((losingTrades  / closedTrades) * 100) : null,
      totalRealizedPnL:   r2(Number(p.total_realized_pnl) || 0),
      grossProfit:        r2(grossProfit),
      grossLoss:          r2(grossLoss),
      avgWinner:          winningTrades > 0 ? r2(grossProfit / winningTrades) : null,
      avgLoser:           losingTrades  > 0 ? r2(grossLoss   / losingTrades)  : null,
      profitFactor:       grossLoss > 0 ? r2(grossProfit / grossLoss) : null,
      trend: {
        winRateCurrent:   currentWinRate != null ? r2(currentWinRate) : null,
        winRatePrior:     priorWinRate   != null ? r2(priorWinRate)   : null,
        winRateTrend,
        winRateTrendLabel: winRateTrend == null ? null
          : winRateTrend > 0 ? 'Improving' : winRateTrend < 0 ? 'Declining' : 'Stable',
        profitFactorCurrent: currentPF,
        profitFactorPrior:   priorPF,
        profitFactorTrend:   pfTrend,
      },
    };
  }
}

module.exports = AnalyticsService;
