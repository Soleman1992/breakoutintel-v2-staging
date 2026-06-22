/**
 * algoAlphaEngine.js — AlgoAlpha Approximation Engine
 *
 * Primary dimension: VOLATILITY EXPANSION + MOMENTUM ACCELERATION (the 2nd derivative).
 * Inefficiency targeted: most tools detect trend; few detect the ACCELERATION of trend —
 * the transition from coiled energy to explosive expansion.
 *
 * Sub-scores (weighted to engine score 0-100):
 *   momentumExpansion  25% — rate-of-change of momentum (2nd derivative of price)
 *   volatilityExpansion 25% — Bollinger/Keltner squeeze → release detection
 *   adaptiveTrend      20% — KAMA (efficiency-ratio-weighted) trend direction
 *   acceleration       20% — slope of slope of KAMA (the key 2nd-derivative edge)
 *   quantStrength      10% — Z-score of expansion metrics vs own history
 *
 * NOTE: This engine fires EARLY. Down-weighted for false-breakout risk unless
 * confirmed by emaVolEngine (handled in consensusEngine, Phase 4).
 * MTF weighting: Weekly 25% / Daily 45% / 4H 30%
 * (4H carries more weight — expansion timing is an intraday-to-swing signal)
 */

'use strict';

const {
  computeEMA, computeROC, computeKAMA,
  computeBollingerBands, computeKeltnerChannels,
  percentileRank, zScore,
} = require('./engineUtils');

// ── Sub-score functions ───────────────────────────────────────────────────────

/**
 * Momentum Expansion Score — rate-of-change of momentum (ROC of ROC).
 * Measures whether momentum is ACCELERATING, not just positive.
 * A stock with positive AND rising momentum = strongest signal.
 */
function scoreMomentumExpansion(bars) {
  if (bars.length < 25) return { score: 50, flags: ['insufficient_data'] };

  const closes  = bars.map(b => b.c);
  const last    = bars.length - 1;
  const roc10   = computeROC(closes, 10);
  const roc21   = computeROC(closes, 21);
  const flags   = [];

  const r10 = roc10[last]  ?? 0;
  const r21 = roc21[last]  ?? 0;

  // 2nd derivative: is ROC itself rising? (compare current ROC to 5 bars ago)
  const r10Prev = roc10[Math.max(0, last - 5)] ?? r10;
  const r21Prev = roc21[Math.max(0, last - 5)] ?? r21;

  const r10Accel = r10 - r10Prev;  // positive = accelerating
  const r21Accel = r21 - r21Prev;

  let score = 0;

  // Level of momentum (40 pts)
  const momLevel = (r10 + r21) / 2;
  if      (momLevel >= 5)  score += 40;
  else if (momLevel >= 2)  score += 28;
  else if (momLevel >= 0)  score += 15;
  else if (momLevel >= -2) score += 5;

  // Acceleration (40 pts) — this is the key differentiator
  const accelAvg = (r10Accel + r21Accel) / 2;
  if      (accelAvg >= 2)  { score += 40; flags.push('momentum_accelerating'); }
  else if (accelAvg >= 0.5) score += 25;
  else if (accelAvg >= 0)   score += 12;
  else                       flags.push('momentum_decelerating');

  // Both timeframes aligned (20 pts)
  if (r10 > 0 && r21 > 0 && r10Accel > 0 && r21Accel > 0) {
    score += 20;
    flags.push('dual_tf_momentum_expansion');
  } else if (r10 > 0 && r21 > 0) {
    score += 10;
  }

  return { score: Math.min(100, Math.round(score)), flags };
}

/**
 * Volatility Expansion Score — squeeze detection and release.
 * Squeeze = Bollinger Bands inside Keltner Channels (compression).
 * Release = Bollinger Bands expand outside Keltner Channels (expansion).
 * A squeeze followed by expansion is the highest-probability AlgoAlpha signal.
 */
function scoreVolatilityExpansion(bars) {
  if (bars.length < 25) return { score: 50, flags: ['insufficient_data'] };

  const closes  = bars.map(b => b.c);
  const bb      = computeBollingerBands(closes, 20, 2);
  const kc      = computeKeltnerChannels(bars, 20, 10, 1.5);
  const last    = bars.length - 1;
  const flags   = [];

  // Current squeeze state
  const bbUpper = bb.upper[last];
  const bbLower = bb.lower[last];
  const kcUpper = kc.upper[last];
  const kcLower = kc.lower[last];

  if (!bbUpper || !kcUpper) return { score: 50, flags: ['indicator_unavailable'] };

  const inSqueeze = bbUpper <= kcUpper && bbLower >= kcLower;

  // Look back to find if we just EXITED a squeeze (the fire signal)
  let squeezeDuration = 0;
  let justFired       = false;

  for (let i = last - 1; i >= Math.max(0, last - 20); i--) {
    const bbU = bb.upper[i], bbL = bb.lower[i];
    const kcU = kc.upper[i], kcL = kc.lower[i];
    if (!bbU || !kcU) break;
    const wasSqueezing = bbU <= kcU && bbL >= kcL;
    if (wasSqueezing) squeezeDuration++;
    else break;
  }

  if (!inSqueeze && squeezeDuration >= 3) {
    justFired = true;
    flags.push('squeeze_fire');
  }

  // BB width percentile (how expanded is volatility vs history?)
  const bbWidthArr = bb.width.filter(w => w != null);
  const bbPctile   = percentileRank(bbWidthArr, Math.min(bbWidthArr.length, 252));

  let score = 0;

  // Squeeze fire is the top signal (50 pts)
  if (justFired) {
    score += squeezeDuration >= 8 ? 50 : squeezeDuration >= 5 ? 38 : 28;
    flags.push(`squeeze_duration_${squeezeDuration}bars`);
  } else if (inSqueeze) {
    // Currently in squeeze — energy building
    score += squeezeDuration >= 8 ? 25 : squeezeDuration >= 4 ? 18 : 10;
    flags.push('in_squeeze');
  } else {
    score += 15; // post-expansion or normal regime
  }

  // BB width percentile (35 pts) — expanding from low base = ideal
  if      (bbPctile >= 60 && !inSqueeze) score += 35; // expanding
  else if (bbPctile >= 40)               score += 22;
  else if (bbPctile >= 20)               score += 12; // quiet
  else                                   score += 5;  // dead

  // Direction of expansion (15 pts): price above or below mid-band?
  const bbMid = bb.basis[last];
  if (bbMid) {
    const price = bars[last].c;
    if (!inSqueeze && price > bbMid) { score += 15; flags.push('expanding_bullish'); }
    else if (!inSqueeze && price < bbMid) score += 0;
    else score += 8;
  }

  return { score: Math.min(100, Math.round(score)), flags };
}

/**
 * Adaptive Trend Score — Kaufman Adaptive Moving Average (KAMA) trend direction.
 * KAMA adapts its speed to noise: fast in trending, slow in choppy markets.
 * Clean KAMA slope = genuine trend, not noise.
 */
function scoreAdaptiveTrend(bars) {
  if (bars.length < 20) return { score: 50, flags: ['insufficient_data'] };

  const closes = bars.map(b => b.c);
  const kama   = computeKAMA(closes, 10, 2, 30);
  const last   = bars.length - 1;
  const flags  = [];

  const kamaVal = kama[last];
  if (!kamaVal) return { score: 50, flags: ['kama_unavailable'] };

  const price  = closes[last];
  const lb5    = Math.max(0, last - 5);
  const lb20   = Math.max(0, last - 20);

  const kamaSlope5  = (kama[last] - (kama[lb5]  ?? kama[last])) / (kama[lb5]  ?? kama[last]);
  const kamaSlope20 = (kama[last] - (kama[lb20] ?? kama[last])) / (kama[lb20] ?? kama[last]);

  let score = 0;

  // Price vs KAMA (40 pts)
  if      (price > kamaVal * 1.02) { score += 40; flags.push('price_above_kama'); }
  else if (price > kamaVal)         score += 28;
  else if (price > kamaVal * 0.99)  score += 15;
  else                              score += 2;

  // KAMA slope — 5-bar (35 pts)
  if      (kamaSlope5 >= 0.02)  { score += 35; flags.push('kama_steep_upslope'); }
  else if (kamaSlope5 >= 0.005)  score += 22;
  else if (kamaSlope5 >= 0)      score += 12;
  else                           score += 2;

  // KAMA slope — 20-bar (25 pts): confirms sustained trend vs short spike
  if      (kamaSlope20 >= 0.03)  score += 25;
  else if (kamaSlope20 >= 0.01)  score += 16;
  else if (kamaSlope20 >= 0)     score += 8;

  return { score: Math.min(100, Math.round(score)), flags };
}

/**
 * Acceleration Score — slope of slope of KAMA (the true 2nd derivative).
 * Detects the transition from stable trend to explosive expansion.
 */
function scoreAcceleration(bars) {
  if (bars.length < 25) return { score: 50, flags: ['insufficient_data'] };

  const closes = bars.map(b => b.c);
  const kama   = computeKAMA(closes, 10, 2, 30);
  const last   = bars.length - 1;
  const flags  = [];

  // KAMA velocity array (1st derivative): rate of KAMA change per bar
  const kamaVelocity = kama.map((k, i) => {
    if (i === 0 || !k || !kama[i-1]) return null;
    return k - kama[i-1];
  });

  // KAMA acceleration (2nd derivative): rate of velocity change
  const kamaAccel = kamaVelocity.map((v, i) => {
    if (i === 0 || v == null || kamaVelocity[i-1] == null) return null;
    return v - kamaVelocity[i-1];
  });

  const lastAccel  = kamaAccel[last] ?? 0;
  const accel5avg  = kamaAccel.slice(Math.max(0, last - 5))
                              .filter(a => a != null)
                              .reduce((s, a, _, arr) => s + a / arr.length, 0);

  let score = 50;

  if      (accel5avg > 0.05)  { score = 92; flags.push('strong_kama_acceleration'); }
  else if (accel5avg > 0.02)  { score = 78; flags.push('kama_accelerating'); }
  else if (accel5avg > 0)     score = 62;
  else if (accel5avg > -0.02) score = 45;
  else                        { score = 22; flags.push('kama_decelerating'); }

  // Single-bar confirmation
  if (lastAccel > 0 && accel5avg > 0) { score = Math.min(100, score + 8); }

  return { score, flags };
}

/**
 * Quant Strength Score — Z-score of expansion metrics vs own rolling history.
 * Normalises the combined ROC + BB-width expansion to detect statistically
 * significant moves vs the stock's own behaviour.
 */
function scoreQuantStrength(bars) {
  if (bars.length < 30) return { score: 50, flags: ['insufficient_data'] };

  const closes = bars.map(b => b.c);
  const roc10  = computeROC(closes, 10);
  const bb     = computesBollingerWidth(closes);
  const last   = bars.length - 1;
  const flags  = [];

  // Combined signal: ROC + BB width
  const combined = roc10.map((r, i) => {
    if (r == null || bb[i] == null) return null;
    return r + bb[i] * 10; // scale BB width to similar magnitude as ROC
  });

  const z = zScore(combined.filter(v => v != null), 50);

  let score = 50;
  if      (z >= 2.0)  { score = 95; flags.push('statistically_extreme_expansion'); }
  else if (z >= 1.0)  { score = 78; flags.push('above_normal_expansion'); }
  else if (z >= 0)    score = 58;
  else if (z >= -1.0) score = 38;
  else                score = 20;

  return { score, flags };
}

// Helper: BB width array for quantStrength
function computesBollingerWidth(closes) {
  const bb = computeBollingerBands(closes, 20, 2);
  return bb.width;
}

// ── Engine class ──────────────────────────────────────────────────────────────

class AlgoAlphaEngine {

  _scoreTF(bars) {
    if (!bars || bars.length < 25) {
      return {
        score: 50, direction: 'neutral', confidence: 0.3,
        subscores: {
          momentumExpansion: 50, volatilityExpansion: 50, adaptiveTrend: 50,
          acceleration: 50,      quantStrength: 50,
        },
        flags: ['insufficient_data'],
      };
    }

    const momExp  = scoreMomentumExpansion(bars);
    const volExp  = scoreVolatilityExpansion(bars);
    const atrTrnd = scoreAdaptiveTrend(bars);
    const accel   = scoreAcceleration(bars);
    const quant   = scoreQuantStrength(bars);

    // Weighted: momExp 25, volExp 25, atrTrnd 20, accel 20, quant 10
    const composite = (momExp.score  * 0.25) + (volExp.score  * 0.25) +
                      (atrTrnd.score * 0.20) + (accel.score   * 0.20) +
                      (quant.score   * 0.10);

    // Direction from adaptive trend + momentum
    const closes = bars.map(b => b.c);
    const kama   = computeKAMA(closes, 10, 2, 30);
    const last   = bars.length - 1;
    const kamaV  = kama[last];
    const price  = bars[last].c;
    const roc    = computeROC(closes, 10);
    const rocV   = roc[last] ?? 0;

    let direction = 'neutral';
    if (kamaV && price > kamaV && rocV > 0)  direction = 'long';
    if (kamaV && price < kamaV && rocV < 0)  direction = 'short';

    const confidence = Math.min(1, Math.round((bars.length / 252) * 100) / 100);

    const allFlags = [
      ...momExp.flags, ...volExp.flags, ...atrTrnd.flags,
      ...accel.flags,  ...quant.flags,
    ];

    return {
      score: Math.round(composite),
      direction,
      confidence,
      subscores: {
        momentumExpansion:  momExp.score,
        volatilityExpansion: volExp.score,
        adaptiveTrend:      atrTrnd.score,
        acceleration:       accel.score,
        quantStrength:      quant.score,
      },
      flags: allFlags,
    };
  }

  compute(mtfData) {
    const { ticker, W = [], D = [], H4 = [] } = mtfData;

    const tfW  = this._scoreTF(W);
    const tfD  = this._scoreTF(D);
    const tfH4 = this._scoreTF(H4);

    // MTF composite: Weekly 25%, Daily 45%, 4H 30%
    // 4H carries more weight — expansion is a timing engine
    const composite = (tfW.score * 0.25) + (tfD.score * 0.45) + (tfH4.score * 0.30);

    const votes      = [tfW.direction, tfD.direction, tfH4.direction];
    const longVotes  = votes.filter(d => d === 'long').length;
    const shortVotes = votes.filter(d => d === 'short').length;
    let direction    = 'neutral';
    if (longVotes  >= 2) direction = 'long';
    if (shortVotes >= 2) direction = 'short';

    const confidence = Math.round(
      ((tfW.confidence * 0.25) + (tfD.confidence * 0.45) + (tfH4.confidence * 0.30)) * 100
    ) / 100;

    const allFlags = [...new Set([...tfW.flags, ...tfD.flags, ...tfH4.flags])];

    return {
      engine:  'algoalpha',
      ticker:  ticker || null,
      score:   Math.round(composite),
      subscores: tfD.subscores,
      direction,
      confidence,
      timeframe_scores: { W: tfW.score, D: tfD.score, H4: tfH4.score },
      flags:            allFlags,
      computed_at:      Date.now(),
    };
  }
}

module.exports = new AlgoAlphaEngine();
