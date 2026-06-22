/**
 * engineUtils.js — shared indicator primitives for the consensus engine layer.
 * Imported by luxAlgoEngine, trendSpiderEngine, chartPrimeEngine, algoAlphaEngine.
 * (emaVolEngine has its own inline implementations — refactor deferred.)
 */

'use strict';

// ── Moving averages ───────────────────────────────────────────────────────────

function computeEMA(prices, period) {
  const result = new Array(prices.length).fill(null);
  if (prices.length < period) return result;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += (prices[i] || 0);
  result[period - 1] = sum / period;
  for (let i = period; i < prices.length; i++) {
    result[i] = (prices[i] || result[i - 1]) * k + result[i - 1] * (1 - k);
  }
  return result;
}

// Wilder's RMA — used for ATR and RSI smoothing
function computeRMA(values, period) {
  const result = new Array(values.length).fill(null);
  if (values.length < period) return result;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += (values[i] || 0);
  result[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    result[i] = (result[i - 1] * (period - 1) + (values[i] || 0)) / period;
  }
  return result;
}

// Kaufman Adaptive Moving Average
function computeKAMA(prices, erPeriod = 10, fastPeriod = 2, slowPeriod = 30) {
  const result  = new Array(prices.length).fill(null);
  const fastSC  = 2 / (fastPeriod + 1);
  const slowSC  = 2 / (slowPeriod + 1);
  if (prices.length <= erPeriod) return result;
  result[erPeriod] = prices[erPeriod];
  for (let i = erPeriod + 1; i < prices.length; i++) {
    const direction  = Math.abs(prices[i] - prices[i - erPeriod]);
    let   volatility = 0;
    for (let j = 1; j <= erPeriod; j++) {
      volatility += Math.abs(prices[i - j + 1] - prices[i - j]);
    }
    const er  = volatility > 0 ? direction / volatility : 0;
    const sc  = (er * (fastSC - slowSC) + slowSC) ** 2;
    result[i] = result[i - 1] + sc * (prices[i] - result[i - 1]);
  }
  return result;
}

// ── Volatility indicators ─────────────────────────────────────────────────────

function computeATR(bars, period = 14) {
  const tr = bars.map((bar, i) => {
    if (i === 0) return bar.h - bar.l;
    const prev = bars[i - 1];
    return Math.max(bar.h - bar.l, Math.abs(bar.h - prev.c), Math.abs(bar.l - prev.c));
  });
  return computeRMA(tr, period);
}

function computeStdDev(values, period = 20) {
  return values.map((_, i) => {
    if (i < period - 1) return null;
    const slice = values.slice(i - period + 1, i + 1).filter(v => v != null);
    if (slice.length < period) return null;
    const mean     = slice.reduce((s, v) => s + v, 0) / slice.length;
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / slice.length;
    return Math.sqrt(variance);
  });
}

function computeBollingerBands(closes, period = 20, mult = 2) {
  const basis  = computeEMA(closes, period);
  const stddev = computeStdDev(closes, period);
  return {
    upper: basis.map((b, i) => (b && stddev[i]) ? b + mult * stddev[i] : null),
    basis,
    lower: basis.map((b, i) => (b && stddev[i]) ? b - mult * stddev[i] : null),
    width: basis.map((b, i) => (b && stddev[i] && b > 0) ? (mult * 2 * stddev[i]) / b : null),
  };
}

function computeKeltnerChannels(bars, emaPeriod = 20, atrPeriod = 10, mult = 1.5) {
  const closes = bars.map(b => b.c);
  const basis  = computeEMA(closes, emaPeriod);
  const atr    = computeATR(bars, atrPeriod);
  return {
    upper: basis.map((b, i) => (b && atr[i]) ? b + mult * atr[i] : null),
    basis,
    lower: basis.map((b, i) => (b && atr[i]) ? b - mult * atr[i] : null),
  };
}

// Standard SuperTrend (ATR-band trend direction)
function computeSuperTrend(bars, period = 10, multiplier = 3) {
  const atr       = computeATR(bars, period);
  const direction = new Array(bars.length).fill(null);
  const line      = new Array(bars.length).fill(null);
  let upperFinal  = null;
  let lowerFinal  = null;

  for (let i = 1; i < bars.length; i++) {
    if (!atr[i]) continue;
    const hl2        = (bars[i].h + bars[i].l) / 2;
    const upperBasic = hl2 + multiplier * atr[i];
    const lowerBasic = hl2 - multiplier * atr[i];
    const prevClose  = bars[i - 1].c;

    const newUpper = (!upperFinal || upperBasic < upperFinal || prevClose > upperFinal)
      ? upperBasic : upperFinal;
    const newLower = (!lowerFinal || lowerBasic > lowerFinal || prevClose < lowerFinal)
      ? lowerBasic : lowerFinal;

    upperFinal = newUpper;
    lowerFinal = newLower;

    const prevDir = direction[i - 1] ?? 1;
    if      (bars[i].c > (upperFinal ?? upperBasic)) direction[i] =  1;
    else if (bars[i].c < (lowerFinal ?? lowerBasic)) direction[i] = -1;
    else                                             direction[i] = prevDir;

    line[i] = direction[i] === 1 ? lowerFinal : upperFinal;
  }
  return { line, direction };
}

// ── Momentum indicators ───────────────────────────────────────────────────────

function computeRSI(closes, period = 14) {
  const result = new Array(closes.length).fill(null);
  if (closes.length <= period) return result;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain += Math.max(0, diff);
    avgLoss += Math.max(0, -diff);
  }
  avgGain /= period;
  avgLoss /= period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, diff))  / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -diff)) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

function computeROC(closes, period = 10) {
  return closes.map((c, i) =>
    (i >= period && closes[i - period]) ? (c / closes[i - period] - 1) * 100 : null
  );
}

// ── Structure utilities ───────────────────────────────────────────────────────

// Find swing pivot highs and lows
function findSwings(bars, lookback = 5) {
  const highs = [], lows = [];
  for (let i = lookback; i < bars.length - lookback; i++) {
    const isHigh = bars.slice(i - lookback, i).every(b => b.h <= bars[i].h) &&
                   bars.slice(i + 1, i + lookback + 1).every(b => b.h < bars[i].h);
    const isLow  = bars.slice(i - lookback, i).every(b => b.l >= bars[i].l) &&
                   bars.slice(i + 1, i + lookback + 1).every(b => b.l > bars[i].l);
    if (isHigh) highs.push({ index: i, price: bars[i].h });
    if (isLow)  lows.push({ index: i, price: bars[i].l });
  }
  return { highs, lows };
}

// Percentile rank of last value within its own history
function percentileRank(arr, lookback = 252) {
  const valid = arr.filter(v => v != null).slice(-lookback);
  if (valid.length < 2) return 50;
  const last  = valid[valid.length - 1];
  const below = valid.filter(v => v <= last).length;
  return Math.round((below / valid.length) * 100);
}

// Z-score of the last value vs its own rolling distribution
function zScore(arr, period = 50) {
  const valid = arr.filter(v => v != null).slice(-period);
  if (valid.length < 10) return 0;
  const mean  = valid.reduce((s, v) => s + v, 0) / valid.length;
  const std   = Math.sqrt(valid.reduce((s, v) => s + (v - mean) ** 2, 0) / valid.length);
  return std > 0 ? (valid[valid.length - 1] - mean) / std : 0;
}

module.exports = {
  computeEMA, computeRMA, computeKAMA,
  computeATR, computeStdDev, computeBollingerBands, computeKeltnerChannels,
  computeSuperTrend, computeRSI, computeROC,
  findSwings, percentileRank, zScore,
};
