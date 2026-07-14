// ── Holdings Research — deterministic ────────────────────────────────────────
//
// Generates a research report per holding WITHOUT a language model.
//
// Every sentence this produces is derived from a number we computed, and carries
// that number with it. Nothing is remembered, inferred from training data, or
// phrased more confidently than the evidence supports. A language model asked to
// write about COLAB — 32% of this portfolio, and a company it has essentially no
// reliable information on — would not say "I don't know". It would produce a
// fluent, plausible page of fabrication. This module cannot, because it has no
// world knowledge to draw on. That is a feature.
//
// Structure of every report mirrors the brief's requirement to separate evidence
// from opinion:
//
//   facts          — measured or computed. Auditable.
//   observations   — rules applied to those facts. Each cites its number.
//   levels         — support/resistance from price history. Descriptive.
//   scenarios      — explicitly hypothetical "if X then Y", never predictions.
//   caveats        — what is unknown or unreliable, stated plainly.
//
// It does NOT produce buy/sell/hold recommendations, price targets, or position
// sizing. Not because it can't — because that is investment advice, and this is
// a research tool.

const T = require('./technicals');

const DISCLAIMER =
  'This is a computed research summary, not investment advice. Every figure is derived ' +
  'from your holdings data and public price history. Forward-looking sections are ' +
  'hypothetical scenarios based on past price levels — not predictions, and not a ' +
  'recommendation to buy, sell, or hold anything.';

const n2 = (x) => (x === null || x === undefined || !Number.isFinite(x)) ? null : Number(x.toFixed(2));
const inr = (x) => x === null || x === undefined
  ? '—'
  : '₹' + Math.round(x).toLocaleString('en-IN');
const pctStr = (x) => x === null || x === undefined ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`;

class HoldingsResearchService {
  /**
   * @param {object} holdingsService  BrokerHoldingsService
   * @param {object} market           MarketDataService (may be null)
   * @param {object} db               pg Pool (for news)
   */
  constructor(holdingsService, market = null, db = null) {
    this.holdings = holdingsService;
    this.market   = market;
    this.db       = db;
  }

  set marketService(m) { this.market = m; }

  // ── Price history ─────────────────────────────────────────────────────────
  _yahooSym(h) {
    const base = h.symbol.replace(/-(T|XT|E|BE|BZ|SM|ST|IT|GB|GS|N\d)$/i, '');
    return `${base}${h.exchange === 'BSE' ? '.BO' : '.NS'}`;
  }

  async _history(h) {
    if (!this.market) return [];
    try {
      return await this.market._fetchYahooOHLCV(this._yahooSym(h), '1d', '1y');
    } catch { return []; }
  }

  // ── News actually in our database — never model memory ────────────────────
  async _news(symbol, limit = 5) {
    if (!this.db) return [];
    try {
      const { rows } = await this.db.query(
        `SELECT title, source, published_at, sentiment, link
           FROM news_items
          WHERE symbol = $1 OR title ILIKE $2
          ORDER BY published_at DESC NULLS LAST
          LIMIT $3`,
        [symbol, `%${symbol}%`, limit]
      );
      return rows;
    } catch { return []; }
  }

  // ── The report ────────────────────────────────────────────────────────────
  async getReport(userId, symbol) {
    const { holdings } = await this.holdings.getHoldings(userId, { live: true });
    const h = holdings.find(x => x.symbol.toUpperCase() === String(symbol).toUpperCase());
    if (!h) throw new Error(`You do not hold ${symbol}.`);

    const bars = await this._history(h);
    const tech = T.computeAll(bars);
    const news = await this._news(h.symbol);

    const facts        = this._facts(h, tech);
    const observations = this._observations(h, tech);
    const levels       = this._levels(h, tech);
    const scenarios    = this._scenarios(h, tech);
    const caveats      = this._caveats(h, tech, news);

    return {
      symbol:      h.symbol,
      companyName: h.company_name || null,
      sector:      h.broker_sector || null,
      assetClass:  h.asset_class,
      exchange:    h.exchange,
      generatedAt: new Date().toISOString(),
      engine:      'deterministic',   // no language model was involved

      facts,
      observations,
      levels,
      scenarios,
      news: news.map(x => ({
        title: x.title, source: x.source, publishedAt: x.published_at,
        sentiment: x.sentiment, link: x.link,
      })),
      caveats,
      disclaimer: DISCLAIMER,
    };
  }

  // ── FACTS — measured. Auditable. No interpretation. ───────────────────────
  _facts(h, tech) {
    const position = {
      quantity:       Number(h.quantity),
      costBasis:      n2(h.costBasis),
      investedValue:  n2(h.investedValue),
      lastPrice:      n2(h.price),
      priceSource:    h.priceOk ? 'live' : 'statement close',
      currentValue:   n2(h.currentValue),
      unrealisedPnl:  n2(h.pnl),
      returnPct:      n2(h.pnlPct),
      portfolioWeightPct: n2(h.weightPct),
      dayChangePct:   n2(h.dayChangePct),
    };

    if (!tech.available) {
      return { position, technical: null, technicalNote: tech.reason };
    }

    return {
      position,
      technical: {
        lastClose:     tech.lastClose,
        trend:         tech.trend,
        rsi14:         tech.rsi14,
        macd:          tech.macd,
        ema20:         tech.ema20,
        ema50:         tech.ema50,
        atr14:         tech.atr14,
        range52w:      tech.range52w,
        volume:        tech.volume,
        tradingDays:   tech.dataQuality.tradingDays,
        dataReliable:  tech.dataQuality.reliable,
      },
    };
  }

  // ── OBSERVATIONS — rules over facts. Each cites the number it came from. ──
  _observations(h, tech) {
    const out = [];
    const add = (category, text, evidence) => out.push({ category, text, evidence });

    // Position
    if (h.pnlPct !== null) {
      if (h.pnlPct >= 50) {
        add('position', `Up ${pctStr(h.pnlPct)} from your cost basis of ${inr(h.costBasis)} — one of the stronger positions in the book.`, { returnPct: n2(h.pnlPct) });
      } else if (h.pnlPct <= -20) {
        add('position', `Down ${pctStr(h.pnlPct)} from cost. ${inr(Math.abs(h.pnl))} of unrealised loss on ${inr(h.investedValue)} invested.`, { returnPct: n2(h.pnlPct), pnl: n2(h.pnl) });
      }
    }

    if (h.weightPct !== null && h.weightPct >= 20) {
      add('concentration',
        `This single holding is ${h.weightPct.toFixed(1)}% of your portfolio. A move here moves the whole book.`,
        { weightPct: n2(h.weightPct) });
    }

    if (!tech.available) {
      add('data', tech.reason, { tradingDays: tech.dataQuality?.tradingDays ?? 0 });
      return out;
    }

    // Data reliability comes FIRST when it is bad — everything below it is suspect.
    if (!tech.dataQuality.reliable) {
      add('data', tech.dataQuality.note, {
        paddedPct: tech.dataQuality.paddedPct,
        tradingDays: tech.dataQuality.tradingDays,
      });
    }

    // Trend
    if (tech.trend) {
      const t = tech.trend;
      add('trend',
        `${t.direction} (${t.strength.toLowerCase()}). Price ${tech.lastClose} against a 20-day average of ${t.sma20} and 50-day of ${t.sma50}` +
        (t.sma200 !== null ? `, and is ${pctStr(t.priceVsSma200Pct)} versus its 200-day average.` : ' (200-day average unavailable — under a year of history).'),
        { direction: t.direction, sma20: t.sma20, sma50: t.sma50, sma200: t.sma200 });
    }

    // Momentum — describe the reading, never predict from it.
    if (tech.rsi14 !== null) {
      const r = tech.rsi14;
      const label = r >= 70 ? 'in territory usually described as overbought'
                  : r <= 30 ? 'in territory usually described as oversold'
                  : 'in a neutral band';
      add('momentum', `14-day RSI is ${r.toFixed(1)} — ${label}. This describes recent price behaviour; it does not indicate what happens next.`, { rsi14: r });
    }

    if (tech.macd) {
      const dir = tech.macd.histogram >= 0 ? 'above' : 'below';
      add('momentum', `MACD line is ${dir} its signal line (histogram ${tech.macd.histogram}).`, { macd: tech.macd });
    }

    // 52-week position
    if (tech.range52w) {
      add('range',
        `Trading ${pctStr(tech.range52w.fromHighPct)} from its 52-week high of ${tech.range52w.high} and ${pctStr(tech.range52w.fromLowPct)} from its low of ${tech.range52w.low}.`,
        tech.range52w);
    }

    // Volume
    if (tech.volume && tech.volume.ratio !== null) {
      if (tech.volume.ratio >= 2) {
        add('volume', `Latest volume is ${tech.volume.ratio}x its 20-day average — unusually active.`, tech.volume);
      } else if (tech.volume.ratio <= 0.4) {
        add('volume', `Latest volume is only ${tech.volume.ratio}x its 20-day average — unusually quiet.`, tech.volume);
      }
    }

    return out;
  }

  // ── LEVELS — where price has historically turned. Descriptive. ────────────
  _levels(h, tech) {
    if (!tech.available || !tech.levels) return null;

    const price = tech.lastClose;
    const sup = tech.levels.support[0]  || null;
    const res = tech.levels.resistance[0] || null;

    // Risk/reward to the NEAREST historical levels. This is a ratio of distances,
    // nothing more — it is not a probability and not a recommendation.
    let riskReward = null;
    if (sup && res) {
      const risk   = price - sup.level;
      const reward = res.level - price;
      if (risk > 0) {
        riskReward = {
          toSupportPct:    n2((sup.level - price) / price * 100),
          toResistancePct: n2((res.level - price) / price * 100),
          ratio:           n2(reward / risk),
          basis: 'Ratio of the distance to the nearest historical resistance versus the nearest historical support. A description of where price sits between two past levels — not a probability, and not a target.',
        };
      }
    }

    return {
      price,
      support:    tech.levels.support,
      resistance: tech.levels.resistance,
      atr14:      tech.atr14,
      atrNote: tech.atr14
        ? `Average daily range over the last 14 sessions is about ${tech.atr14} (${(tech.atr14 / price * 100).toFixed(1)}% of price). A typical day moves roughly this much in either direction.`
        : null,
      riskReward,
      note: 'Support and resistance are price levels this stock has repeatedly turned at in the past year. They describe history. Price is under no obligation to respect them again.',
    };
  }

  // ── SCENARIOS — explicitly hypothetical. Never stated as expectation. ─────
  _scenarios(h, tech) {
    if (!tech.available || !tech.levels) return [];

    const price = tech.lastClose;
    const sup = tech.levels.support[0];
    const res = tech.levels.resistance[0];
    const out = [];

    if (res) {
      out.push({
        type: 'bullish',
        hypothetical: true,
        condition: `IF price closes above ${res.level} (the nearest level it has turned down from ${res.touches} time${res.touches > 1 ? 's' : ''} in the past year, ${pctStr(res.distancePct)} away)`,
        thenWhat: `that resistance would no longer be overhead. The next historical level above it is ${tech.levels.resistance[1] ? tech.levels.resistance[1].level : 'not present in the last year of data'}.`,
        note: 'A conditional statement about price levels. It is not a forecast that this will happen, and not a suggestion to act on it.',
      });
    }

    if (sup) {
      out.push({
        type: 'bearish',
        hypothetical: true,
        condition: `IF price closes below ${sup.level} (the nearest level it has turned up from ${sup.touches} time${sup.touches > 1 ? 's' : ''}, ${pctStr(sup.distancePct)} away)`,
        thenWhat: `that support would no longer be underneath. The next historical level below it is ${tech.levels.support[1] ? tech.levels.support[1].level : 'not present in the last year of data'}.`,
        note: 'A conditional statement about price levels. It is not a forecast, and not a suggestion to act on it.',
      });
    }

    return out;
  }

  // ── CAVEATS — say what we do not know, plainly. ──────────────────────────
  _caveats(h, tech, news) {
    const out = [];

    if (!tech.available) {
      out.push(tech.reason);
    } else if (!tech.dataQuality.reliable) {
      out.push(
        `Price data for this stock is unreliable: only ${tech.dataQuality.tradingDays} of the last year's sessions had actual trading. ` +
        `Every technical figure above is computed on those days only and should be treated with scepticism.`
      );
    }

    if (!h.priceOk) {
      out.push('No live price was available — figures use the last statement close, so current value and P&L may be stale.');
    }

    if (!news.length) {
      out.push(`No news for ${h.symbol} in the app's news feed. That is an absence of coverage in our sources, not evidence that nothing has happened.`);
    }

    // The honest, load-bearing caveat: we don't do fundamentals, and we say so.
    out.push(
      'This report contains no fundamental analysis — no earnings, revenue, margins, debt, valuation, or management assessment. ' +
      'None of that data is connected to this system, and none of it has been inferred or estimated. ' +
      'Nothing here tells you whether this is a good business.'
    );

    return out;
  }
}

module.exports = HoldingsResearchService;
module.exports.DISCLAIMER = DISCLAIMER;
