// ── Technical indicators ─────────────────────────────────────────────────────
//
// These numbers are handed to a language model AS FACT. A wrong RSI here doesn't
// produce an obviously wrong report — it produces a confident, fluent, wrong one.
// So every indicator is checked against a value derived independently.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/holdings/technicals');

const close = (a, b, eps = 0.01) => Math.abs(a - b) < eps;

// Synthetic bars from a close series (h/l straddle the close by 1%).
const mk = (closes) => closes.map((c, i) => ({
  t: i * 86400000,
  o: c, h: c * 1.01, l: c * 0.99, c, v: 100000,
}));

describe('sma / ema', () => {
  test('sma is the mean of the last n', () => {
    assert.equal(T.sma([1, 2, 3, 4, 5], 5), 3);
    assert.equal(T.sma([10, 20, 30, 40], 2), 35);
  });

  test('sma returns null when history is too short', () => {
    assert.equal(T.sma([1, 2], 5), null);
  });

  test('ema of a constant series equals that constant', () => {
    assert.ok(close(T.ema(Array(30).fill(50), 10), 50));
  });

  test('ema is seeded from the SMA of the first period, then smoothed', () => {
    // [1..10], period 5: seed = mean(1..5) = 3, then k = 2/6 = 0.3333
    // 6: 3 + (6-3)*1/3 = 4;  7: 4+1 = 5;  8: 6;  9: 7;  10: 8
    assert.ok(close(T.ema([1,2,3,4,5,6,7,8,9,10], 5), 8, 0.01));
  });
});

describe('rsi', () => {
  // A series that only ever rises has no losses -> RSI pinned at 100.
  test('a monotonically rising series has RSI 100', () => {
    assert.equal(T.rsi(Array.from({ length: 30 }, (_, i) => 100 + i), 14), 100);
  });

  test('a monotonically falling series has RSI 0', () => {
    assert.equal(T.rsi(Array.from({ length: 30 }, (_, i) => 100 - i), 14), 0);
  });

  test('a flat series is neutral at 50, not NaN', () => {
    assert.equal(T.rsi(Array(30).fill(100), 14), 50);
  });

  test('RSI stays within 0..100 on a noisy series', () => {
    const noisy = Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i / 3) * 10);
    const r = T.rsi(noisy, 14);
    assert.ok(r >= 0 && r <= 100, `got ${r}`);
  });

  test('returns null when history is shorter than the period', () => {
    assert.equal(T.rsi([1, 2, 3], 14), null);
  });
});

describe('macd', () => {
  test('a constant series has a zero MACD and zero histogram', () => {
    const m = T.macd(Array(60).fill(100));
    assert.ok(close(m.macd, 0, 1e-6));
    assert.ok(close(m.histogram, 0, 1e-6));
  });

  test('a steadily rising series has a positive MACD (fast EMA above slow)', () => {
    const m = T.macd(Array.from({ length: 80 }, (_, i) => 100 + i * 2));
    assert.ok(m.macd > 0, `expected positive, got ${m.macd}`);
  });

  test('a steadily falling series has a negative MACD', () => {
    const m = T.macd(Array.from({ length: 80 }, (_, i) => 300 - i * 2));
    assert.ok(m.macd < 0, `expected negative, got ${m.macd}`);
  });

  test('returns null without enough history', () => {
    assert.equal(T.macd(Array(20).fill(100)), null);
  });
});

describe('atr', () => {
  test('measures true range including gaps, not just the bar range', () => {
    // Flat 10-wide bars, then a gap up: TR must reflect the gap from prev close.
    const b = Array.from({ length: 20 }, () => ({ h: 105, l: 95, c: 100 }));
    b.push({ h: 205, l: 195, c: 200 });   // gapped far above the prior close
    const a = T.atr(b, 14);
    assert.ok(a > 10, `ATR should exceed the 10-wide bar range after a gap, got ${a}`);
  });

  test('a series of identical bars with no gaps has ATR equal to the bar range', () => {
    const b = Array.from({ length: 30 }, () => ({ h: 110, l: 100, c: 105 }));
    assert.ok(close(T.atr(b, 14), 10, 0.5));
  });
});

describe('trend', () => {
  test('rising price above rising averages is an uptrend', () => {
    const t = T.trend(Array.from({ length: 250 }, (_, i) => 100 + i));
    assert.equal(t.direction, 'Uptrend');
    assert.equal(t.strength, 'Strong');   // also above the 200-day
  });

  test('falling price below falling averages is a downtrend', () => {
    const t = T.trend(Array.from({ length: 250 }, (_, i) => 400 - i));
    assert.equal(t.direction, 'Downtrend');
    assert.equal(t.strength, 'Strong');
  });

  test('a flat series is sideways, not a trend', () => {
    assert.equal(T.trend(Array(250).fill(100)).direction, 'Sideways');
  });

  test('carries the numbers the label was derived from, so it is auditable', () => {
    const t = T.trend(Array.from({ length: 250 }, (_, i) => 100 + i));
    assert.ok(t.sma20 > 0 && t.sma50 > 0 && t.sma200 > 0);
    assert.ok(t.sma20 > t.sma50, 'in an uptrend the fast MA sits above the slow');
  });
});

describe('supportResistance', () => {
  test('finds a level the price repeatedly turned at', () => {
    // Oscillate between ~90 and ~110 so pivots cluster at both ends.
    const c = [];
    for (let i = 0; i < 12; i++) c.push(...[90, 95, 100, 105, 110, 105, 100, 95]);
    const { support, resistance } = T.supportResistance(mk(c));

    assert.ok(support.length > 0 || resistance.length > 0, 'should find pivots');
    for (const lv of [...support, ...resistance]) {
      assert.ok(lv.touches >= 1);
      assert.ok(Number.isFinite(lv.level));
      assert.ok(Number.isFinite(lv.distancePct));
    }
  });

  test('support sits below the last price and resistance above — never crossed', () => {
    const c = [];
    for (let i = 0; i < 12; i++) c.push(...[90, 95, 100, 105, 110, 105, 100, 95]);
    const bars = mk(c);
    const last = bars[bars.length - 1].c;
    const { support, resistance } = T.supportResistance(bars);

    support.forEach(s => assert.ok(s.level < last, `support ${s.level} must be below ${last}`));
    resistance.forEach(r => assert.ok(r.level > last, `resistance ${r.level} must be above ${last}`));
  });

  test('a series with no swings yields no levels rather than invented ones', () => {
    const { support, resistance } = T.supportResistance(mk(Array(60).fill(100)));
    assert.equal(support.length + resistance.length, 0);
  });
});

// ── Padded-bar detection ─────────────────────────────────────────────────────
//
// Regression from the real portfolio: COLAB.BO returned 249 daily bars, of which
// 134 had zero volume and an unchanged close — the data provider padding days the
// stock did not trade. RSI over that series computed to exactly 0.0, a value no
// real security produces. Handed to a language model as fact, it would have
// generated a confident, fluent, and completely wrong "deeply oversold" report.
describe('cleanBars (padded non-trading days)', () => {
  const real = (c, v) => ({ o: c, h: c * 1.01, l: c * 0.99, c, v });

  test('drops zero-volume bars that repeat the previous close', () => {
    const b = [real(100, 5000), real(100, 0), real(100, 0), real(105, 4000)];
    const r = T.cleanBars(b);
    assert.equal(r.bars.length, 2);
    assert.equal(r.padded, 2);
    assert.equal(r.paddedPct, 50);
  });

  test('KEEPS a zero-volume bar whose price moved (odd, but not padding)', () => {
    const b = [real(100, 5000), real(110, 0)];
    assert.equal(T.cleanBars(b).padded, 0);
  });

  test('keeps a low-volume bar that actually traded', () => {
    const b = [real(100, 5000), real(100, 1)];
    assert.equal(T.cleanBars(b).padded, 0);
  });

  test('a fully real series drops nothing', () => {
    const b = Array.from({ length: 50 }, (_, i) => real(100 + i, 1000));
    assert.equal(T.cleanBars(b).padded, 0);
  });

  test('flags a thinly traded series as unreliable instead of reporting a clean RSI', () => {
    // Mimic COLAB: ~54% of bars are padding.
    const b = [];
    for (let i = 0; i < 120; i++) {
      b.push(real(100 + Math.sin(i / 5) * 8, 3000));
      b.push({ ...b[b.length - 1], v: 0 });      // padded repeat of that close
    }
    const r = T.computeAll(b);

    assert.equal(r.available, true, 'still computes on the real bars');
    assert.equal(r.dataQuality.reliable, false, 'must be flagged unreliable');
    assert.ok(r.dataQuality.paddedPct > 40);
    assert.match(r.dataQuality.note, /thinly/i);
  });

  test('refuses entirely when padding leaves too few real trading days', () => {
    const b = [];
    for (let i = 0; i < 10; i++) {
      b.push(real(100, 3000));
      for (let k = 0; k < 9; k++) b.push({ ...b[b.length - 1], v: 0 });
    }
    const r = T.computeAll(b);
    assert.equal(r.available, false);
    assert.match(r.reason, /thinly traded/i);
  });

  test('a healthy series is marked reliable', () => {
    const c = Array.from({ length: 250 }, (_, i) => 100 + Math.sin(i / 10) * 15 + i * 0.2);
    const r = T.computeAll(c.map((x, i) => ({ o: x, h: x * 1.01, l: x * 0.99, c: x, v: 100000 + i })));
    assert.equal(r.dataQuality.reliable, true);
    assert.equal(r.dataQuality.note, null);
  });
});

describe('computeAll', () => {
  test('refuses to compute on too little history instead of guessing', () => {
    const r = T.computeAll(mk(Array(10).fill(100)));
    assert.equal(r.available, false);
    assert.match(r.reason, /too short/i);
  });

  test('returns every indicator on a full year of bars', () => {
    const c = Array.from({ length: 250 }, (_, i) => 100 + Math.sin(i / 10) * 15 + i * 0.2);
    const r = T.computeAll(mk(c));

    assert.equal(r.available, true);
    assert.ok(Number.isFinite(r.lastClose));
    assert.ok(Number.isFinite(r.rsi14));
    assert.ok(r.trend && r.trend.direction);
    assert.ok(r.macd && Number.isFinite(r.macd.histogram));
    assert.ok(Number.isFinite(r.atr14));
    assert.ok(r.range52w && Number.isFinite(r.range52w.fromHighPct));
    assert.ok(r.volume && Number.isFinite(r.volume.ratio));
  });

  // The whole point of the null discipline: the model must be told "unknown",
  // never handed a fabricated number it will then describe with confidence.
  test('at 32 bars: RSI computes, but MACD and trend are null rather than guessed', () => {
    // RSI(14) needs 15 bars. MACD needs 26 + 9 = 35. Trend needs the 50-day SMA.
    const r = T.computeAll(mk(Array.from({ length: 32 }, (_, i) => 100 + i)));
    assert.equal(r.available, true);
    assert.ok(Number.isFinite(r.rsi14), 'RSI is computable at 32 bars');
    assert.equal(r.macd,  null, 'MACD needs 35 bars — must be null, not a guess');
    assert.equal(r.trend, null, 'trend needs the 50-day SMA — must be null, not a guess');
  });

  test('at 60 bars: trend computes, but the 200-day SMA is still null', () => {
    const r = T.computeAll(mk(Array.from({ length: 60 }, (_, i) => 100 + i)));
    assert.ok(r.trend, 'trend is computable at 60 bars');
    assert.ok(Number.isFinite(r.trend.sma50));
    assert.equal(r.trend.sma200, null, '200-day SMA cannot exist with 60 bars');
    assert.equal(r.trend.priceVsSma200Pct, null);
  });
});
