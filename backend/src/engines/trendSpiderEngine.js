/**
 * trendSpiderEngine.js — TrendSpider Approximation Engine
 *
 * Primary dimension: MULTI-TIMEFRAME ALIGNMENT + breakout quality.
 * Inefficiency targeted: single-timeframe traders getting trapped by
 * counter-trend moves on higher frames; subjective trendline drawing.
 *
 * Sub-scores (weighted to engine score 0-100):
 *   trendAlignment    30% — same direction on W + D + 4H (MTF core)
 *   breakoutQuality   25% — base tightness + clean break of range
 *   relativeStrength  20% — multi-period momentum vs own history
 *   mtfScore          15% — weighted W/D/4H directional agreement
 *   volumeConfirm     10% — breakout bar volume vs 20-day avg
 *
 * Penalty: breakout without volume expansion → breakoutQuality capped at 50.
 * MTF weighting: Weekly 40% / Daily 35% / 4H 25%
 */

'use strict';

const {
  computeEMA, computeATR, computeROC,
  findSwings, percentileRank,
} = require('./engineUtils');

// ── Sub-score functions ───────────────────────────────────────────────────────

/**
 * Trend Alignment Score — are all three timeframes pointed the same direction?
 * Receives per-TF direction signals derived from EMA stack.
 */
function scoreTrendAlignment(dirW, dirD, dirH4) {
  const votes     = [dirW, dirD, dirH4];
  const longCount  = votes.filter(d => d === 'long').length;
  const shortCount = votes.filter(d => d === 'short').length;
  const flags      = [];

  if      (longCount  === 3) { flags.push('full_mtf_bullish_alignment'); return { score: 100, flags }; }
  else if (shortCount === 3) { flags.push('full_mtf_bearish_alignment'); return { score: 0,   flags }; }
  else if (longCount  === 2) { return { score: 65, flags }; }
  else if (shortCount === 2) { return { score: 35, flags }; }

  return { score: 50, flags: ['mtf_conflict'] };
}

/**
 * Breakout Quality Score — base tightness + clean break of consolidation range.
 * A VCP or tight flat base before the break scores highest.
 */
function scoreBreakoutQuality(bars) {
  if (bars.length < 20) return { score: 50, flags: ['insufficient_data'] };

  const last  = bars.length - 1;
  const price = bars[last].c;
  const flags = [];

  // ── Base tightness: measure range over last 15 bars (40 pts) ─────────────
  const baseBars   = bars.slice(Math.max(0, last - 15), last);
  const baseHigh   = Math.max(...baseBars.map(b => b.h));
  const baseLow    = Math.min(...baseBars.map(b => b.l));
  const baseRange  = baseHigh > 0 ? (baseHigh - baseLow) / baseHigh : 0;

  // ATR% context to normalise the range
  const atr    = computeATR(bars, 14);
  const atrPct = atr[last] && bars[last].c > 0 ? atr[last] / bars[last].c : 0.02;

  const tightnessRatio = atrPct > 0 ? baseRange / (atrPct * 15) : 1; // < 1 = tight

  let tightScore = 0;
  if      (tightnessRatio < 0.6) { tightScore = 40; flags.push('vcp_tight_base'); }
  else if (tightnessRatio < 0.8) tightScore = 30;
  else if (tightnessRatio < 1.0) tightScore = 20;
  else                            tightScore = 8;

  // ── Break quality: close above base high (40 pts) ────────────────────────
  let breakScore = 0;
  if (price > baseHigh) {
    const breakPct = (price - baseHigh) / baseHigh;
    if      (breakPct > 0.03)  { breakScore = 40; flags.push('decisive_breakout'); }
    else if (breakPct > 0.01)  breakScore = 28;
    else                        breakScore = 16;
  } else {
    // Proximity to breakout point
    const distFromBreak = (baseHigh - price) / baseHigh;
    if (distFromBreak < 0.02)  breakScore = 10;
    else if (distFromBreak < 0.04) breakScore = 5;
  }

  // ── Consolidation duration bonus (20 pts) — longer base = more energy ────
  let durationScore = 0;
  if      (last >= 252 && baseRange < 0.10) durationScore = 20;
  else if (last >= 50  && baseRange < 0.12) durationScore = 12;
  else if (last >= 20  && baseRange < 0.15) durationScore = 6;

  const score = Math.min(100, tightScore + breakScore + durationScore);
  return { score, flags };
}

/**
 * Relative Strength Score — multi-period momentum as RS proxy.
 * Cross-sectional RS vs Nifty 500 added at consensus layer (Phase 4+).
 */
function scoreRelativeStrength(bars) {
  if (bars.length < 21) return { score: 50, flags: ['insufficient_data'] };

  const last  = bars.length - 1;
  const price = bars[last].c;
  const flags = [];
  let score   = 0;

  // 21/63/126-day returns (60 pts total)
  const periods = [
    { n: 21,  pts: 20 },
    { n: 63,  pts: 22 },
    { n: 126, pts: 18 },
  ];

  for (const { n, pts } of periods) {
    if (last < n) { score += pts * 0.5; continue; }
    const ret = (price / bars[last - n].c - 1) * 100;
    const threshold = n === 21 ? [3, 1, 0] : n === 63 ? [8, 4, 0] : [15, 7, 0];
    if      (ret >= threshold[0]) score += pts;
    else if (ret >= threshold[1]) score += pts * 0.65;
    else if (ret >= threshold[2]) score += pts * 0.35;
    else                          score += pts * 0.05;
  }

  // 52-week position (40 pts)
  const hist   = bars.slice(Math.max(0, last - 252));
  const high52 = Math.max(...hist.map(b => b.h));
  const low52  = Math.min(...hist.map(b => b.l));
  const pos52  = (high52 - low52) > 0 ? (price - low52) / (high52 - low52) : 0.5;

  if      (pos52 >= 0.85) { score += 40; flags.push('near_52wk_high'); }
  else if (pos52 >= 0.65) score += 28;
  else if (pos52 >= 0.45) score += 16;
  else if (pos52 >= 0.25) score += 8;

  return { score: Math.min(100, Math.round(score)), flags };
}

/**
 * MTF Score — weighted directional agreement across all three timeframes.
 * Separate from trendAlignment — this measures the strength of agreement,
 * not just the binary aligned/not.
 */
function scoreMTF(tfW, tfD, tfH4) {
  // Weekly is the primary bias (higher = more weight)
  const wScore = tfW.direction === 'long' ? tfW.score : tfW.direction === 'short' ? (100 - tfW.score) : 50;
  const dScore = tfD.direction === 'long' ? tfD.score : tfD.direction === 'short' ? (100 - tfD.score) : 50;
  const hScore = tfH4.direction === 'long' ? tfH4.score : tfH4.direction === 'short' ? (100 - tfH4.score) : 50;

  // Hard penalty: Weekly opposing Daily → heavy penalty
  let penalty = 0;
  if (tfW.direction !== 'neutral' && tfD.direction !== 'neutral' && tfW.direction !== tfD.direction) {
    penalty = 25;
  }

  const weighted = (wScore * 0.50) + (dScore * 0.30) + (hScore * 0.20);
  return { score: Math.max(0, Math.round(weighted - penalty)), flags: penalty ? ['weekly_daily_conflict'] : [] };
}

/**
 * Volume Confirmation Score — breakout bar volume vs 20-day average.
 */
function scoreVolumeConfirm(bars) {
  if (bars.length < 22) return { score: 50, flags: ['insufficient_data'] };

  const last   = bars.length - 1;
  const avgVol = bars.slice(Math.max(0, last - 21), last).reduce((s, b) => s + b.v, 0) / 20;
  const ratio  = avgVol > 0 ? bars[last].v / avgVol : 1;
  const flags  = [];
  let score    = 0;

  if      (ratio >= 2.0) { score = 100; flags.push('volume_surge_2x'); }
  else if (ratio >= 1.5) { score = 78;  flags.push('volume_expansion'); }
  else if (ratio >= 1.2) score = 55;
  else if (ratio >= 0.8) score = 35;
  else                   { score = 15;  flags.push('volume_contraction'); }

  return { score, flags };
}

// ── Direction helper (from EMA stack on a single TF) ─────────────────────────

function getTFDirection(bars) {
  if (!bars || bars.length < 50) return 'neutral';
  const closes = bars.map(b => b.c);
  const ema20  = computeEMA(closes, 20);
  const ema50  = computeEMA(closes, 50);
  const last   = bars.length - 1;
  const price  = closes[last];
  const e20    = ema20[last];
  const e50    = ema50[last];
  if (!e20 || !e50) return 'neutral';
  if (price > e20 && e20 > e50) return 'long';
  if (price < e20 && e20 < e50) return 'short';
  return 'neutral';
}

function getTFScore(bars) {
  const dir   = getTFDirection(bars);
  const score = dir === 'long' ? 70 : dir === 'short' ? 30 : 50;
  return { score, direction: dir };
}

// ── Engine class ──────────────────────────────────────────────────────────────

class TrendSpiderEngine {

  compute(mtfData) {
    const { ticker, W = [], D = [], H4 = [] } = mtfData;

    const tfW  = getTFScore(W);
    const tfD  = getTFScore(D);
    const tfH4 = getTFScore(H4);

    const dirW  = tfW.direction;
    const dirD  = tfD.direction;
    const dirH4 = tfH4.direction;

    const trendAlign   = scoreTrendAlignment(dirW, dirD, dirH4);
    const breakoutQ    = scoreBreakoutQuality(D.length >= 20 ? D : W);
    const relStrength  = scoreRelativeStrength(D.length >= 21 ? D : W);
    const mtfScore     = scoreMTF(tfW, tfD, tfH4);
    const volumeConf   = scoreVolumeConfirm(D.length >= 22 ? D : W);

    // Penalty: breakout without volume expansion caps breakoutQuality at 50
    let bqScore = breakoutQ.score;
    const bqFlags = [...breakoutQ.flags];
    if (breakoutQ.flags.includes('decisive_breakout') && volumeConf.score < 35) {
      bqScore = Math.min(bqScore, 50);
      bqFlags.push('breakout_volume_fail');
    }

    // Weighted composite: trendAlign 30, breakoutQ 25, relStrength 20, mtf 15, volConf 10
    const composite = (trendAlign.score  * 0.30) + (bqScore         * 0.25) +
                      (relStrength.score * 0.20) + (mtfScore.score  * 0.15) +
                      (volumeConf.score  * 0.10);

    // Overall direction from MTF alignment
    const votes      = [dirW, dirD, dirH4];
    const longVotes  = votes.filter(d => d === 'long').length;
    const shortVotes = votes.filter(d => d === 'short').length;
    let direction    = 'neutral';
    if (longVotes  >= 2) direction = 'long';
    if (shortVotes >= 2) direction = 'short';

    // Confidence: full when all 3 TFs have sufficient data
    const confidence = Math.round(Math.min(1,
      ((Math.min(W.length, 104) / 104) * 0.40) +
      ((Math.min(D.length, 252) / 252) * 0.40) +
      ((Math.min(H4.length, 60) / 60) * 0.20)
    ) * 100) / 100;

    const allFlags = [...new Set([
      ...trendAlign.flags, ...bqFlags, ...relStrength.flags,
      ...mtfScore.flags,   ...volumeConf.flags,
    ])];

    return {
      engine:  'trendspider',
      ticker:  ticker || null,
      score:   Math.round(composite),
      subscores: {
        trendAlignment:   trendAlign.score,
        breakoutQuality:  bqScore,
        relativeStrength: relStrength.score,
        mtfScore:         mtfScore.score,
        volumeConfirm:    volumeConf.score,
      },
      direction,
      confidence,
      timeframe_scores: { W: tfW.score, D: tfD.score, H4: tfH4.score },
      flags:            allFlags,
      computed_at:      Date.now(),
    };
  }
}

module.exports = new TrendSpiderEngine();
