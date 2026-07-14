// ── Portfolio mathematics ────────────────────────────────────────────────────
//
// Every figure is checked against a value derived by hand or against a known
// closed-form answer. A risk number that is quietly wrong is worse than no risk
// number, because it gets trusted.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/holdings/portfolioMath');

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// ── Statistics ───────────────────────────────────────────────────────────────
describe('statistics', () => {
  test('stdev is the SAMPLE standard deviation (n-1), not population', () => {
    // [2,4,4,4,5,5,7,9]: population sd = 2, sample sd = 2.13809...
    const sd = M.stdev([2, 4, 4, 4, 5, 5, 7, 9]);
    assert.ok(close(sd, 2.13808993, 1e-6), `got ${sd}`);
  });

  test('stdev of a constant series is 0, not null', () => {
    assert.equal(M.stdev([5, 5, 5, 5]), 0);
  });

  test('stdev needs at least two points', () => {
    assert.equal(M.stdev([1]), null);
    assert.equal(M.stdev([]), null);
  });

  test('correlation of a series with itself is 1', () => {
    assert.ok(close(M.correlation([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]), 1));
  });

  test('correlation of a series with its negation is -1', () => {
    assert.ok(close(M.correlation([1, 2, 3, 4, 5], [-1, -2, -3, -4, -5]), -1));
  });

  test('correlation with a zero-variance series is null, not 0', () => {
    // 0 would read as "uncorrelated", which is a claim. null is the truth:
    // the question cannot be answered.
    assert.equal(M.correlation([1, 2, 3], [4, 4, 4]), null);
  });
});

// ── Returns ──────────────────────────────────────────────────────────────────
describe('toReturns', () => {
  test('computes simple returns', () => {
    const r = M.toReturns([100, 110, 99]);
    assert.ok(close(r[0], 0.10));
    assert.ok(close(r[1], -0.10));
  });

  test('a single price yields no returns', () => {
    assert.deepEqual(M.toReturns([100]), []);
  });

  test('skips a zero price instead of dividing by zero', () => {
    const r = M.toReturns([100, 0, 50]);
    assert.ok(r.every(Number.isFinite));
  });
});

describe('annualisedVolatility', () => {
  test('scales daily volatility by sqrt(252) and returns a percentage', () => {
    // Daily returns alternating +1% / -1%: sample sd = 0.01 (exactly, for n even
    // and mean 0)... use a series with a known sd instead.
    const returns = [0.01, -0.01, 0.01, -0.01];
    const sd  = M.stdev(returns);
    const vol = M.annualisedVolatility(returns);
    assert.ok(close(vol, sd * Math.sqrt(252) * 100, 1e-9));
  });

  test('a flat series has zero volatility', () => {
    assert.equal(M.annualisedVolatility([0, 0, 0, 0]), 0);
  });
});

// ── Beta ─────────────────────────────────────────────────────────────────────
describe('beta', () => {
  test('an asset that exactly tracks the benchmark has beta 1', () => {
    const b = [0.01, -0.02, 0.03, -0.01, 0.02];
    assert.ok(close(M.beta(b, b), 1));
  });

  test('an asset moving twice the benchmark has beta 2', () => {
    const bench = [0.01, -0.02, 0.03, -0.01, 0.02];
    const asset = bench.map(x => x * 2);
    assert.ok(close(M.beta(asset, bench), 2));
  });

  test('an inverse asset has negative beta', () => {
    const bench = [0.01, -0.02, 0.03, -0.01, 0.02];
    assert.ok(M.beta(bench.map(x => -x), bench) < 0);
  });

  test('a flat benchmark yields null, not Infinity or 0', () => {
    assert.equal(M.beta([0.01, 0.02, 0.03], [0, 0, 0]), null);
  });
});

// ── Drawdown ─────────────────────────────────────────────────────────────────
describe('maxDrawdown', () => {
  test('measures peak-to-trough, not first-to-last', () => {
    // 100 -> 120 -> 60 -> 90. The fall is from the PEAK of 120, i.e. -50%.
    // Measuring from the start (100 -> 60) would wrongly report -40%.
    assert.ok(close(M.maxDrawdown([100, 120, 60, 90]), -50));
  });

  test('a monotonically rising series has no drawdown', () => {
    assert.equal(M.maxDrawdown([100, 110, 120, 130]), 0);
  });

  test('finds the worst of several drawdowns', () => {
    // -20% then -50%
    assert.ok(close(M.maxDrawdown([100, 80, 100, 200, 100]), -50));
  });
});

// ── Concentration ────────────────────────────────────────────────────────────
describe('concentration', () => {
  test('HHI of a single 100% position is 10000', () => {
    assert.equal(M.hhi([100]), 10000);
  });

  test('HHI of twenty equal positions is 500', () => {
    assert.ok(close(M.hhi(Array(20).fill(5)), 500));
  });

  test('effectiveN of ten equal positions is 10', () => {
    assert.ok(close(M.effectiveN(Array(10).fill(10)), 10));
  });

  // The point of the metric: a lopsided book does not behave like its headcount.
  test('effectiveN is far below the holding count when one position dominates', () => {
    // One 60% position + eight 5% positions = 9 holdings...
    const weights = [60, ...Array(8).fill(5)];
    const eff = M.effectiveN(weights);
    assert.ok(eff < 3, `effectiveN should be well under 3, got ${eff}`);
  });

  test('topNWeight sums the largest n', () => {
    assert.equal(M.topNWeight([10, 30, 5, 20, 35], 2), 65);
  });
});

// ── Allocation ───────────────────────────────────────────────────────────────
describe('allocateBy', () => {
  const holdings = [
    { broker_sector: 'IT',   currentValue: 500, investedValue: 400, pnl: 100 },
    { broker_sector: 'IT',   currentValue: 300, investedValue: 350, pnl: -50 },
    { broker_sector: 'FMCG', currentValue: 200, investedValue: 150, pnl: 50 },
    { broker_sector: null,   currentValue: 100, investedValue: 100, pnl: 0 },
  ];

  test('groups and sums by key, sorted by value', () => {
    const a = M.allocateBy(holdings, h => h.broker_sector);
    assert.equal(a[0].label, 'IT');
    assert.equal(a[0].value, 800);
    assert.equal(a[0].count, 2);
    assert.ok(close(a[0].weightPct, 800 / 1100 * 100, 1e-9));
  });

  // A bucket silently dropped from a pie chart makes every other slice lie.
  test('missing keys become Unclassified rather than being dropped', () => {
    const a = M.allocateBy(holdings, h => h.broker_sector);
    const unc = a.find(x => x.label === 'Unclassified');
    assert.ok(unc, 'an Unclassified bucket must exist');
    assert.equal(unc.value, 100);
    assert.ok(close(a.reduce((s, x) => s + x.weightPct, 0), 100, 1e-6), 'weights must sum to 100%');
  });

  test('an empty portfolio allocates to nothing', () => {
    assert.deepEqual(M.allocateBy([], h => h.x), []);
  });
});

// ── Scoring ──────────────────────────────────────────────────────────────────
describe('scoreBand', () => {
  test('scores 100 at the good end and 0 at the bad end', () => {
    assert.equal(M.scoreBand(8, 8, 40), 100);
    assert.equal(M.scoreBand(40, 8, 40), 0);
  });

  test('clamps beyond either end', () => {
    assert.equal(M.scoreBand(2, 8, 40), 100);
    assert.equal(M.scoreBand(90, 8, 40), 0);
  });

  test('works when lower is better (drawdown: -10 good, -45 bad)', () => {
    assert.equal(M.scoreBand(-10, -10, -45), 100);
    assert.equal(M.scoreBand(-45, -10, -45), 0);
    assert.ok(close(M.scoreBand(-27.5, -10, -45), 50, 1e-6));
  });

  test('a non-finite input scores null, not NaN', () => {
    assert.equal(M.scoreBand(null, 8, 40), null);
    assert.equal(M.scoreBand(NaN, 8, 40), null);
  });
});

describe('healthScore', () => {
  const goodBook = {
    topWeight: 9, effN: 14, holdingsCount: 20, maxSectorWeight: 22,
    volatility: 16, maxDrawdown: -11, beta: 0.9, deepLossWeight: 2,
  };
  const badBook = {
    topWeight: 45, effN: 2.5, holdingsCount: 22, maxSectorWeight: 65,
    volatility: 60, maxDrawdown: -50, beta: 1.6, deepLossWeight: 45,
  };

  test('a well-structured book rates high', () => {
    const h = M.healthScore(goodBook);
    assert.ok(h.score >= 80, `expected >= 80, got ${h.score}`);
    assert.equal(h.rating, 'Excellent');
  });

  test('a concentrated, volatile book rates critical', () => {
    const h = M.healthScore(badBook);
    assert.ok(h.score < 35, `expected < 35, got ${h.score}`);
    assert.equal(h.rating, 'Critical');
  });

  test('every component explains itself', () => {
    for (const c of M.healthScore(goodBook).components) {
      assert.ok(c.explanation && c.explanation.length > 20, `${c.key} has no explanation`);
      assert.ok(c.rating);
    }
  });

  // The important one. A missing input must not be scored as zero — that would
  // punish the portfolio for a data gap as if it were a real risk.
  test('a missing component is DROPPED and its weight redistributed, not scored 0', () => {
    const noRisk = { ...goodBook, volatility: null, maxDrawdown: null };
    const h = M.healthScore(noRisk);

    assert.ok(h.score >= 80, `a good book missing risk data must not be dragged down: got ${h.score}`);

    const vol = h.components.find(c => c.key === 'volatility');
    assert.equal(vol.score, null);
    assert.equal(vol.weight, 0);
    assert.match(vol.explanation, /Not available/);

    // Surviving weights must still add to ~100%.
    const total = h.components.reduce((s, c) => s + c.weight, 0);
    assert.ok(Math.abs(total - 100) <= 1, `weights should rescale to ~100, got ${total}`);
    assert.match(h.note, /rescaled/);
  });

  test('with no computable inputs at all the score is null, not 0', () => {
    const h = M.healthScore({});
    assert.equal(h.score, null);
    assert.equal(h.rating, 'Unknown');
  });
});
