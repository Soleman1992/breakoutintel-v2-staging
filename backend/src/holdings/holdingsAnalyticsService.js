// ── Holdings Analytics — allocation, risk, health ────────────────────────────
//
// Computation only. Reads broker_holdings and 1-year daily price history; writes
// nothing. Every figure is derived on request, so nothing here can go stale.
//
// What this module deliberately does NOT do:
//   * Fundamentals (PE, ROE, debt/equity, earnings quality) — no data source is
//     wired up, and inventing them would be worse than omitting them.
//   * XIRR, CAGR, realised P&L, dividend income, win rate — these need transaction
//     history, which a holdings snapshot does not contain. They arrive with the
//     tradebook import, not before.
// Both are reported as explicit `unavailable` entries rather than silently absent.

const M = require('./portfolioMath');

const BENCHMARK = '^NSEI';          // Nifty 50
const HISTORY_CONCURRENCY = 6;      // be a good citizen with Yahoo
const MIN_BARS = 60;                // below this, a volatility/beta figure is noise

class HoldingsAnalyticsService {
  /**
   * @param {object} holdingsService  BrokerHoldingsService
   * @param {object} market           MarketDataService (may be null)
   */
  constructor(holdingsService, market = null) {
    this.holdings = holdingsService;
    this.market   = market;
  }

  set marketService(m) { this.market = m; }

  // ── Price history ─────────────────────────────────────────────────────────
  /**
   * Fetch 1y of daily bars for a Yahoo symbol.
   *
   * marketData.fetchDailyOHLCV() forces a .NS suffix, which is wrong for the BSE
   * holdings in a real portfolio — so we call the underlying fetcher with the
   * symbol we already resolved. Read-only use of an existing method; nothing in
   * marketData is modified.
   */
  async _history(yahooSym) {
    if (!this.market) return [];
    try {
      if (typeof this.market._fetchYahooOHLCV === 'function') {
        return await this.market._fetchYahooOHLCV(yahooSym, '1d', '1y');
      }
      return await this.market.fetchDailyOHLCV(yahooSym);
    } catch {
      return [];
    }
  }

  async _historyMany(symbols) {
    const out = new Map();
    for (let i = 0; i < symbols.length; i += HISTORY_CONCURRENCY) {
      const batch = symbols.slice(i, i + HISTORY_CONCURRENCY);
      const res = await Promise.allSettled(batch.map(s => this._history(s)));
      batch.forEach((s, j) => {
        out.set(s, res[j].status === 'fulfilled' ? (res[j].value || []) : []);
      });
    }
    return out;
  }

  // ── Allocation + performers (no price history needed) ─────────────────────
  async getAllocation(userId, { live = true } = {}) {
    const { holdings, totals } = await this.holdings.getHoldings(userId, { live });
    if (!holdings.length) return { empty: true, totals };

    const weights = holdings.map(h => h.weightPct).filter(w => w !== null);

    // Sector uses the BROKER's taxonomy: it is present for every holding, whereas
    // the app's UNIVERSE only recognises a handful of them. Using UNIVERSE here
    // would dump most of the portfolio into "Unclassified" and make the chart lie.
    const bySector     = M.allocateBy(holdings, h => h.broker_sector);
    const byAssetClass = M.allocateBy(holdings, h => h.asset_class);
    const byExchange   = M.allocateBy(holdings, h => h.exchange);

    // Market cap is only known for holdings the UNIVERSE recognises. Report the
    // coverage honestly instead of presenting a mostly-unclassified pie.
    const capKnown = holdings.filter(h => h.cap_category).length;
    const byMarketCap = capKnown > 0 ? M.allocateBy(holdings, h => h.cap_category) : [];

    return {
      empty: false,
      totals,
      bySector,
      byAssetClass,
      byExchange,
      byMarketCap,
      marketCapCoverage: {
        known: capKnown,
        total: holdings.length,
        note: capKnown < holdings.length
          ? `Market cap is known for ${capKnown} of ${holdings.length} holdings — the rest are not in the app's stock universe. Treat this breakdown as partial.`
          : null,
      },
      concentration: {
        hhi:            M.hhi(weights),
        effectiveN:     M.effectiveN(weights),
        topWeight:      weights.length ? Math.max(...weights) : null,
        top3Weight:     M.topNWeight(weights, 3),
        top5Weight:     M.topNWeight(weights, 5),
        holdingsCount:  holdings.length,
      },
      positions: holdings.map(h => ({
        symbol: h.symbol, sector: h.broker_sector, assetClass: h.asset_class,
        currentValue: h.currentValue, investedValue: h.investedValue,
        pnl: h.pnl, pnlPct: h.pnlPct, weightPct: h.weightPct,
      })),
      performers: this._performers(holdings),
    };
  }

  /**
   * Best and worst holdings, ranked three ways — because they answer different
   * questions. The biggest percentage gain is not necessarily what is actually
   * moving the portfolio; contribution is.
   */
  _performers(holdings) {
    const withPnl = holdings.filter(h => h.pnl !== null && h.pnlPct !== null);
    const totalInvested = withPnl.reduce((s, h) => s + h.investedValue, 0);

    const enriched = withPnl.map(h => ({
      symbol: h.symbol,
      sector: h.broker_sector,
      pnl: h.pnl,
      pnlPct: h.pnlPct,
      weightPct: h.weightPct,
      // How much of the portfolio's total return this holding is responsible for.
      contributionPct: totalInvested > 0 ? (h.pnl / totalInvested) * 100 : null,
      dayChangePct: h.dayChangePct,
    }));

    const byPct  = [...enriched].sort((a, b) => b.pnlPct - a.pnlPct);
    const byAbs  = [...enriched].sort((a, b) => b.pnl - a.pnl);
    const byCont = [...enriched].sort((a, b) => (b.contributionPct ?? 0) - (a.contributionPct ?? 0));

    return {
      bestByReturn:  byPct.slice(0, 5),
      worstByReturn: byPct.slice(-5).reverse(),
      bestByProfit:  byAbs.slice(0, 5),
      worstByLoss:   byAbs.slice(-5).reverse(),
      topContributors: byCont.slice(0, 5),
      topDetractors:   byCont.slice(-5).reverse(),
    };
  }

  // ── Risk + health (needs price history) ───────────────────────────────────
  async getRisk(userId) {
    const { holdings } = await this.holdings.getHoldings(userId, { live: true });
    if (!holdings.length) return { empty: true };

    if (!this.market) {
      return { empty: false, unavailable: true, reason: 'Market data service is not available, so risk cannot be computed.' };
    }

    const symOf = (h) => `${h.symbol.replace(/-(T|XT|E|BE|BZ|SM|ST|IT|GB|GS|N\d)$/i, '')}${h.exchange === 'BSE' ? '.BO' : '.NS'}`;

    const symbols = holdings.map(symOf);
    const hist    = await this._historyMany([...new Set([...symbols, BENCHMARK])]);

    // Align every series on a common set of dates. Without this, a stock with a
    // trading halt would silently pair the wrong days against the benchmark and
    // produce a beta that looks plausible and is meaningless.
    const bench = hist.get(BENCHMARK) || [];
    const benchByDate = new Map(bench.map(b => [new Date(b.t).toISOString().slice(0, 10), b.c]));

    const perHolding = [];
    const alignedReturns = new Map();   // symbol -> returns aligned to benchmark dates

    holdings.forEach((h, i) => {
      const bars = hist.get(symbols[i]) || [];

      if (bars.length < MIN_BARS) {
        perHolding.push({
          symbol: h.symbol, weightPct: h.weightPct,
          volatility: null, beta: null, maxDrawdown: null,
          note: bars.length === 0
            ? 'No price history available.'
            : `Only ${bars.length} days of history — too short to compute risk.`,
        });
        return;
      }

      const closes = bars.map(b => b.c);
      const dates  = bars.map(b => new Date(b.t).toISOString().slice(0, 10));

      // Pair asset and benchmark closes only on dates where BOTH traded.
      const pairedA = [], pairedB = [];
      dates.forEach((d, k) => {
        if (benchByDate.has(d)) { pairedA.push(closes[k]); pairedB.push(benchByDate.get(d)); }
      });

      const rA = M.toReturns(pairedA);
      const rB = M.toReturns(pairedB);

      alignedReturns.set(h.symbol, { dates, closes, returns: M.toReturns(closes) });

      perHolding.push({
        symbol:      h.symbol,
        weightPct:   h.weightPct,
        volatility:  M.annualisedVolatility(M.toReturns(closes)),
        beta:        rA.length >= MIN_BARS ? M.beta(rA, rB) : null,
        maxDrawdown: M.maxDrawdown(closes),
        bars:        bars.length,
        note:        null,
      });
    });

    // ── Portfolio-level series ──────────────────────────────────────────────
    // Reconstruct a portfolio value series using TODAY'S quantities held across
    // the whole year. This is a simulation of the current book, not the portfolio
    // you actually held — you may have bought some of these last week. It answers
    // "how would today's portfolio have behaved", which is the useful question for
    // forward-looking risk, but it is NOT your historical performance, and the API
    // says so rather than letting the number be misread.
    const allDates = [...new Set(
      holdings.flatMap(h => (alignedReturns.get(h.symbol)?.dates) || [])
    )].sort();

    const priceOn = new Map();
    for (const h of holdings) {
      const a = alignedReturns.get(h.symbol);
      if (!a) continue;
      priceOn.set(h.symbol, new Map(a.dates.map((d, k) => [d, a.closes[k]])));
    }

    // Build the portfolio and benchmark series over the SAME dates, in lockstep.
    //
    // Building them separately and truncating to a common length afterwards is
    // subtly wrong: the portfolio series skips low-coverage days while the
    // benchmark series skips days the index did not trade, so the two end up
    // offset and each portfolio return gets paired with the WRONG day's benchmark
    // return. That produces a beta that looks plausible and means nothing. (It
    // reported 0.18 for a small-cap book before this was fixed.)
    const portfolioSeries = [];
    const benchSeries     = [];

    for (const d of allDates) {
      const benchClose = benchByDate.get(d);
      if (benchClose === undefined) continue;      // index did not trade

      let v = 0, covered = 0;
      for (const h of holdings) {
        const p = priceOn.get(h.symbol)?.get(d);
        if (p !== undefined) { v += p * Number(h.quantity); covered++; }
      }
      // Skip days where most of the book has no price, else the series jumps
      // whenever a stock is missing and the drawdown becomes fiction.
      if (covered < Math.ceil(holdings.length * 0.8)) continue;

      portfolioSeries.push(v);
      benchSeries.push(benchClose);
    }

    const portReturns  = M.toReturns(portfolioSeries);
    const benchReturns = M.toReturns(benchSeries);

    const portfolioBeta = portReturns.length >= MIN_BARS
      ? M.beta(portReturns, benchReturns)
      : null;

    // ── Correlation matrix (top holdings only — 22x22 is unreadable) ────────
    const top = [...holdings]
      .filter(h => alignedReturns.has(h.symbol))
      .sort((a, b) => (b.weightPct || 0) - (a.weightPct || 0))
      .slice(0, 8);

    const matrix = top.map(a => ({
      symbol: a.symbol,
      correlations: top.map(b => {
        const ra = alignedReturns.get(a.symbol).returns;
        const rb = alignedReturns.get(b.symbol).returns;
        const k = Math.min(ra.length, rb.length);
        if (k < MIN_BARS) return null;
        return M.correlation(ra.slice(-k), rb.slice(-k));
      }),
    }));

    const portfolio = {
      volatility:   M.annualisedVolatility(portReturns),
      beta:         portfolioBeta,
      maxDrawdown:  M.maxDrawdown(portfolioSeries),
      daysOfHistory: portfolioSeries.length,
      basis: 'Computed from the current holdings held constant over the last year — a risk profile of the book you hold today, not a record of what you actually earned.',
    };

    return {
      empty: false,
      portfolio,
      holdings: perHolding,
      correlation: { symbols: top.map(t => t.symbol), matrix },
      benchmark: BENCHMARK,
      coverage: {
        withHistory: perHolding.filter(h => h.volatility !== null).length,
        total: holdings.length,
      },
    };
  }

  // ── Health ────────────────────────────────────────────────────────────────
  async getHealth(userId) {
    const alloc = await this.getAllocation(userId, { live: true });
    if (alloc.empty) return { empty: true };

    const risk = await this.getRisk(userId);

    const { holdings } = await this.holdings.getHoldings(userId, { live: true });
    const totalValue = holdings.reduce((s, h) => s + (h.currentValue || 0), 0);

    // Share of the book sitting more than 20% below cost.
    const deepLossValue = holdings
      .filter(h => h.pnlPct !== null && h.pnlPct < -20)
      .reduce((s, h) => s + (h.currentValue || 0), 0);

    const health = M.healthScore({
      topWeight:       alloc.concentration.topWeight,
      effN:            alloc.concentration.effectiveN,
      holdingsCount:   alloc.concentration.holdingsCount,
      maxSectorWeight: alloc.bySector[0]?.weightPct ?? null,
      volatility:      risk.portfolio?.volatility ?? null,
      maxDrawdown:     risk.portfolio?.maxDrawdown ?? null,
      beta:            risk.portfolio?.beta ?? null,
      deepLossWeight:  totalValue > 0 ? (deepLossValue / totalValue) * 100 : null,
    });

    return {
      empty: false,
      ...health,
      // Ship the risk block with the score. Each of these endpoints otherwise
      // fetches a year of daily bars for every holding, and production has no
      // Redis cache — so letting the UI call both would double a slow request for
      // data we already have in hand.
      risk,
      // State plainly what this score is not, so it is not mistaken for a view on
      // whether these are good companies.
      scope: 'This is a risk and structure score. It measures concentration, diversification, volatility and drawdown — not business quality or valuation, which would need fundamental data this module does not have.',
      unavailable: [
        { metric: 'Profitability, valuation, earnings quality, balance sheet strength',
          reason: 'No fundamental data source is connected.' },
        { metric: 'XIRR, CAGR, realised P&L, dividend income, win rate',
          reason: 'These need transaction history. Import the Zerodha tradebook to unlock them.' },
      ],
    };
  }
}

module.exports = HoldingsAnalyticsService;
