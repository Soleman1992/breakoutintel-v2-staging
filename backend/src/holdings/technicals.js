// ── Technical indicators — pure functions ────────────────────────────────────
//
// These are FACTS, computed deterministically from price history. Nothing here
// is an opinion, a prediction, or a recommendation — it is arithmetic on closes.
//
// This separation is deliberate and load-bearing for the AI layer: the model is
// given these numbers and forbidden from inventing others. A language model
// asked to "estimate RSI" will produce a plausible number that is wrong; asked
// to *describe* an RSI of 71.3 that we computed, it cannot be wrong about the
// number.
//
// Every function returns null rather than a fabricated value when there is not
// enough history. Null propagates into "not available" in the report.

const bars = (b) => Array.isArray(b) ? b : [];
const closes = (b) => bars(b).map(x => x.c).filter(Number.isFinite);

/**
 * Strip padded non-trading bars.
 *
 * For thinly traded stocks the data provider fills days the stock did not trade
 * by repeating the previous close with zero volume. These are not observations —
 * they are placeholders, and every indicator computed over them is arithmetic on
 * fabricated data.
 *
 * Observed on a real holding: COLAB.BO returned 249 daily bars, of which 134 had
 * zero volume and an unchanged close. RSI over that series came out at exactly
 * 0.0 — a number no real security produces. Handed to a language model as fact,
 * it would have generated a confident, fluent, completely wrong "deeply oversold"
 * narrative about an artifact of the data feed.
 *
 * So: drop the padding, then report how much we dropped, so the caller can decide
 * whether what remains is worth trusting.
 */
function cleanBars(b) {
  const B = bars(b);
  if (B.length === 0) return { bars: [], padded: 0, paddedPct: 0 };

  const kept = [];
  let padded = 0;

  for (let i = 0; i < B.length; i++) {
    const bar = B[i];
    const prev = B[i - 1];
    const noVolume  = !bar.v;
    const unchanged = prev && bar.c === prev.c;

    // Both conditions together — a real zero-volume day with a price change is
    // odd but possible; a zero-volume day at exactly the prior close is padding.
    if (noVolume && unchanged) { padded++; continue; }
    kept.push(bar);
  }

  return {
    bars: kept,
    padded,
    paddedPct: Number((padded / B.length * 100).toFixed(1)),
  };
}

// ── Moving averages ─────────────────────────────────────────────────────────
function sma(values, period) {
  if (!values || values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function emaSeries(values, period) {
  if (!values || values.length < period) return [];
  const k = 2 / (period + 1);
  // Seed with the SMA of the first `period` values — the standard convention.
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = [prev];
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function ema(values, period) {
  const s = emaSeries(values, period);
  return s.length ? s[s.length - 1] : null;
}

// ── RSI (Wilder's smoothing) ────────────────────────────────────────────────
function rsi(values, period = 14) {
  if (!values || values.length < period + 1) return null;

  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;

  // Wilder smoothing over the remainder — NOT a simple average, which is the
  // most common way this gets computed wrong.
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// ── MACD ────────────────────────────────────────────────────────────────────
function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  if (!values || values.length < slow + signalPeriod) return null;

  const fastS = emaSeries(values, fast);
  const slowS = emaSeries(values, slow);

  // The two EMA series start at different offsets — align them on the tail.
  const n = Math.min(fastS.length, slowS.length);
  const macdLine = [];
  for (let i = 0; i < n; i++) {
    macdLine.push(fastS[fastS.length - n + i] - slowS[slowS.length - n + i]);
  }

  const signalS = emaSeries(macdLine, signalPeriod);
  if (!signalS.length) return null;

  const m = macdLine[macdLine.length - 1];
  const s = signalS[signalS.length - 1];
  return { macd: m, signal: s, histogram: m - s };
}

// ── ATR (Wilder) — volatility in price terms ────────────────────────────────
function atr(b, period = 14) {
  const B = bars(b);
  if (B.length < period + 1) return null;

  const trs = [];
  for (let i = 1; i < B.length; i++) {
    const h = B[i].h, l = B[i].l, pc = B[i - 1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }

  let a = trs.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < trs.length; i++) {
    a = (a * (period - 1) + trs[i]) / period;
  }
  return a;
}

// ── Support / resistance from swing pivots ──────────────────────────────────
/**
 * A swing high is a bar whose high exceeds the `lookback` bars either side of
 * it. Cluster nearby pivots (within `tolPct`) so we report levels, not noise.
 *
 * This is descriptive, not predictive: "price has repeatedly turned near 143"
 * is an observation about the past. It says nothing about what happens next.
 */
function supportResistance(b, { lookback = 5, tolPct = 1.5, max = 4 } = {}) {
  const B = bars(b);
  if (B.length < lookback * 2 + 1) return { support: [], resistance: [] };

  const last = B[B.length - 1].c;
  const highs = [], lows = [];

  for (let i = lookback; i < B.length - lookback; i++) {
    // A pivot must be a STRICT local extreme — strictly above (or below) every
    // neighbour, not merely equal to the window max.
    //
    // Using `===  Math.max(window)` looks right and is badly wrong: on a flat
    // series every bar equals both the window max AND the window min, so every
    // bar registers as both a swing high and a swing low, and the function
    // manufactures support and resistance out of a straight line. Those invented
    // levels would then be handed to the model as fact.
    const others = B.slice(i - lookback, i + lookback + 1).filter((_, k) => k !== lookback);
    if (B[i].h > Math.max(...others.map(x => x.h))) highs.push(B[i].h);
    if (B[i].l < Math.min(...others.map(x => x.l))) lows.push(B[i].l);
  }

  const cluster = (levels) => {
    const sorted = [...levels].sort((a, b) => a - b);
    const out = [];
    for (const lv of sorted) {
      const hit = out.find(c => Math.abs(c.level - lv) / c.level * 100 <= tolPct);
      if (hit) {
        hit.touches++;
        hit.level = (hit.level * (hit.touches - 1) + lv) / hit.touches;  // running mean
      } else {
        out.push({ level: lv, touches: 1 });
      }
    }
    // More touches = a level the market has actually respected more often.
    return out.sort((a, b) => b.touches - a.touches);
  };

  const res = cluster(highs).filter(c => c.level > last).sort((a, b) => a.level - last - (b.level - last));
  const sup = cluster(lows).filter(c => c.level < last).sort((a, b) => last - a.level - (last - b.level));

  const fmt = (c) => ({
    level: Number(c.level.toFixed(2)),
    touches: c.touches,
    distancePct: Number(((c.level - last) / last * 100).toFixed(2)),
  });

  return {
    support:    sup.slice(0, max).map(fmt),
    resistance: res.slice(0, max).map(fmt),
  };
}

// ── Trend ───────────────────────────────────────────────────────────────────
/**
 * Trend from moving-average structure. A label, derived from the numbers — and
 * the numbers travel with it so the label is always auditable.
 */
function trend(values) {
  const s20  = sma(values, 20);
  const s50  = sma(values, 50);
  const s200 = sma(values, 200);
  const last = values[values.length - 1];
  if (last == null || s20 == null || s50 == null) return null;

  let direction, strength;
  const above200 = s200 != null ? last > s200 : null;

  if (last > s20 && s20 > s50) {
    direction = 'Uptrend';
    strength = (above200 === true) ? 'Strong' : 'Moderate';
  } else if (last < s20 && s20 < s50) {
    direction = 'Downtrend';
    strength = (above200 === false) ? 'Strong' : 'Moderate';
  } else {
    direction = 'Sideways';
    strength = 'Weak';
  }

  return {
    direction,
    strength,
    sma20:  s20  != null ? Number(s20.toFixed(2))  : null,
    sma50:  s50  != null ? Number(s50.toFixed(2))  : null,
    sma200: s200 != null ? Number(s200.toFixed(2)) : null,
    priceVsSma200Pct: s200 != null ? Number(((last - s200) / s200 * 100).toFixed(2)) : null,
  };
}

// ── Volume ──────────────────────────────────────────────────────────────────
function volume(b) {
  const B = bars(b);
  if (B.length < 20) return null;
  const recent = B.slice(-20).map(x => x.v).filter(Number.isFinite);
  if (!recent.length) return null;
  const avg20 = recent.reduce((a, x) => a + x, 0) / recent.length;
  const latest = B[B.length - 1].v;
  return {
    latest,
    avg20: Math.round(avg20),
    ratio: avg20 > 0 ? Number((latest / avg20).toFixed(2)) : null,
  };
}

// ── 52-week range ───────────────────────────────────────────────────────────
function fiftyTwoWeek(b) {
  const B = bars(b).slice(-252);
  if (B.length < 30) return null;
  const hi = Math.max(...B.map(x => x.h));
  const lo = Math.min(...B.map(x => x.l));
  const last = B[B.length - 1].c;
  return {
    high: Number(hi.toFixed(2)),
    low:  Number(lo.toFixed(2)),
    fromHighPct: Number(((last - hi) / hi * 100).toFixed(2)),
    fromLowPct:  Number(((last - lo) / lo * 100).toFixed(2)),
  };
}

/**
 * Everything the AI layer is allowed to talk about, in one object.
 *
 * The contract with the model is: these are the only numbers that exist. If a
 * field is null, the report says "not available" — it does not guess.
 */
function computeAll(b) {
  const raw = bars(b);
  const { bars: B, padded, paddedPct } = cleanBars(raw);
  const c = closes(B);

  if (c.length < 30) {
    return {
      available: false,
      reason: padded > 0
        ? `Only ${c.length} real trading days in the last year (${padded} of ${raw.length} bars were non-trading padding) — too thinly traded for technical analysis.`
        : `Only ${c.length} days of history — too short for technical analysis.`,
      dataQuality: { tradingDays: c.length, paddedBars: padded, paddedPct },
    };
  }

  // A stock that did not trade on a third of the days in the year does not have
  // meaningful momentum or trend indicators, no matter what the arithmetic says.
  // Say so, loudly, rather than letting the numbers speak with false authority.
  const reliable = paddedPct < 20;

  return {
    available: true,
    bars: B.length,
    dataQuality: {
      tradingDays: c.length,
      paddedBars:  padded,
      paddedPct,
      reliable,
      note: reliable
        ? null
        : `${padded} of ${raw.length} daily bars had no volume and an unchanged price — this stock trades thinly. ` +
          `The indicators below are computed on the ${c.length} real trading days only, and should still be treated as unreliable.`,
    },
    lastClose: Number(c[c.length - 1].toFixed(2)),
    trend:     trend(c),
    rsi14:     rsi(c, 14) != null ? Number(rsi(c, 14).toFixed(1)) : null,
    macd:      (() => {
      const m = macd(c);
      return m ? { macd: +m.macd.toFixed(2), signal: +m.signal.toFixed(2), histogram: +m.histogram.toFixed(2) } : null;
    })(),
    ema20:     ema(c, 20) != null ? Number(ema(c, 20).toFixed(2)) : null,
    ema50:     ema(c, 50) != null ? Number(ema(c, 50).toFixed(2)) : null,
    atr14:     atr(B, 14) != null ? Number(atr(B, 14).toFixed(2)) : null,
    levels:    supportResistance(B),
    volume:    volume(B),
    range52w:  fiftyTwoWeek(B),
  };
}

module.exports = {
  sma, ema, emaSeries, rsi, macd, atr,
  supportResistance, trend, volume, fiftyTwoWeek,
  cleanBars, computeAll,
};
