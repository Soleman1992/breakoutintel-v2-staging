// ── Portfolio Service — Phase 2 ───────────────────────────────────────────────
// Phase 1: CRUD (getPositions, addPosition, updatePosition, deletePosition)
// Phase 2: Live enrichment (getEnrichedPositions, getPortfolioSummary),
//          stock search/autocomplete (searchStocks, validateAndResolveSymbol)
//
// company_name, sector, industry are stored at position creation time so
// future analytics do not depend solely on the in-memory UNIVERSE lookup.

const { UNIVERSE, UNIVERSE_MAP } = require('./universe');

// Build a deduplicated search index once at startup
// Each entry: { sym, nseSymbol, name, exchange, sector, industry, cap }
const SEARCH_INDEX = UNIVERSE.map(s => {
  const suffix   = s.sym.endsWith('.BO') ? '.BO' : '.NS';
  const exchange = suffix === '.BO' ? 'BSE' : 'NSE';
  const nseSymbol = s.sym.replace(/\.(NS|BO)$/, '');
  return {
    sym:       s.sym,
    nseSymbol,
    name:      s.name,
    exchange,
    sector:    s.sector,
    industry:  s.industry,
    cap:       s.cap,
  };
});

// Helper: build Yahoo symbol from base symbol + exchange
function toYahooSymbol(symbol, exchange) {
  const base = symbol.replace(/\.(NS|BO)$/, '').toUpperCase();
  const suffix = (exchange || 'NSE').toUpperCase() === 'BSE' ? '.BO' : '.NS';
  return `${base}${suffix}`;
}

// Helper: days between two dates
function daysBetween(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  return Math.floor((now - d) / 86400000);
}

class PortfolioService {
  /**
   * @param {object} db     — pg Pool instance
   * @param {object} market — MarketDataService instance (may be null)
   */
  constructor(db, market = null) {
    this.db     = db;
    this.market = market;
  }

  // ── Stock Search / Autocomplete ───────────────────────────────────────────
  // Searches UNIVERSE in-memory. Zero network calls.
  // Returns top 10 results ranked: exact sym > starts-with > contains.
  searchStocks(query) {
    if (!query || query.trim().length < 1) return [];
    const q = query.trim().toUpperCase().replace(/\.(NS|BO)$/, '');

    const exact      = [];
    const startsWith = [];
    const contains   = [];

    for (const s of SEARCH_INDEX) {
      const symMatch  = s.nseSymbol.toUpperCase();
      const nameMatch = s.name.toUpperCase();

      if (symMatch === q) {
        exact.push(s);
      } else if (symMatch.startsWith(q) || nameMatch.startsWith(q)) {
        startsWith.push(s);
      } else if (symMatch.includes(q) || nameMatch.includes(q)) {
        contains.push(s);
      }
    }

    return [...exact, ...startsWith, ...contains].slice(0, 10);
  }

  // ── Symbol Validation + Metadata Resolution ───────────────────────────────
  // 1. Look up UNIVERSE_MAP for metadata (name, sector, industry, cap).
  // 2. If not in universe, probe Yahoo Finance as fallback.
  // 3. Returns { valid, yahooSym, nseSymbol, exchange, name, sector, industry,
  //              cap, cmp, fiftyTwoWeekHigh, fiftyTwoWeekLow }
  // 4. Throws if symbol is invalid and Yahoo also fails.
  async validateAndResolveSymbol(symbol, exchange = 'NSE') {
    const base      = symbol.replace(/\.(NS|BO)$/, '').toUpperCase();
    const yahooSym  = toYahooSymbol(base, exchange);
    const exch      = (exchange || 'NSE').toUpperCase() === 'BSE' ? 'BSE' : 'NSE';

    // Universe lookup
    const meta = UNIVERSE_MAP[yahooSym] || null;

    // Live price probe (also validates the symbol exists on Yahoo)
    let quote = null;
    if (this.market) {
      quote = await this.market.fetchYahooQuote(yahooSym);
      if (!quote.ok) {
        throw new Error(`Symbol "${base}" not found or not tradeable on ${exch}`);
      }
    }

    return {
      valid:           true,
      yahooSym,
      nseSymbol:       base,
      exchange:        exch,
      name:            meta?.name    || (quote?.name) || base,
      sector:          meta?.sector  || null,
      industry:        meta?.industry || null,
      cap:             meta?.cap     || null,
      cmp:             quote?.price  || null,
      fiftyTwoWeekHigh: quote?.fiftyTwoWeekHigh || null,
      fiftyTwoWeekLow:  quote?.fiftyTwoWeekLow  || null,
    };
  }

  // ── GET all positions (plain DB — Phase 1 behaviour) ──────────────────────
  async getPositions(userId) {
    const { rows } = await this.db.query(
      `SELECT id, symbol, exchange, company_name, sector, industry,
              quantity, average_buy_price,
              buy_date, stop_loss, target, notes, status,
              created_at, updated_at
         FROM positions
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [userId]
    );
    return rows;
  }

  // ── GET enriched positions with live prices ───────────────────────────────
  // Called when ?live=true. Uses Promise.allSettled so one failure never
  // blocks the rest of the portfolio.
  async getEnrichedPositions(userId) {
    const positions = await this.getPositions(userId);
    if (!positions.length) return { positions: [], missingPrices: [], partialPrices: false };

    if (!this.market) {
      return {
        positions: positions.map(p => ({ ...p, priceOk: false, cmp: null,
          investedValue: Number(p.quantity) * Number(p.average_buy_price),
          currentValue: null, pnl: null, pnlPct: null,
          allocationPct: null, daysHeld: daysBetween(p.buy_date),
          stopLossDistance: null, targetDistance: null })),
        missingPrices: positions.map(p => p.symbol),
        partialPrices: true,
        message: 'Live prices unavailable — market service not ready',
      };
    }

    // Fetch all quotes in parallel
    const quoteResults = await Promise.allSettled(
      positions.map(p => this.market.fetchYahooQuote(toYahooSymbol(p.symbol, p.exchange)))
    );

    // Calculate total invested (always available — DB only)
    const totalInvested = positions.reduce(
      (sum, p) => sum + Number(p.quantity) * Number(p.average_buy_price), 0
    );

    const missingPrices = [];
    const enriched = positions.map((p, i) => {
      const result = quoteResults[i];
      const quote  = result.status === 'fulfilled' ? result.value : null;
      const priceOk = !!(quote && quote.ok && quote.price);

      if (!priceOk) missingPrices.push(p.symbol);

      const investedValue = Number(p.quantity) * Number(p.average_buy_price);
      const cmp           = priceOk ? quote.price : null;
      const currentValue  = priceOk ? Number(p.quantity) * cmp : null;
      const pnl           = priceOk ? currentValue - investedValue : null;
      const pnlPct        = priceOk ? (pnl / investedValue) * 100 : null;
      const allocationPct = totalInvested > 0 ? (investedValue / totalInvested) * 100 : null;
      const daysHeld      = daysBetween(p.buy_date);

      const stopLossDistance = (priceOk && p.stop_loss)
        ? ((cmp - Number(p.stop_loss)) / cmp) * 100
        : null;
      const targetDistance = (priceOk && p.target)
        ? ((Number(p.target) - cmp) / cmp) * 100
        : null;

      return {
        ...p,
        cmp,
        investedValue,
        currentValue,
        pnl,
        pnlPct,
        allocationPct,
        daysHeld,
        stopLossDistance,
        targetDistance,
        priceOk,
        fiftyTwoWeekHigh: priceOk ? quote.fiftyTwoWeekHigh : null,
        fiftyTwoWeekLow:  priceOk ? quote.fiftyTwoWeekLow  : null,
        changePct:        priceOk ? quote.changePct         : null,
      };
    });

    return {
      positions: enriched,
      missingPrices,
      partialPrices: missingPrices.length > 0,
    };
  }

  // ── GET portfolio summary ─────────────────────────────────────────────────
  // Always returns totalInvested (DB only).
  // currentValue / totalPnL calculated from available prices only.
  // partialPrices=true + missingPrices[] when some symbols fail.
  async getPortfolioSummary(userId) {
    const { positions, missingPrices, partialPrices, message } =
      await this.getEnrichedPositions(userId);

    const positionCount  = positions.length;
    const totalInvested  = positions.reduce((s, p) => s + (p.investedValue || 0), 0);

    // Sum only positions where price was available
    const availablePositions = positions.filter(p => p.priceOk);
    const investedAvailable  = availablePositions.reduce((s, p) => s + (p.investedValue || 0), 0);
    const currentAvailable   = availablePositions.reduce((s, p) => s + (p.currentValue || 0), 0);

    // If we have at least some prices, calculate partial summary
    const hasAnyPrice = availablePositions.length > 0;
    const currentValue = hasAnyPrice ? currentAvailable : null;
    const totalPnL     = hasAnyPrice ? currentAvailable - investedAvailable : null;
    const totalPnLPct  = (hasAnyPrice && investedAvailable > 0)
      ? (totalPnL / investedAvailable) * 100
      : null;

    return {
      positionCount,
      totalInvested,
      currentValue,
      totalPnL,
      totalPnLPct,
      partialPrices,
      missingPrices,
      pricesAt: new Date().toISOString(),
      ...(message ? { message } : {}),
    };
  }

  // ── POST — add a position ──────────────────────────────────────────────────
  // Ensures a `users` row exists for this placeholder x-user-id before any
  // write that has a FK to users(id). Needed because there is no auth system
  // yet -- the frontend sends one fixed UUID as a placeholder, which was
  // never provisioned as an actual row. Idempotent (ON CONFLICT DO NOTHING),
  // so safe to call on every write.
  async _ensureUser(userId) {
    await this.db.query(
      `INSERT INTO users (id, email, password, name)
       VALUES ($1, $2, 'no-auth-placeholder', 'BreakoutIntel User')
       ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@no-auth.local`]
    );
  }

  async addPosition(userId, data) {
    await this._ensureUser(userId);

    const {
      symbol,
      exchange = 'NSE',
      quantity,
      average_buy_price,
      buy_date,
      stop_loss    = null,
      target       = null,
      notes        = null,
      // metadata — resolved by validateAndResolveSymbol before calling this
      company_name  = null,
      sector        = null,
      industry      = null,
      cap_category  = null,
    } = data;

    if (!symbol || !quantity || !average_buy_price) {
      throw new Error('symbol, quantity, and average_buy_price are required');
    }

    // Resolve cap_category from UNIVERSE if not provided
    const { UNIVERSE_MAP } = require('./universe');
    const exch = (exchange || 'NSE').toUpperCase();
    const suffix = exch === 'BSE' ? '.BO' : '.NS';
    const resolvedCap = cap_category
      || UNIVERSE_MAP[`${symbol.toUpperCase()}${suffix}`]?.cap
      || null;

    const { rows } = await this.db.query(
      `INSERT INTO positions
         (user_id, symbol, exchange, company_name, sector, industry,
          cap_category, quantity, average_buy_price, buy_date, stop_loss, target, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id, symbol, exchange, company_name, sector, industry,
                 cap_category, quantity, average_buy_price, buy_date, stop_loss, target,
                 notes, status, created_at, updated_at`,
      [
        userId,
        symbol.toUpperCase(),
        exch,
        company_name,
        sector,
        industry,
        resolvedCap,
        quantity,
        average_buy_price,
        buy_date || new Date().toISOString().slice(0, 10),
        stop_loss,
        target,
        notes,
      ]
    );
    return rows[0];
  }

  // ── PUT — update a position ────────────────────────────────────────────────
  async updatePosition(userId, positionId, data) {
    const allowed = [
      'symbol', 'exchange', 'company_name', 'sector', 'industry',
      'quantity', 'average_buy_price', 'buy_date',
      'stop_loss', 'target', 'notes', 'status',
    ];

    const setClauses = [];
    const values     = [];
    let idx = 1;

    for (const key of allowed) {
      if (data[key] !== undefined) {
        setClauses.push(`${key} = $${idx}`);
        values.push(
          (key === 'symbol' || key === 'exchange') && typeof data[key] === 'string'
            ? data[key].toUpperCase()
            : data[key]
        );
        idx++;
      }
    }

    if (setClauses.length === 0) {
      throw new Error('No valid fields provided for update');
    }

    values.push(positionId, userId);

    const { rows } = await this.db.query(
      `UPDATE positions
          SET ${setClauses.join(', ')}
        WHERE id = $${idx} AND user_id = $${idx + 1}
        RETURNING id, symbol, exchange, company_name, sector, industry,
                  quantity, average_buy_price, buy_date, stop_loss, target,
                  notes, status, created_at, updated_at`,
      values
    );

    if (rows.length === 0) {
      throw new Error('Position not found or not owned by user');
    }
    return rows[0];
  }

  // ── GET trade history ─────────────────────────────────────────────────────
  // Returns all BUY/SELL/PARTIAL_SELL records for the user, newest first.
  async getTradeHistory(userId) {
    const { rows } = await this.db.query(
      `SELECT id, position_id, symbol, exchange, company_name,
              action, transaction_type, quantity, price, total_value,
              pnl, pnl_pct, holding_days, notes, executed_at
         FROM trade_history
        WHERE user_id = $1
        ORDER BY executed_at DESC`,
      [userId]
    );
    return rows;
  }

  // ── GET realized performance metrics ─────────────────────────────────────
  // Calculated live from positions + trade_history. No aggregate table.
  async getPerformance(userId) {
    // Aggregate from positions
    const posResult = await this.db.query(
      `SELECT
         COUNT(*)                                                        AS total_positions,
         COUNT(*) FILTER (WHERE status = 'closed')                      AS closed_trades,
         COUNT(*) FILTER (WHERE status IN ('open','partial'))           AS open_trades,
         COUNT(*) FILTER (WHERE status = 'closed' AND realized_pnl > 0) AS winning_trades,
         COUNT(*) FILTER (WHERE status = 'closed' AND realized_pnl <= 0) AS losing_trades,
         COALESCE(SUM(realized_pnl) FILTER (WHERE status = 'closed'), 0) AS total_realized_pnl,
         COALESCE(SUM(realized_pnl) FILTER (WHERE status = 'closed' AND realized_pnl > 0), 0) AS gross_profit,
         COALESCE(ABS(SUM(realized_pnl) FILTER (WHERE status = 'closed' AND realized_pnl <= 0)), 0) AS gross_loss
       FROM positions
      WHERE user_id = $1`,
      [userId]
    );

    // Holding period averages from trade_history (sell records only)
    const holdResult = await this.db.query(
      `SELECT
         ROUND(AVG(holding_days) FILTER (WHERE pnl > 0),  1) AS avg_days_winners,
         ROUND(AVG(holding_days) FILTER (WHERE pnl <= 0), 1) AS avg_days_losers
       FROM trade_history
      WHERE user_id = $1
        AND transaction_type IN ('SELL','PARTIAL_SELL')
        AND holding_days IS NOT NULL`,
      [userId]
    );

    const p = posResult.rows[0];
    const h = holdResult.rows[0];

    const closedTrades   = parseInt(p.closed_trades)   || 0;
    const winningTrades  = parseInt(p.winning_trades)  || 0;
    const losingTrades   = parseInt(p.losing_trades)   || 0;
    const grossProfit    = Number(p.gross_profit)       || 0;
    const grossLoss      = Number(p.gross_loss)         || 0;

    return {
      totalPositions:        parseInt(p.total_positions) || 0,
      closedTrades,
      openTrades:            parseInt(p.open_trades)     || 0,
      winningTrades,
      losingTrades,
      winRate:               closedTrades > 0 ? (winningTrades / closedTrades) * 100 : null,
      lossRate:              closedTrades > 0 ? (losingTrades  / closedTrades) * 100 : null,
      totalRealizedPnL:      Number(p.total_realized_pnl) || 0,
      grossProfit,
      grossLoss,
      avgWinner:             winningTrades > 0 ? grossProfit / winningTrades : null,
      avgLoser:              losingTrades  > 0 ? grossLoss   / losingTrades  : null,
      profitFactor:          grossLoss > 0 ? grossProfit / grossLoss : null,
      avgHoldingDaysWinners: h.avg_days_winners ? Number(h.avg_days_winners) : null,
      avgHoldingDaysLosers:  h.avg_days_losers  ? Number(h.avg_days_losers)  : null,
    };
  }

  // ── DELETE — remove a position ─────────────────────────────────────────────
  async deletePosition(userId, positionId) {
    const { rowCount } = await this.db.query(
      `DELETE FROM positions
        WHERE id = $1 AND user_id = $2`,
      [positionId, userId]
    );

    if (rowCount === 0) {
      throw new Error('Position not found or not owned by user');
    }
    return { deleted: true, id: positionId };
  }
}

module.exports = PortfolioService;
