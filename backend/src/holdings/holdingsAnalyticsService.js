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
const T = require('./technicals');

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
      // RAW bars, padding included. The two consumers need different series and
      // must not share one — see the note in getRisk().
      return (typeof this.market._fetchYahooOHLCV === 'function')
        ? await this.market._fetchYahooOHLCV(yahooSym, '1d', '1y')
        : await this.market.fetchDailyOHLCV(yahooSym);
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

    // ── Two series, two questions. They must not be conflated. ──────────────
    //
    // PER-HOLDING risk asks "how volatile is this stock?" — that must use only
    // days the stock actually TRADED. Padded non-trading days (zero volume,
    // unchanged close) produce a return of exactly zero, which understates
    // volatility and drags beta toward zero. COLAB measured 17.4% vol / 0.05 beta
    // on raw bars; on its 115 real trading days it is 22.4% / 0.08.
    //
    // PORTFOLIO value asks "what was my book worth that day?" — and on a day a
    // stock did not trade, the position is still worth its LAST TRADED PRICE.
    // That is forward-fill, not omission. Dropping the holding from that day's
    // sum removes 32% of the book (COLAB's weight) and adds it back the next,
    // manufacturing phantom 32% daily swings — which is exactly what happened:
    // portfolio volatility came out at 487% and beta at -1.76.
    //
    // So: clean bars for the stock's own risk, forward-filled raw bars for the
    // portfolio's value.
    holdings.forEach((h, i) => {
      const raw   = hist.get(symbols[i]) || [];
      const clean = T.cleanBars(raw).bars;

      if (clean.length < MIN_BARS) {
        perHolding.push({
          symbol: h.symbol, weightPct: h.weightPct,
          volatility: null, beta: null, maxDrawdown: null,
          note: raw.length === 0
            ? 'No price history available.'
            : `Only ${clean.length} real trading days in the last year — too thinly traded to compute risk.`,
        });
        // Still keep the RAW series: the position has value on every day, even
        // days the stock did not trade, and the portfolio series needs it.
        if (raw.length) {
          alignedReturns.set(h.symbol, {
            dates:  raw.map(b => new Date(b.t).toISOString().slice(0, 10)),
            closes: raw.map(b => b.c),
            returns: [],
          });
        }
        return;
      }

      const cCloses = clean.map(b => b.c);
      const cDates  = clean.map(b => new Date(b.t).toISOString().slice(0, 10));

      // Beta pairs the stock against the index only on days BOTH actually traded.
      const pairedA = [], pairedB = [];
      cDates.forEach((d, k) => {
        if (benchByDate.has(d)) { pairedA.push(cCloses[k]); pairedB.push(benchByDate.get(d)); }
      });
      const rA = M.toReturns(pairedA);
      const rB = M.toReturns(pairedB);

      // Raw series is what the portfolio valuation walks.
      alignedReturns.set(h.symbol, {
        dates:  raw.map(b => new Date(b.t).toISOString().slice(0, 10)),
        closes: raw.map(b => b.c),
        returns: M.toReturns(cCloses),
      });

      perHolding.push({
        symbol:      h.symbol,
        weightPct:   h.weightPct,
        volatility:  M.annualisedVolatility(M.toReturns(cCloses)),
        beta:        rA.length >= MIN_BARS ? M.beta(rA, rB) : null,
        maxDrawdown: M.maxDrawdown(cCloses),
        bars:        clean.length,
        thinlyTraded: T.cleanBars(raw).paddedPct >= 20,
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
    // ── Portfolio return series ─────────────────────────────────────────────
    //
    // Built from RETURNS, not from a value level. Two failures make the obvious
    // value-sum approach wrong, and both were live in this code:
    //
    //  1. Summing only the holdings that had a bar on a given date DROPS a stock
    //     from the book on days it did not trade. COLAB is 32% of this portfolio
    //     and trades on 115 of 249 days — so the book "lost" a third of its value
    //     and got it back, over and over. That produced 487% annualised volatility
    //     and a beta of -1.76 from swings that never occurred.
    //
    //  2. Requiring every holding to have data before starting throws away a year
    //     of history for 21 holdings because one listed recently — 58 usable days,
    //     too few even to compute beta.
    //
    // Returns fix both. Each day's portfolio return is the weighted average of the
    // holdings that have a price on BOTH that day and the one before, with weights
    // renormalised over exactly those holdings. A stock that did not trade carries
    // its last price forward and contributes a real zero return; a stock that did
    // not yet exist simply is not in that day's average, and its later arrival adds
    // no phantom jump.
    const weightOf = new Map(holdings.map(h => [h.symbol, (h.weightPct || 0) / 100]));
    const lastPrice = new Map();
    const prevPrice = new Map();

    const portReturns  = [];
    const benchReturns = [];
    let   benchPrev    = null;
    let   minCoverage  = 1;

    for (const d of allDates) {
      const benchClose = benchByDate.get(d);
      if (benchClose === undefined) continue;          // index did not trade

      // Forward-fill: a non-trading day keeps the last traded price.
      for (const h of holdings) {
        const p = priceOn.get(h.symbol)?.get(d);
        if (p !== undefined) lastPrice.set(h.symbol, p);
      }

      let wSum = 0, rSum = 0;
      for (const h of holdings) {
        const now  = lastPrice.get(h.symbol);
        const then = prevPrice.get(h.symbol);
        if (now === undefined || then === undefined || !then) continue;   // not yet held
        const w = weightOf.get(h.symbol) || 0;
        rSum += w * ((now - then) / then);
        wSum += w;
      }

      // Renormalise over the holdings actually present — otherwise a day covering
      // 70% of the book would report a return 30% too small.
      if (wSum > 0.5 && benchPrev) {
        portReturns.push(rSum / wSum);
        benchReturns.push((benchClose - benchPrev) / benchPrev);
        if (wSum < minCoverage) minCoverage = wSum;
      }

      for (const [k, v] of lastPrice) prevPrice.set(k, v);
      benchPrev = benchClose;
    }

    // Cumulative index, purely so drawdown has a level series to walk.
    const portfolioSeries = [100];
    for (const r of portReturns) portfolioSeries.push(portfolioSeries[portfolioSeries.length - 1] * (1 + r));

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
      daysOfHistory: portReturns.length,
      minCoveragePct: Number((minCoverage * 100).toFixed(1)),
      basis: 'Computed from the current holdings held constant over the last year — a risk profile of the book you hold today, not a record of what you actually earned. ' +
             'Each day is the weighted return of the holdings that had a price on that day and the one before, renormalised over exactly those holdings.',
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
