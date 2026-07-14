// ── Portfolio mathematics — pure functions ───────────────────────────────────
//
// No database, no network, no clock. Everything here is deterministic and unit
// tested, because a risk number that is quietly wrong is worse than no risk
// number: it gets trusted.
//
// Conventions:
//   * Returns are simple (not log) returns: (p1 - p0) / p0.
//   * Annualisation uses 252 trading days.
//   * Every function that cannot produce an honest answer returns null, never 0.
//     A beta of 0 and "we could not compute beta" mean very different things.

const TRADING_DAYS = 252;

// ── Basic statistics ────────────────────────────────────────────────────────
function mean(xs) {
  if (!xs || xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation (n-1). Needs at least 2 points. */
function stdev(xs) {
  if (!xs || xs.length < 2) return null;
  const m = mean(xs);
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

function covariance(xs, ys) {
  if (!xs || !ys || xs.length !== ys.length || xs.length < 2) return null;
  const mx = mean(xs), my = mean(ys);
  return xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / (xs.length - 1);
}

function correlation(xs, ys) {
  const c = covariance(xs, ys);
  const sx = stdev(xs), sy = stdev(ys);
  if (c === null || !sx || !sy) return null;
  return c / (sx * sy);
}

/** Daily closes -> daily simple returns. */
function toReturns(closes) {
  if (!closes || closes.length < 2) return [];
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    if (!prev) continue;                     // a zero close would divide by zero
    out.push((closes[i] - prev) / prev);
  }
  return out;
}

/** Annualised volatility, as a percentage. */
function annualisedVolatility(returns) {
  const sd = stdev(returns);
  if (sd === null) return null;
  return sd * Math.sqrt(TRADING_DAYS) * 100;
}

/**
 * Beta against a benchmark. Both series must be aligned to the same dates.
 * Returns null rather than a misleading number when the benchmark has no variance.
 */
function beta(assetReturns, benchmarkReturns) {
  const cov = covariance(assetReturns, benchmarkReturns);
  const varB = stdev(benchmarkReturns);
  if (cov === null || varB === null || varB === 0) return null;
  return cov / (varB ** 2);
}

/**
 * Maximum drawdown of a value series, as a NEGATIVE percentage.
 * Peak-to-trough, measured on the running high.
 */
function maxDrawdown(series) {
  if (!series || series.length < 2) return null;
  let peak = series[0];
  let worst = 0;
  for (const v of series) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (v - peak) / peak;
      if (dd < worst) worst = dd;
    }
  }
  return worst * 100;
}

// ── Concentration ───────────────────────────────────────────────────────────
/**
 * Herfindahl-Hirschman Index over weights expressed as percentages.
 * Scaled 0..10000: a single 100% position scores 10000; twenty equal
 * positions score 500.
 */
function hhi(weightsPct) {
  if (!weightsPct || weightsPct.length === 0) return null;
  return weightsPct.reduce((s, w) => s + w * w, 0);
}

/**
 * Effective number of holdings — 10000 / HHI.
 * A portfolio of 22 names where one is 32% of the book does NOT behave like 22
 * names, and this is the number that says so.
 */
function effectiveN(weightsPct) {
  const h = hhi(weightsPct);
  if (!h || h === 0) return null;
  return 10000 / h;
}

/** Sum of the largest n weights. */
function topNWeight(weightsPct, n) {
  if (!weightsPct || weightsPct.length === 0) return null;
  return [...weightsPct].sort((a, b) => b - a).slice(0, n).reduce((a, b) => a + b, 0);
}

// ── Allocation ──────────────────────────────────────────────────────────────
/**
 * Group holdings by a key and sum their current value.
 * `unclassifiedLabel` is used when the key is missing — never silently dropped,
 * because a bucket quietly excluded from a pie chart makes the rest lie.
 */
function allocateBy(holdings, keyFn, unclassifiedLabel = 'Unclassified') {
  const total = holdings.reduce((s, h) => s + (h.currentValue || 0), 0);
  if (total <= 0) return [];

  const buckets = new Map();
  for (const h of holdings) {
    const key = keyFn(h) || unclassifiedLabel;
    const b = buckets.get(key) || { label: key, value: 0, count: 0, pnl: 0, invested: 0 };
    b.value    += h.currentValue  || 0;
    b.invested += h.investedValue || 0;
    b.pnl      += h.pnl           || 0;
    b.count    += 1;
    buckets.set(key, b);
  }

  return [...buckets.values()]
    .map(b => ({
      ...b,
      weightPct: (b.value / total) * 100,
      pnlPct:    b.invested > 0 ? (b.pnl / b.invested) * 100 : null,
    }))
    .sort((a, b) => b.value - a.value);
}

// ── Scoring helpers ─────────────────────────────────────────────────────────
/**
 * Map a value onto 0..100 across a band, clamped.
 * `good` is the value scoring 100, `bad` the value scoring 0. `good` may be
 * greater than `bad` (lower-is-better metrics) — the direction is inferred.
 */
function scoreBand(value, good, bad) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  if (good === bad) return 50;
  const t = (value - bad) / (good - bad);
  return Math.max(0, Math.min(100, t * 100));
}

function rate(score) {
  if (score === null) return 'Unknown';
  if (score >= 80) return 'Excellent';
  if (score >= 65) return 'Good';
  if (score >= 50) return 'Moderate';
  if (score >= 35) return 'Needs Attention';
  return 'Critical';
}

/**
 * Portfolio health score.
 *
 * Every component is scored independently, carries its own weight, and explains
 * itself in plain language. Components whose inputs are unavailable are DROPPED
 * and their weight redistributed — never scored as zero, which would silently
 * punish a portfolio for a data gap rather than for a real risk.
 *
 * This is a risk-and-structure score. It says nothing about whether the holdings
 * are good businesses — that needs fundamentals, which this module does not have.
 *
 * @param {object} m  { topWeight, effN, holdingsCount, maxSectorWeight,
 *                      volatility, maxDrawdown, beta, deepLossWeight }
 */
function healthScore(m) {
  const defs = [
    {
      key: 'concentration', weight: 20, value: m.topWeight,
      score: scoreBand(m.topWeight, 8, 40),
      label: 'Concentration',
      explain: (v) => `Largest single position is ${v.toFixed(1)}% of the portfolio. ` +
        (v > 25 ? 'One holding can move the whole book — this is the dominant risk.'
         : v > 15 ? 'Somewhat top-heavy, but not extreme.'
         : 'No single position dominates.'),
    },
    {
      key: 'diversification', weight: 15, value: m.effN,
      score: scoreBand(m.effN, 15, 3),
      label: 'Diversification',
      explain: (v) => `Effective number of holdings is ${v.toFixed(1)} (of ${m.holdingsCount} actual). ` +
        (v < 5 ? 'The portfolio behaves like far fewer positions than it holds.'
         : v < 10 ? 'Position sizes are uneven enough to concentrate risk.'
         : 'Position sizes are reasonably balanced.'),
    },
    {
      key: 'sector', weight: 15, value: m.maxSectorWeight,
      score: scoreBand(m.maxSectorWeight, 20, 60),
      label: 'Sector exposure',
      explain: (v) => `Largest sector is ${v.toFixed(1)}% of the portfolio. ` +
        (v > 40 ? 'A sector-wide shock would hit a large share of the book at once.'
         : v > 25 ? 'Moderate sector tilt.'
         : 'Sector exposure is spread.'),
    },
    {
      key: 'volatility', weight: 20, value: m.volatility,
      score: scoreBand(m.volatility, 15, 55),
      label: 'Volatility',
      explain: (v) => `Annualised volatility of ${v.toFixed(1)}%. ` +
        (v > 40 ? 'Very high — expect large swings in both directions.'
         : v > 25 ? 'Above the market\'s typical range.'
         : 'Within a normal range.'),
    },
    {
      key: 'drawdown', weight: 15, value: m.maxDrawdown,
      score: scoreBand(m.maxDrawdown, -10, -45),
      label: 'Max drawdown',
      explain: (v) => `Worst peak-to-trough fall over the last year was ${v.toFixed(1)}%. ` +
        (v < -35 ? 'A deep drawdown — this portfolio can fall hard.'
         : v < -20 ? 'A meaningful drawdown.'
         : 'Drawdowns have been contained.'),
    },
    {
      key: 'lossExposure', weight: 15, value: m.deepLossWeight,
      score: scoreBand(m.deepLossWeight, 0, 40),
      label: 'Loss exposure',
      explain: (v) => `${v.toFixed(1)}% of the portfolio sits in positions down more than 20% from cost. ` +
        (v > 30 ? 'A large share of capital is deeply underwater.'
         : v > 15 ? 'A meaningful share of capital is well below cost.'
         : 'Few positions are deeply underwater.'),
    },
  ];

  const usable = defs.filter(d => d.score !== null);
  if (usable.length === 0) {
    return { score: null, rating: 'Unknown', components: [], note: 'Not enough data to score this portfolio.' };
  }

  // Redistribute the weight of any dropped component across the rest.
  const totalWeight = usable.reduce((s, d) => s + d.weight, 0);
  const score = usable.reduce((s, d) => s + d.score * (d.weight / totalWeight), 0);

  const components = defs.map(d => ({
    key:    d.key,
    label:  d.label,
    value:  d.value ?? null,
    score:  d.score,
    weight: d.score !== null ? Math.round((d.weight / totalWeight) * 100) : 0,
    rating: rate(d.score),
    explanation: d.score !== null
      ? d.explain(d.value)
      : 'Not available — the data needed for this component could not be computed.',
  }));

  const dropped = defs.length - usable.length;

  return {
    score: Math.round(score),
    rating: rate(score),
    components,
    note: dropped > 0
      ? `${dropped} component(s) could not be computed and were excluded; the remaining weights were rescaled.`
      : 'All components computed.',
  };
}

module.exports = {
  TRADING_DAYS,
  mean, stdev, covariance, correlation,
  toReturns, annualisedVolatility, beta, maxDrawdown,
  hhi, effectiveN, topNWeight,
  allocateBy,
  scoreBand, rate, healthScore,
};
