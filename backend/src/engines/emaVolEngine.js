/**
 * emaVolEngine.js — EMA + Volume Engine
 *
 * Role in consensus: ANCHOR VOTE (the skeptic / baseline).
 * Purpose: classical trend-following confirmation. Deliberately simple
 * and hard to fool. Its job is to VETO exotic signals that lack basic
 * price + volume confirmation.
 *
 * Sub-scores (weighted to engine score 0-100):
 *   trendQuality     30%  — EMA stack integrity + price position + slopes
 *   volume           25%  — U/D volume ratio + OBV slope + vol vs avg
 *   breakout         20%  — N-day high break + volume expansion
 *   relativeStrength 15%  — 52-wk position + multi-period momentum
 *   continuation     10%  — pullback-to-EMA-and-hold pattern
 *
 * MTF weighting: Weekly 50% / Daily 30% / 4H 20%
 *
 * Output contract (standardised across all 5 engines):
 *   { engine, ticker, score, subscores, direction, confidence,
 *     timeframe_scores: { W, D, H4 }, flags, computed_at }
 */

'use strict';

// ── Indicator utilities ───────────────────────────────────────────────────────

/**
 * Exponential Moving Average.
 * Returns array of same length as prices; entries before period-1 are null.
 */
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

/**
 * On-Balance Volume.
 * Returns cumulative OBV array aligned with bars (index 0 = 0).
 */
function computeOBV(bars) {
  const result = new Array(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].c > bars[i - 1].c)      result[i] = result[i - 1] + bars[i].v;
    else if (bars[i].c < bars[i - 1].c) result[i] = result[i - 1] - bars[i].v;
    else                                 result[i] = result[i - 1];
  }
  return result;
}

// ── Sub-score functions ───────────────────────────────────────────────────────

/**
 * Trend Quality Score (0-100).
 * Measures EMA stack integrity, price position above stack, and slope direction.
 * Handles null EMAs gracefully (insufficient data → neutral contribution).
 */
function scoreTrendQuality(bars, ind) {
  const last  = bars.length - 1;
  const price = bars[last].c;
  const { ema20, ema50, ema100, ema200 } = ind;

  const e20  = ema20?.[last];
  const e50  = ema50?.[last];
  const e100 = ema100?.[last];
  const e200 = ema200?.[last];

  if (!e20) return { score: 50, flags: ['insufficient_data_tq'] };

  const flags = [];
  let score   = 0;

  // ── EMA stack integrity (40 pts) ─────────────────────────────────────────
  const pairs = [[e20, e50], [e50, e100], [e100, e200]].filter(([a, b]) => a && b);
  if (pairs.length > 0) {
    const bullPairs = pairs.filter(([a, b]) => a > b).length;
    score += (bullPairs / pairs.length) * 40;
    if (bullPairs === pairs.length && pairs.length === 3) flags.push('ema_stack_full');
    else if (bullPairs === pairs.length)                  flags.push('ema_stack_partial');
  } else {
    score += 20; // neutral when only EMA20 available
  }

  // ── Price position above EMAs (30 pts) ───────────────────────────────────
  const emas       = [e20, e50, e100, e200].filter(Boolean);
  const aboveCount = emas.filter(e => price > e).length;
  score += (aboveCount / emas.length) * 30;
  if (aboveCount === emas.length && emas.length >= 3) flags.push('price_above_all_ema');

  // ── Slope direction (30 pts) — compare current EMA vs 5 bars ago ─────────
  const lb = Math.max(0, last - 5);
  const slopeChecks = [
    ema20  ? (ema20[last]  > ema20[lb])  : null,
    ema50  ? (ema50[last]  > ema50[lb])  : null,
    ema200 ? (ema200[last] > ema200[lb]) : null,
  ].filter(s => s !== null);

  if (slopeChecks.length > 0) {
    const rising = slopeChecks.filter(Boolean).length;
    score += (rising / slopeChecks.length) * 30;
    if (rising === slopeChecks.length) flags.push('all_slopes_rising');
  } else {
    score += 15; // neutral
  }

  return { score: Math.min(100, Math.round(score)), flags };
}

/**
 * Volume Score (0-100).
 * Up/Down volume ratio (accumulation proxy), OBV slope, recent vol vs avg.
 */
function scoreVolume(bars) {
  const last = bars.length - 1;
  const flags = [];
  let score   = 0;

  // ── U/D volume ratio over last 20 bars (40 pts) ──────────────────────────
  const lb20 = Math.max(0, last - 20);
  let upVol = 0, downVol = 0;
  for (let i = lb20; i <= last; i++) {
    if (bars[i].c >= bars[i].o) upVol   += bars[i].v;
    else                         downVol += bars[i].v;
  }
  const udRatio = downVol > 0 ? upVol / downVol : 2;
  if      (udRatio >= 2.0) { score += 40; flags.push('strong_accumulation'); }
  else if (udRatio >= 1.5) score += 30;
  else if (udRatio >= 1.0) score += 20;
  else                     score += 5;

  // ── OBV slope (35 pts) ───────────────────────────────────────────────────
  if (bars.length >= 11) {
    const obv      = computeOBV(bars);
    const obvSlope = obv[last] > obv[last - 10];
    if (obvSlope) { score += 35; flags.push('obv_rising'); }
  } else {
    score += 17; // neutral
  }

  // ── Recent volume vs 50-bar average (25 pts) ─────────────────────────────
  const lb50   = Math.max(0, last - 50);
  const avgVol = bars.slice(lb50, last).reduce((s, b) => s + b.v, 0) / Math.max(1, last - lb50);
  const volRatio = avgVol > 0 ? bars[last].v / avgVol : 1;
  if      (volRatio >= 1.5) { score += 25; flags.push('volume_above_avg'); }
  else if (volRatio >= 1.0) score += 15;
  else                      score += 5;

  return { score: Math.min(100, Math.round(score)), flags };
}

/**
 * Breakout Score (0-100).
 * Close above N-day highs with volume expansion.
 * Penalises volume-less breakouts with the volume_fail flag.
 */
function scoreBreakout(bars) {
  const last  = bars.length - 1;
  const price = bars[last].c;
  const flags = [];
  let score   = 0;

  // ── N-day high breaks (50 pts) ───────────────────────────────────────────
  const sliceHigh = (n) => Math.max(...bars.slice(Math.max(0, last - n), last).map(b => b.h));
  const h20  = last >= 20  ? sliceHigh(20)  : null;
  const h50  = last >= 50  ? sliceHigh(50)  : null;
  const h252 = last >= 252 ? sliceHigh(252) : null;

  if      (h252 && price > h252) { score += 50; flags.push('52wk_high_breakout'); }
  else if (h50  && price > h50)  { score += 35; flags.push('50d_high_breakout');  }
  else if (h20  && price > h20)  { score += 20; flags.push('20d_high_breakout');  }
  else if (h20) {
    // Near-breakout bonus: within 3% of 20d high
    const distPct = (h20 - price) / h20;
    if (distPct < 0.03)      score += 12;
    else if (distPct < 0.05) score += 6;
  }

  // ── Volume expansion on breakout day (30 pts) ────────────────────────────
  const lb21   = Math.max(0, last - 21);
  const avgVol = bars.slice(lb21, last).reduce((s, b) => s + b.v, 0) / Math.max(1, last - lb21);
  const volExp = avgVol > 0 ? bars[last].v / avgVol : 1;

  if      (volExp >= 2.0) { score += 30; flags.push('volume_expansion_2x'); }
  else if (volExp >= 1.5) { score += 20; flags.push('volume_expansion');    }
  else if (volExp >= 1.0) score += 10;
  else if (score > 0)     flags.push('volume_fail'); // breakout exists but vol weak

  // ── Consolidation tightness bonus (20 pts) ───────────────────────────────
  // Low ATR% in recent 10 bars relative to 50-bar ATR% → tight base
  if (bars.length >= 50) {
    const atrPct = (b) => (b.h - b.l) / b.c;
    const recent10avg = bars.slice(Math.max(0, last - 10), last).reduce((s, b) => s + atrPct(b), 0) / 10;
    const prior50avg  = bars.slice(Math.max(0, last - 50), last - 10).reduce((s, b) => s + atrPct(b), 0) / 40;
    if (prior50avg > 0 && recent10avg / prior50avg < 0.6) {
      score += 20;
      flags.push('tight_base');
    } else if (prior50avg > 0 && recent10avg / prior50avg < 0.8) {
      score += 10;
    }
  }

  return { score: Math.min(100, Math.round(score)), flags };
}

/**
 * Relative Strength Score (0-100).
 * 52-week position + multi-period price momentum.
 * Cross-sectional RS vs Nifty 500 added at consensus layer (Phase 3+).
 */
function scoreRelativeStrength(bars) {
  const last  = bars.length - 1;
  const price = bars[last].c;
  const flags = [];
  let score   = 0;

  // ── 52-week high/low position (40 pts) ───────────────────────────────────
  const hist = bars.slice(Math.max(0, last - 252));
  const high52 = Math.max(...hist.map(b => b.h));
  const low52  = Math.min(...hist.map(b => b.l));
  const range  = high52 - low52;
  const pos52  = range > 0 ? (price - low52) / range : 0.5;

  if      (pos52 >= 0.80) { score += 40; flags.push('near_52wk_high'); }
  else if (pos52 >= 0.60) score += 30;
  else if (pos52 >= 0.40) score += 20;
  else if (pos52 >= 0.20) score += 10;

  // ── 21-day return (25 pts) ───────────────────────────────────────────────
  if (last >= 21) {
    const r21 = (price / bars[last - 21].c - 1) * 100;
    if      (r21 >= 5)  score += 25;
    else if (r21 >= 2)  score += 18;
    else if (r21 >= 0)  score += 10;
    else                score += 2;
  } else score += 12;

  // ── 63-day return (20 pts) ───────────────────────────────────────────────
  if (last >= 63) {
    const r63 = (price / bars[last - 63].c - 1) * 100;
    if      (r63 >= 10) score += 20;
    else if (r63 >= 5)  score += 14;
    else if (r63 >= 0)  score += 7;
    else                score += 1;
  } else score += 10;

  // ── 126-day return (15 pts) ──────────────────────────────────────────────
  if (last >= 126) {
    const r126 = (price / bars[last - 126].c - 1) * 100;
    if      (r126 >= 15) score += 15;
    else if (r126 >= 7)  score += 10;
    else if (r126 >= 0)  score += 5;
    else                 score += 1;
  } else score += 7;

  return { score: Math.min(100, Math.round(score)), flags };
}

/**
 * Continuation Probability Score (0-100).
 * Detects pullback-to-EMA-and-hold behaviour (healthy trend continuation signal).
 */
function scoreContinuation(bars, ind) {
  const last  = bars.length - 1;
  const price = bars[last].c;
  const { ema20, ema50 } = ind;

  const e20 = ema20?.[last];
  const e50 = ema50?.[last];
  if (!e20) return { score: 50, flags: [] };

  const flags = [];

  // Scan last 10 bars for touch of EMA (low within 1% of EMA value)
  let touchedEMA20 = false;
  let touchedEMA50 = false;
  const scanStart = Math.max(1, last - 10);

  for (let i = scanStart; i < last; i++) {
    if (e20 && Math.abs(bars[i].l - (ema20[i] || e20)) / e20 < 0.01) touchedEMA20 = true;
    if (e50 && Math.abs(bars[i].l - (ema50[i] || e50)) / e50 < 0.015) touchedEMA50 = true;
  }

  const holdingAboveEMA20 = price > e20;
  const holdingAboveEMA50 = e50 && price > e50;

  if (touchedEMA20 && holdingAboveEMA20) { flags.push('ema20_pullback_hold'); return { score: 88, flags }; }
  if (touchedEMA50 && holdingAboveEMA50) { flags.push('ema50_pullback_hold'); return { score: 80, flags }; }
  if (holdingAboveEMA20)                 { return { score: 62, flags }; }
  if (holdingAboveEMA50)                 { flags.push('below_ema20_above_ema50'); return { score: 42, flags }; }

  flags.push('below_ema50');
  return { score: 20, flags };
}

// ── Engine class ──────────────────────────────────────────────────────────────

class EmaVolEngine {

  /**
   * Compute all required indicators for a bar array.
   * Returns null if insufficient data (< 20 bars).
   */
  _computeIndicators(bars) {
    if (!bars || bars.length < 20) return null;
    const closes = bars.map(b => b.c);
    return {
      ema20:  computeEMA(closes, 20),
      ema50:  bars.length >= 50  ? computeEMA(closes, 50)  : null,
      ema100: bars.length >= 100 ? computeEMA(closes, 100) : null,
      ema200: bars.length >= 200 ? computeEMA(closes, 200) : null,
    };
  }

  /**
   * Score a single timeframe.
   * Returns a normalised score object with subscores, direction, and flags.
   */
  _scoreTF(bars, ind) {
    if (!bars || bars.length < 20 || !ind) {
      return {
        score: 50, direction: 'neutral', confidence: 0.3,
        subscores: { trendQuality: 50, volume: 50, breakout: 50, relativeStrength: 50, continuation: 50 },
        flags: ['insufficient_data'],
      };
    }

    const tq  = scoreTrendQuality(bars, ind);
    const vol = scoreVolume(bars);
    const brk = scoreBreakout(bars);
    const rs  = scoreRelativeStrength(bars);
    const cnt = scoreContinuation(bars, ind);

    // Weighted composite: TQ 30, Vol 25, Brk 20, RS 15, Cnt 10
    const composite = (tq.score  * 0.30) + (vol.score * 0.25) +
                      (brk.score * 0.20) + (rs.score  * 0.15) +
                      (cnt.score * 0.10);

    // Direction: derive from price vs key EMAs
    const last  = bars.length - 1;
    const price = bars[last].c;
    const e50   = ind.ema50?.[last];
    const e200  = ind.ema200?.[last];
    let direction = 'neutral';
    if      (e50 && e200 && price > e50 && e50 > e200) direction = 'long';
    else if (e50 && e200 && price < e50 && e50 < e200) direction = 'short';
    else if (e50 && price > e50)                        direction = 'long';
    else if (e50 && price < e50)                        direction = 'short';

    // Confidence scales with data depth (full at 252 bars = 1 year daily)
    const confidence = Math.min(1, Math.round((bars.length / 252) * 100) / 100);

    return {
      score:     Math.round(composite),
      direction,
      confidence,
      subscores: {
        trendQuality:     tq.score,
        volume:           vol.score,
        breakout:         brk.score,
        relativeStrength: rs.score,
        continuation:     cnt.score,
      },
      flags: [...tq.flags, ...vol.flags, ...brk.flags, ...rs.flags, ...cnt.flags],
    };
  }

  /**
   * Main entry point.
   * @param {Object} mtfData — output of MarketDataService.fetchMTFOHLCV(ticker)
   * @returns {Object} standardised engine output contract
   */
  compute(mtfData) {
    const { ticker, W = [], D = [], H4 = [] } = mtfData;

    const indW  = this._computeIndicators(W);
    const indD  = this._computeIndicators(D);
    const indH4 = this._computeIndicators(H4);

    const tfW  = this._scoreTF(W,  indW);
    const tfD  = this._scoreTF(D,  indD);
    const tfH4 = this._scoreTF(H4, indH4);

    // MTF composite — Weekly carries the primary bias
    const composite = (tfW.score * 0.50) + (tfD.score * 0.30) + (tfH4.score * 0.20);

    // Direction: majority vote (2 of 3 timeframes must agree)
    const votes     = [tfW.direction, tfD.direction, tfH4.direction];
    const longVotes  = votes.filter(d => d === 'long').length;
    const shortVotes = votes.filter(d => d === 'short').length;
    let direction = 'neutral';
    if (longVotes  >= 2) direction = 'long';
    if (shortVotes >= 2) direction = 'short';

    // Confidence: weighted average across timeframes
    const confidence = Math.round(
      ((tfW.confidence * 0.50) + (tfD.confidence * 0.30) + (tfH4.confidence * 0.20)) * 100
    ) / 100;

    // Merge flags (deduplicated)
    const allFlags = [...new Set([...tfW.flags, ...tfD.flags, ...tfH4.flags])];

    // Anchor-vote rule: volume_fail caps score at 60 (no confirmation = no S/A tier)
    let finalScore = Math.round(composite);
    if (allFlags.includes('volume_fail') && finalScore > 60) {
      finalScore = 60;
      allFlags.push('score_capped_volume_fail');
    }

    return {
      engine:           'emavol',
      ticker:           ticker || null,
      score:            finalScore,
      subscores:        tfD.subscores,       // Daily as primary reference
      direction,
      confidence,
      timeframe_scores: {
        W:  tfW.score,
        D:  tfD.score,
        H4: tfH4.score,
      },
      flags:       allFlags,
      computed_at: Date.now(),
    };
  }
}

module.exports = new EmaVolEngine();
