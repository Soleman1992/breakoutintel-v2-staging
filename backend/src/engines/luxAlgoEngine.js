/**
 * luxAlgoEngine.js — LuxAlgo Approximation Engine
 *
 * Primary dimension: TREND REGIME detection + signal confidence.
 * Inefficiency targeted: retail noise around trend transitions; lag between
 * a regime actually changing and the crowd recognising it.
 *
 * Sub-scores (weighted to engine score 0-100):
 *   trend      35% — SuperTrend direction + price above adaptive band + persistence
 *   momentum   20% — normalized RSI + ROC blend aligned with trend
 *   structure  20% — swing pivot sequence (HH/HL = bull, LL/LH = bear)
 *   liquidity  10% — rejection quality at prior swing levels
 *   volatility 15% — ATR percentile in healthy 40-85th pct range
 *
 * Penalty: any sub-score < 40 caps engine score at 75 (false-positive guard).
 * MTF weighting: Weekly 50% / Daily 35% / 4H 15%
 */

'use strict';

const {
  computeEMA, computeATR, computeRSI, computeROC,
  computeSuperTrend, findSwings, percentileRank,
} = require('./engineUtils');

// ── Sub-score functions ───────────────────────────────────────────────────────

function scoreTrend(bars) {
  if (bars.length < 15) return { score: 50, flags: ['insufficient_data'] };

  const { line, direction } = computeSuperTrend(bars, 10, 3);
  const last  = bars.length - 1;
  const price = bars[last].c;
  const st    = line[last];
  const dir   = direction[last];
  const flags = [];

  if (st == null) return { score: 50, flags: ['supertrend_unavailable'] };

  let score = 0;

  // Direction (40 pts)
  if      (dir ===  1) { score += 40; flags.push('supertrend_bullish'); }
  else if (dir === -1) score += 0;
  else                  score += 20;

  // Price distance from SuperTrend line (30 pts)
  const distPct = (price - st) / st;
  if      (dir === 1  && distPct > 0.03) score += 30;
  else if (dir === 1  && distPct > 0.01) score += 22;
  else if (dir === 1  && distPct >= 0)   score += 14;
  else if (dir === -1 && distPct < 0)    score += 0;

  // Persistence: consecutive bars on same side (30 pts)
  let streak = 0;
  for (let i = last; i >= Math.max(0, last - 20); i--) {
    if (direction[i] === dir) streak++;
    else break;
  }
  if      (streak >= 15) { score += 30; flags.push('strong_trend_persistence'); }
  else if (streak >= 8)  score += 20;
  else if (streak >= 3)  score += 10;

  return { score: Math.min(100, Math.round(score)), flags };
}

function scoreMomentum(bars) {
  if (bars.length < 20) return { score: 50, flags: ['insufficient_data'] };

  const closes = bars.map(b => b.c);
  const rsi    = computeRSI(closes, 14);
  const roc10  = computeROC(closes, 10);
  const roc21  = computeROC(closes, 21);
  const last   = bars.length - 1;
  const flags  = [];

  const rsiVal  = rsi[last]  ?? 50;
  const roc10v  = roc10[last] ?? 0;
  const roc21v  = roc21[last] ?? 0;

  let score = 0;

  // RSI normalised to 0-100 score (50 pts)
  // Bullish zone: 50-80, overbought zone: >80 (slightly penalised for chasing)
  if      (rsiVal >= 60 && rsiVal <= 80) { score += 50; flags.push('rsi_bullish_zone'); }
  else if (rsiVal >= 50 && rsiVal < 60)  score += 35;
  else if (rsiVal >= 40 && rsiVal < 50)  score += 20;
  else if (rsiVal > 80)                  score += 30; // overbought — still bullish but risk
  else                                   score += 5;

  // RSI slope (5-bar) — 20 pts
  const rsiLb  = rsi[Math.max(0, last - 5)] ?? rsiVal;
  if (rsiVal > rsiLb + 2)  score += 20;
  else if (rsiVal > rsiLb) score += 12;

  // ROC alignment (30 pts)
  const rocAligned = (roc10v > 0 && roc21v > 0);
  const rocStrong  = rocAligned && roc10v > 2;
  if      (rocStrong)  { score += 30; flags.push('momentum_accelerating'); }
  else if (rocAligned) score += 18;
  else if (roc21v > 0) score += 8;

  return { score: Math.min(100, Math.round(score)), flags };
}

function scoreStructure(bars) {
  if (bars.length < 20) return { score: 50, flags: ['insufficient_data'] };

  const { highs, lows } = findSwings(bars, 5);
  const flags = [];
  let score   = 50; // neutral default

  if (highs.length < 2 || lows.length < 2) {
    return { score: 50, flags: ['insufficient_pivots'] };
  }

  const recentHighs = highs.slice(-3);
  const recentLows  = lows.slice(-3);

  // Higher highs check
  const hhCount = recentHighs.slice(1).filter((h, i) => h.price > recentHighs[i].price).length;
  // Higher lows check
  const hlCount = recentLows.slice(1).filter((l, i) => l.price > recentLows[i].price).length;
  // Lower lows check
  const llCount = recentLows.slice(1).filter((l, i) => l.price < recentLows[i].price).length;
  // Lower highs check
  const lhCount = recentHighs.slice(1).filter((h, i) => h.price < recentHighs[i].price).length;

  const bullStrength = hhCount + hlCount;
  const bearStrength = llCount + lhCount;

  if      (bullStrength === 4) { score = 95; flags.push('perfect_bull_structure'); }
  else if (bullStrength === 3) { score = 80; flags.push('bull_structure'); }
  else if (bullStrength === 2) { score = 65; }
  else if (bearStrength === 4) { score = 10; flags.push('bear_structure'); }
  else if (bearStrength === 3) { score = 25; }
  else if (bearStrength === 2) { score = 38; }
  else                         { score = 50; flags.push('choppy_structure'); }

  return { score, flags };
}

function scoreLiquidity(bars) {
  if (bars.length < 20) return { score: 50, flags: ['insufficient_data'] };

  const { highs, lows } = findSwings(bars, 5);
  const last  = bars.length - 1;
  const price = bars[last].c;
  const flags = [];

  if (!highs.length || !lows.length) return { score: 50, flags: ['no_pivots'] };

  const nearestHigh = [...highs].reverse().find(h => h.index < last - 2);
  const nearestLow  = [...lows].reverse().find(l => l.index < last - 2);

  let score = 50;

  // Rejection wick at prior low (bullish liquidity test)
  if (nearestLow) {
    const distPct = Math.abs(bars[last].l - nearestLow.price) / nearestLow.price;
    const wickPct = (bars[last].h - bars[last].c) / (bars[last].h - bars[last].l + 0.0001);

    if (distPct < 0.01 && price > nearestLow.price) {
      // Price tested the level and closed above
      score = 85;
      flags.push('liquidity_sweep_low');
      // Strong rejection wick (small upper wick = clean hold)
      if (wickPct < 0.3) { score = 92; flags.push('clean_rejection'); }
    } else if (distPct < 0.03) {
      score = 65;
    }
  }

  // Currently sitting above prior high (breakout hold)
  if (nearestHigh && price > nearestHigh.price) {
    const holdDist = (price - nearestHigh.price) / nearestHigh.price;
    if (holdDist < 0.05) { score = Math.max(score, 75); flags.push('breakout_hold'); }
  }

  return { score: Math.min(100, score), flags };
}

function scoreVolatility(bars) {
  if (bars.length < 30) return { score: 50, flags: ['insufficient_data'] };

  const atr  = computeATR(bars, 14);
  const atrPct = atr.map((a, i) => (a && bars[i].c > 0) ? (a / bars[i].c) * 100 : null);
  const pctile = percentileRank(atrPct, Math.min(bars.length, 252));
  const flags  = [];
  let score    = 0;

  // Healthy volatility: 40-85th percentile
  if      (pctile >= 40 && pctile <= 85) { score = 90; flags.push('healthy_volatility'); }
  else if (pctile >= 30 && pctile < 40)  score = 65;
  else if (pctile > 85 && pctile <= 95)  score = 50;
  else if (pctile < 30)                  { score = 30; flags.push('dead_volatility'); }
  else                                   { score = 20; flags.push('extreme_volatility'); }

  return { score, flags };
}

// ── Engine class ──────────────────────────────────────────────────────────────

class LuxAlgoEngine {

  _computeIndicators(bars) {
    if (!bars || bars.length < 15) return null;
    const closes = bars.map(b => b.c);
    return {
      ema20: computeEMA(closes, 20),
      ema50: bars.length >= 50 ? computeEMA(closes, 50) : null,
      atr:   computeATR(bars, 14),
    };
  }

  _scoreTF(bars) {
    if (!bars || bars.length < 15) {
      return {
        score: 50, direction: 'neutral', confidence: 0.3,
        subscores: { trend: 50, momentum: 50, structure: 50, liquidity: 50, volatility: 50 },
        flags: ['insufficient_data'],
      };
    }

    const trend    = scoreTrend(bars);
    const momentum = scoreMomentum(bars);
    const structure = scoreStructure(bars);
    const liquidity = scoreLiquidity(bars);
    const volatility = scoreVolatility(bars);

    // Weighted composite: trend 35, momentum 20, structure 20, liquidity 10, volatility 15
    let composite = (trend.score     * 0.35) + (momentum.score  * 0.20) +
                    (structure.score * 0.20) + (liquidity.score * 0.10) +
                    (volatility.score * 0.15);

    const allFlags = [
      ...trend.flags, ...momentum.flags, ...structure.flags,
      ...liquidity.flags, ...volatility.flags,
    ];

    // Penalty: sub-score < 40 caps composite at 75
    const subScores = [trend.score, momentum.score, structure.score, liquidity.score, volatility.score];
    if (subScores.some(s => s < 40) && composite > 75) {
      composite = 75;
      allFlags.push('subscore_penalty_cap');
    }

    // Direction from SuperTrend
    const { direction: stDir } = computeSuperTrend(bars, 10, 3);
    const lastDir = stDir[bars.length - 1];
    const direction = lastDir === 1 ? 'long' : lastDir === -1 ? 'short' : 'neutral';

    const confidence = Math.min(1, Math.round((bars.length / 252) * 100) / 100);

    return {
      score:     Math.round(composite),
      direction,
      confidence,
      subscores: {
        trend:      trend.score,
        momentum:   momentum.score,
        structure:  structure.score,
        liquidity:  liquidity.score,
        volatility: volatility.score,
      },
      flags: allFlags,
    };
  }

  compute(mtfData) {
    const { ticker, W = [], D = [], H4 = [] } = mtfData;

    const tfW  = this._scoreTF(W);
    const tfD  = this._scoreTF(D);
    const tfH4 = this._scoreTF(H4);

    // MTF composite: Weekly 50%, Daily 35%, 4H 15%
    const composite = (tfW.score * 0.50) + (tfD.score * 0.35) + (tfH4.score * 0.15);

    const votes      = [tfW.direction, tfD.direction, tfH4.direction];
    const longVotes  = votes.filter(d => d === 'long').length;
    const shortVotes = votes.filter(d => d === 'short').length;
    let direction    = 'neutral';
    if (longVotes  >= 2) direction = 'long';
    if (shortVotes >= 2) direction = 'short';

    const confidence = Math.round(
      ((tfW.confidence * 0.50) + (tfD.confidence * 0.35) + (tfH4.confidence * 0.15)) * 100
    ) / 100;

    const allFlags = [...new Set([...tfW.flags, ...tfD.flags, ...tfH4.flags])];

    return {
      engine:           'lux',
      ticker:           ticker || null,
      score:            Math.round(composite),
      subscores:        tfD.subscores,
      direction,
      confidence,
      timeframe_scores: { W: tfW.score, D: tfD.score, H4: tfH4.score },
      flags:            allFlags,
      computed_at:      Date.now(),
    };
  }
}

module.exports = new LuxAlgoEngine();
