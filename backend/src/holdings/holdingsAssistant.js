// ── Holdings Assistant — deterministic natural-language answers ──────────────
//
// Answers questions about YOUR portfolio from YOUR data. No language model.
//
// This is not a downgrade from an LLM assistant — for these questions it is
// strictly better. Every question the brief asked for ("which stock is hurting me
// most", "how diversified am I", "which sectors am I overweight") is arithmetic
// over data we already hold. Routing that through a model means paying it to read
// our own numbers back to us, with a non-zero chance it transposes one. Here the
// numbers in the answer ARE the numbers in the database, because the answer is
// assembled from them.
//
// The property that matters most: when this cannot answer a question, it SAYS SO
// and lists what it can answer. It never improvises. An LLM, asked "which of my
// companies report earnings this week?", would produce a confident and entirely
// fabricated list — we have no earnings calendar. This says: I don't have that.

const T = require('./technicals');

const inr  = (x) => x == null ? '—' : '₹' + Math.round(x).toLocaleString('en-IN');
const pct  = (x) => x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`;

// What this assistant can actually do — shown when a question falls outside it.
const CAPABILITIES = [
  'Which holding is hurting my portfolio the most?',
  'Show my biggest winners and losers',
  'How diversified is my portfolio?',
  'What are my largest risks?',
  'Which sectors am I overweight in?',
  'Which holding has the strongest momentum?',
  'Compare my software services holdings  (any sector)',
  'What changed over the last week?',
  'How did my portfolio do today?',
  'Which holdings deserve a closer look?',
];

class HoldingsAssistant {
  /**
   * @param {object} holdingsService
   * @param {object} analytics  HoldingsAnalyticsService
   * @param {object} market
   */
  constructor(holdingsService, analytics, market = null) {
    this.holdings  = holdingsService;
    this.analytics = analytics;
    this.market    = market;
  }

  set marketService(m) { this.market = m; }

  async ask(userId, question) {
    const q = String(question || '').toLowerCase().trim();
    if (!q) return this._cannotAnswer('You did not ask anything.');

    const { holdings } = await this.holdings.getHoldings(userId, { live: true });
    if (!holdings.length) {
      return { ok: true, intent: 'empty', answer: 'You have no holdings imported yet.', data: null, engine: 'deterministic' };
    }

    // Ordered: the first matching intent wins, so put the specific before the general.
    const intents = [
      { name: 'earnings',      match: /earning|result|quarterly|q[1-4]\b|report.*(week|date)/,        fn: () => this._earnings() },
      { name: 'fundamentals',  match: /\b(pe|p\/e|valuation|roe|roce|debt|margin|revenue|profit|balance sheet|fundamental)\b/, fn: () => this._fundamentals() },
      { name: 'hurting',       match: /hurt|drag|worst|detract|losing most|damaging|biggest loss/,   fn: () => this._detractors(holdings) },
      { name: 'winners',       match: /winner|best perform|biggest gain|top perform|doing best/,     fn: () => this._winners(holdings) },
      { name: 'losers',        match: /loser|worst perform|down the most|biggest loser/,             fn: () => this._losers(holdings) },
      { name: 'diversified',   match: /diversif|concentrat|spread out|how many holding/,             fn: () => this._diversification(userId) },
      { name: 'risk',          match: /risk|danger|exposure|volatil|drawdown|beta/,                  fn: () => this._risks(userId) },
      { name: 'sector',        match: /sector|overweight|allocation|weighting/,                      fn: () => this._sectors(userId) },
      { name: 'momentum',      match: /momentum|strongest|trending|rsi|technical/,                   fn: () => this._momentum(holdings) },
      { name: 'compare',       match: /compare|versus|vs\b/,                                         fn: () => this._compare(holdings, q) },
      { name: 'week',          match: /week|last 5 day|recent|since last/,                           fn: () => this._week(holdings) },
      { name: 'today',         match: /today|day|so far|right now/,                                  fn: () => this._today(holdings) },
      { name: 'research',      match: /research|closer look|attention|watch|deserve|look at/,        fn: () => this._research(holdings) },
    ];

    for (const i of intents) {
      if (i.match.test(q)) {
        const r = await i.fn();
        return { ok: true, intent: i.name, engine: 'deterministic', ...r };
      }
    }

    return this._cannotAnswer(`I could not match "${question}" to anything I can compute from your portfolio.`);
  }

  // The most important method in the file: refuse cleanly.
  _cannotAnswer(why) {
    return {
      ok: true,
      intent: 'unknown',
      engine: 'deterministic',
      answer: `${why}\n\nI answer only from your own holdings data, so I would rather say this than guess.`,
      capabilities: CAPABILITIES,
      data: null,
    };
  }

  // ── Things we genuinely do not have ──────────────────────────────────────
  _earnings() {
    return {
      answer:
        'I do not have an earnings calendar. Nothing in this system tracks when your companies report, ' +
        'so I cannot tell you which of them report this week.\n\n' +
        'I am telling you this rather than producing a list, because a list would be invented.',
      data: null,
    };
  }

  _fundamentals() {
    return {
      answer:
        'I have no fundamental data — no P/E, ROE, ROCE, debt, margins, revenue or earnings. ' +
        'No such data source is connected to this system.\n\n' +
        'I can tell you about your positions, their prices, momentum, levels, concentration and risk. ' +
        'I cannot tell you whether these are good businesses.',
      data: null,
    };
  }

  // ── Attribution ─────────────────────────────────────────────────────────
  _detractors(holdings) {
    const invested = holdings.reduce((s, h) => s + h.investedValue, 0);
    const ranked = holdings
      .filter(h => h.pnl !== null)
      .map(h => ({ ...h, contributionPct: invested > 0 ? (h.pnl / invested) * 100 : 0 }))
      .sort((a, b) => a.contributionPct - b.contributionPct);

    const worst = ranked[0];
    if (!worst || worst.pnl >= 0) {
      return { answer: 'Nothing is dragging the portfolio down — every holding is at or above your cost basis.', data: null };
    }

    const lines = ranked.slice(0, 5).filter(h => h.pnl < 0).map(h =>
      `  ${h.symbol.padEnd(12)} ${inr(h.pnl).padStart(11)}  ${pct(h.pnlPct).padStart(8)}  ${pct(h.contributionPct)} of total return`
    );

    return {
      answer:
        `**${worst.symbol}** is hurting you most: ${inr(worst.pnl)} of unrealised loss, ` +
        `${pct(worst.pnlPct)} from your cost basis of ${inr(worst.costBasis)}. ` +
        `That alone is ${pct(worst.contributionPct)} of your portfolio's total return.\n\n` +
        `Biggest detractors:\n${lines.join('\n')}\n\n` +
        `Note the distinction: ${worst.symbol} is the biggest drag in RUPEES. ` +
        `The worst percentage loss may be a different, smaller holding.`,
      data: ranked.slice(0, 5).map(h => ({
        symbol: h.symbol, pnl: h.pnl, pnlPct: h.pnlPct,
        contributionPct: h.contributionPct, weightPct: h.weightPct,
      })),
    };
  }

  _winners(holdings) {
    const ranked = [...holdings].filter(h => h.pnl !== null).sort((a, b) => b.pnl - a.pnl).slice(0, 5);
    const lines = ranked.map(h => `  ${h.symbol.padEnd(12)} ${inr(h.pnl).padStart(11)}  ${pct(h.pnlPct).padStart(8)}  ${pct(h.weightPct)} of book`);
    return {
      answer: `Your biggest gains, in rupees:\n\n${lines.join('\n')}`,
      data: ranked.map(h => ({ symbol: h.symbol, pnl: h.pnl, pnlPct: h.pnlPct, weightPct: h.weightPct })),
    };
  }

  _losers(holdings) {
    const ranked = [...holdings].filter(h => h.pnl !== null).sort((a, b) => a.pnlPct - b.pnlPct).slice(0, 5);
    const lines = ranked.map(h => `  ${h.symbol.padEnd(12)} ${pct(h.pnlPct).padStart(8)}  ${inr(h.pnl).padStart(11)}  ${pct(h.weightPct)} of book`);
    return {
      answer: `Your worst returns, by percentage:\n\n${lines.join('\n')}`,
      data: ranked.map(h => ({ symbol: h.symbol, pnl: h.pnl, pnlPct: h.pnlPct, weightPct: h.weightPct })),
    };
  }

  // ── Structure ───────────────────────────────────────────────────────────
  async _diversification(userId) {
    const a = await this.analytics.getAllocation(userId, { live: true });
    const c = a.concentration;
    const topSector = a.bySector[0];

    return {
      answer:
        `You hold ${c.holdingsCount} stocks, but the position sizes are uneven enough that the portfolio ` +
        `behaves like **${c.effectiveN.toFixed(1)}** — that is the effective number of holdings, and it is the ` +
        `figure worth paying attention to.\n\n` +
        `  Largest position   ${c.topWeight.toFixed(1)}%\n` +
        `  Top 3 combined     ${c.top3Weight.toFixed(1)}%\n` +
        `  Top 5 combined     ${c.top5Weight.toFixed(1)}%\n` +
        `  Largest sector     ${topSector.label} at ${topSector.weightPct.toFixed(1)}%\n\n` +
        `Holding 22 names does not make a portfolio diversified if a handful of them carry most of the money.`,
      data: { concentration: c, topSector },
    };
  }

  async _sectors(userId) {
    const a = await this.analytics.getAllocation(userId, { live: true });
    const lines = a.bySector.slice(0, 8).map(s =>
      `  ${s.label.padEnd(30)} ${s.weightPct.toFixed(1).padStart(5)}%   ${s.count} holding${s.count > 1 ? 's' : ''}`
    );
    const top = a.bySector[0];
    return {
      answer:
        `Sector allocation:\n\n${lines.join('\n')}\n\n` +
        `**${top.label}** is your largest exposure at ${top.weightPct.toFixed(1)}% across ${top.count} holding${top.count > 1 ? 's' : ''}. ` +
        `A sector-wide shock would hit that share of the book at once.`,
      data: a.bySector,
    };
  }

  async _risks(userId) {
    const health = await this.analytics.getHealth(userId);

    // Only components that are ACTUALLY weak. Taking "the three lowest" would
    // present a 92/100 component as a risk simply because it ranked last among
    // whatever happened to be computable — calling a strength a danger.
    const WEAK = 65;   // below 'Good'
    const weak = health.components
      .filter(c => c.score !== null && c.score < WEAK)
      .sort((a, b) => a.score - b.score)
      .slice(0, 3);

    if (!weak.length) {
      return {
        answer:
          `Portfolio health scores **${health.score}/100 — ${health.rating}**, and no individual component ` +
          `scores below ${WEAK}. Nothing stands out as a weakness on the measures I can compute.\n\n${health.scope}`,
        data: { score: health.score, rating: health.rating, weakest: [], risk: health.risk?.portfolio ?? null },
      };
    }

    const lines = weak.map(c => `  • **${c.label}** (${Math.round(c.score)}/100 — ${c.rating})\n    ${c.explanation}`);

    return {
      answer:
        `Portfolio health scores **${health.score}/100 — ${health.rating}**.\n\n` +
        `Your weakest area${weak.length > 1 ? 's' : ''}:\n\n${lines.join('\n\n')}\n\n` +
        `${health.scope}`,
      data: { score: health.score, rating: health.rating, weakest: weak, risk: health.risk?.portfolio ?? null },
    };
  }

  // ── Technicals across the book ──────────────────────────────────────────
  async _momentum(holdings) {
    const scored = [];
    for (const h of holdings) {
      const bars = this.market
        ? await this.market._fetchYahooOHLCV(
            `${h.symbol.replace(/-(T|XT|E|BE|BZ|SM|ST|IT|GB|GS|N\d)$/i, '')}${h.exchange === 'BSE' ? '.BO' : '.NS'}`,
            '1d', '1y')
        : [];
      const t = T.computeAll(bars);
      if (!t.available || !t.trend) continue;
      scored.push({
        symbol: h.symbol,
        trend: t.trend.direction,
        strength: t.trend.strength,
        rsi: t.rsi14,
        reliable: t.dataQuality.reliable,
        weightPct: h.weightPct,
      });
    }

    if (!scored.length) return { answer: 'No usable price history for any holding, so I cannot rank momentum.', data: null };

    // Rank uptrends first, then by RSI. Exclude unreliable data from the headline.
    const rank = (x) => (x.trend === 'Uptrend' ? 2 : x.trend === 'Sideways' ? 1 : 0) * 100 + (x.rsi ?? 0);
    const sorted = [...scored].sort((a, b) => rank(b) - rank(a));
    const top = sorted.filter(x => x.reliable)[0];

    const lines = sorted.slice(0, 6).map(x =>
      `  ${x.symbol.padEnd(12)} ${(x.trend + '/' + x.strength).padEnd(20)} RSI ${String(x.rsi ?? '—').padEnd(6)}` +
      (x.reliable ? '' : '  ⚠ unreliable data')
    );

    return {
      answer:
        (top
          ? `**${top.symbol}** has the strongest momentum: ${top.trend.toLowerCase()} (${top.strength.toLowerCase()}), RSI ${top.rsi}.\n\n`
          : 'No holding has both strong momentum and reliable price data.\n\n') +
        `${lines.join('\n')}\n\n` +
        `Momentum describes what price has already done. It is not a statement about what it will do.`,
      data: sorted,
    };
  }

  async _week(holdings) {
    const rows = [];
    for (const h of holdings) {
      const bars = this.market
        ? await this.market._fetchYahooOHLCV(
            `${h.symbol.replace(/-(T|XT|E|BE|BZ|SM|ST|IT|GB|GS|N\d)$/i, '')}${h.exchange === 'BSE' ? '.BO' : '.NS'}`,
            '1d', '1y')
        : [];
      const clean = T.cleanBars(bars).bars;
      if (clean.length < 6) continue;
      const now  = clean[clean.length - 1].c;
      const then = clean[clean.length - 6].c;
      const chg  = ((now - then) / then) * 100;
      rows.push({ symbol: h.symbol, changePct: chg, valueChange: (h.currentValue || 0) * (chg / 100) });
    }

    if (!rows.length) return { answer: 'Not enough price history to compare against last week.', data: null };

    rows.sort((a, b) => b.changePct - a.changePct);
    const up = rows.filter(r => r.changePct > 0).length;
    const lines = [...rows.slice(0, 3), ...rows.slice(-3)].map(r =>
      `  ${r.symbol.padEnd(12)} ${pct(r.changePct).padStart(8)}   ${inr(r.valueChange).padStart(11)}`);

    return {
      answer:
        `Over the last 5 trading sessions, ${up} of ${rows.length} holdings rose.\n\n` +
        `Best and worst:\n${lines.join('\n')}`,
      data: rows,
    };
  }

  _today(holdings) {
    const live = holdings.filter(h => h.priceOk && h.dayChangePct !== null);
    if (!live.length) {
      return { answer: 'No live prices right now — I cannot tell you how today went. Try again during market hours.', data: null };
    }

    const dayPnl = live.reduce((s, h) => s + h.currentValue * (h.dayChangePct / 100), 0);
    const up = live.filter(h => h.dayChangePct > 0).length;
    const sorted = [...live].sort((a, b) => b.dayChangePct - a.dayChangePct);
    const lines = [...sorted.slice(0, 3), ...sorted.slice(-3)].map(h =>
      `  ${h.symbol.padEnd(12)} ${pct(h.dayChangePct).padStart(8)}   ${inr(h.currentValue * (h.dayChangePct / 100)).padStart(11)}`);

    return {
      answer:
        `Today your portfolio is ${dayPnl >= 0 ? 'up' : 'down'} **${inr(Math.abs(dayPnl))}**. ` +
        `${up} of ${live.length} holdings are green.\n\n${lines.join('\n')}`,
      data: { dayPnl, up, total: live.length },
    };
  }

  _compare(holdings, q) {
    // Match a sector name mentioned in the question against the broker's taxonomy.
    const sectors = [...new Set(holdings.map(h => h.broker_sector).filter(Boolean))];
    const hit = sectors.find(s => {
      const words = s.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 3);
      return words.some(w => q.includes(w));
    });

    if (!hit) {
      return this._cannotAnswer(
        `I could not tell which sector you meant. Your sectors are: ${sectors.join(', ')}.`
      );
    }

    const group = holdings.filter(h => h.broker_sector === hit);
    const lines = group.map(h =>
      `  ${h.symbol.padEnd(12)} ${pct(h.pnlPct).padStart(8)}  ${inr(h.pnl).padStart(11)}  ${pct(h.weightPct).padStart(7)} of book`);
    const total = group.reduce((s, h) => s + (h.currentValue || 0), 0);
    const inv   = group.reduce((s, h) => s + h.investedValue, 0);

    return {
      answer:
        `Your ${hit} holdings (${group.length}):\n\n${lines.join('\n')}\n\n` +
        `Combined: ${inr(inv)} invested, now ${inr(total)} — ${pct(inv > 0 ? (total - inv) / inv * 100 : 0)}.`,
      data: group.map(h => ({ symbol: h.symbol, pnl: h.pnl, pnlPct: h.pnlPct, weightPct: h.weightPct })),
    };
  }

  _research(holdings) {
    const flags = [];
    for (const h of holdings) {
      const reasons = [];
      if (h.weightPct !== null && h.weightPct >= 25) reasons.push(`${h.weightPct.toFixed(1)}% of the portfolio sits in this one name`);
      if (h.pnlPct !== null && h.pnlPct <= -30)      reasons.push(`down ${pct(h.pnlPct)} from cost`);
      if (!h.priceOk)                                reasons.push('no live price available');
      if (reasons.length) flags.push({ symbol: h.symbol, reasons });
    }

    if (!flags.length) {
      return { answer: 'Nothing in the portfolio is flagged on concentration, deep losses, or missing prices.', data: null };
    }

    const lines = flags.map(f => `  • **${f.symbol}** — ${f.reasons.join('; ')}`);
    return {
      answer:
        `These holdings stand out on the measures I can compute:\n\n${lines.join('\n')}\n\n` +
        `"Stands out" means it tripped a threshold on size, loss, or data quality. ` +
        `It is not a judgement about the company — I have no fundamental data to make one.`,
      data: flags,
    };
  }
}

module.exports = HoldingsAssistant;
module.exports.CAPABILITIES = CAPABILITIES;
