/**
 * chartPrimeEngine.js — ChartPrime Approximation Engine
 *
 * Primary dimension: MARKET STRUCTURE / institutional footprint (SMC concepts).
 * Inefficiency targeted: predictable liquidity pools (stops above highs / below lows)
 * that large players sweep before moving.
 *
 * Sub-scores (weighted to engine score 0-100):
 *   liquiditySweep      20% — stop-hunt detection (wick beyond swing, close back inside)
 *   orderBlock          20% — last opposing candle before impulsive move
 *   marketStructure     20% — HH/HL (bullish) vs LL/LH (bearish) sequence
 *   bos                 20% — Break of Structure with displacement candle
 *   fvg                 10% — Fair Value Gap (3-candle imbalance)
 *   institutionalPrint  10% — volume clustering at key levels
 *
 * Note: This is the lowest-correlation, highest-edge engine — weight it carefully.
 * MTF weighting: Weekly 30% / Daily 45% / 4H 25%
 * (Daily/4H carry more weight: structure forms on these timeframes)
 */

'use strict';

const { computeATR, findSwings } = require('./engineUtils');

// ── Sub-score functions ───────────────────────────────────────────────────────

/**
 * Liquidity Sweep Score — detects stop-hunt wicks.
 * Pattern: price spikes beyond a prior swing high/low, then closes back inside.
 * A bullish sweep (below swing low then close above) = accumulation signal.
 */
function scoreLiquiditySweep(bars) {
  if (bars.length < 15) return { score: 50, flags: ['insufficient_data'] };

  const { highs, lows } = findSwings(bars, 3);
  const last   = bars.length - 1;
  const recent = bars.slice(Math.max(0, last - 10));
  const flags  = [];
  let score    = 50;

  for (let i = 1; i < recent.length; i++) {
    const bar = recent[i];

    // Bullish sweep: wick below recent swing low, closed above it
    const nearLow = lows.find(l => l.index < last - 10 + i && Math.abs(bar.l - l.price) / l.price < 0.005);
    if (nearLow && bar.l < nearLow.price && bar.c > nearLow.price) {
      const wickRatio = (bar.c - bar.l) / (bar.h - bar.l + 0.0001);
      score = wickRatio > 0.6 ? 92 : 80;
      flags.push('bullish_liquidity_sweep');
      break;
    }

    // Bearish sweep: wick above recent swing high, closed below it (bearish)
    const nearHigh = highs.find(h => h.index < last - 10 + i && Math.abs(bar.h - h.price) / h.price < 0.005);
    if (nearHigh && bar.h > nearHigh.price && bar.c < nearHigh.price) {
      score = 20;
      flags.push('bearish_liquidity_sweep');
      break;
    }
  }

  // No recent sweep: neutral but check proximity to liquidity pools
  if (score === 50 && lows.length > 0) {
    const lastLow = lows[lows.length - 1];
    const price   = bars[last].c;
    const dist    = (price - lastLow.price) / lastLow.price;
    if (dist > 0.02 && dist < 0.08) { score = 62; } // sitting above swept low
  }

  return { score, flags };
}

/**
 * Order Block Score — identifies the last opposing candle before a strong impulse.
 * Bullish OB: last bearish candle before a strong bullish impulse.
 * Price returning to and holding the OB zone = high-probability long.
 */
function scoreOrderBlock(bars) {
  if (bars.length < 10) return { score: 50, flags: ['insufficient_data'] };

  const last  = bars.length - 1;
  const price = bars[last].c;
  const atr   = computeATR(bars, 14);
  const flags = [];

  // Find the most recent strong bullish impulse (body > 1.5× ATR)
  let obZoneHigh = null, obZoneLow = null, obType = null;

  for (let i = last - 1; i >= Math.max(1, last - 30); i--) {
    const body = Math.abs(bars[i].c - bars[i].o);
    if (!atr[i] || body < atr[i] * 1.5) continue;

    const isBullImpulse = bars[i].c > bars[i].o;

    if (isBullImpulse) {
      // Look for the last bearish candle before this impulse (= bullish OB)
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        if (bars[j].c < bars[j].o) {
          obZoneHigh = bars[j].h;
          obZoneLow  = bars[j].l;
          obType     = 'bullish';
          break;
        }
      }
      if (obType) break;
    }
  }

  if (!obType) return { score: 50, flags: ['no_order_block'] };

  if (obType === 'bullish' && obZoneHigh && obZoneLow) {
    // Price currently inside or just above the OB zone
    if (price >= obZoneLow && price <= obZoneHigh) {
      flags.push('price_in_order_block');
      return { score: 88, flags };
    }
    if (price > obZoneHigh) {
      const distPct = (price - obZoneHigh) / obZoneHigh;
      if (distPct < 0.03) { flags.push('holding_above_ob'); return { score: 72, flags }; }
      if (distPct < 0.08) return { score: 60, flags };
    }
    if (price < obZoneLow) {
      flags.push('ob_invalidated');
      return { score: 22, flags };
    }
  }

  return { score: 50, flags };
}

/**
 * Market Structure Score — HH/HL (bullish) vs LL/LH (bearish) sequence.
 * Based on the last 4 significant swing pivots.
 */
function scoreMarketStructure(bars) {
  if (bars.length < 20) return { score: 50, flags: ['insufficient_data'] };

  const { highs, lows } = findSwings(bars, 4);
  const flags = [];

  if (highs.length < 2 || lows.length < 2) {
    return { score: 50, flags: ['insufficient_pivots'] };
  }

  const recentHighs = highs.slice(-3);
  const recentLows  = lows.slice(-3);

  const hh = recentHighs.slice(1).filter((h, i) => h.price > recentHighs[i].price).length;
  const hl = recentLows.slice(1).filter((l, i)  => l.price > recentLows[i].price).length;
  const ll = recentLows.slice(1).filter((l, i)  => l.price < recentLows[i].price).length;
  const lh = recentHighs.slice(1).filter((h, i) => h.price < recentHighs[i].price).length;

  const bull = hh + hl;
  const bear = ll + lh;

  if      (bull >= 4) { flags.push('strong_bull_market_structure'); return { score: 95, flags }; }
  else if (bull === 3) { flags.push('bull_market_structure');        return { score: 78, flags }; }
  else if (bull === 2)                                                return { score: 62, flags: [] };
  else if (bear >= 4) { flags.push('strong_bear_market_structure'); return { score: 8,  flags }; }
  else if (bear === 3) { flags.push('bear_market_structure');        return { score: 24, flags }; }
  else if (bear === 2)                                                return { score: 38, flags: [] };

  return { score: 50, flags: ['mixed_structure'] };
}

/**
 * Break of Structure (BOS) Score — confirmed break of most recent swing point
 * with a displacement candle (large body indicating institutional intent).
 */
function scoreBOS(bars) {
  if (bars.length < 15) return { score: 50, flags: ['insufficient_data'] };

  const { highs, lows } = findSwings(bars, 4);
  const last  = bars.length - 1;
  const price = bars[last].c;
  const atr   = computeATR(bars, 14);
  const flags = [];

  if (!highs.length || !lows.length) return { score: 50, flags: ['no_pivots'] };

  const lastSwingHigh = [...highs].reverse().find(h => h.index < last - 3);
  const lastSwingLow  = [...lows].reverse().find(l => l.index < last - 3);

  let score = 50;

  // Bullish BOS: price closes above last swing high
  if (lastSwingHigh && price > lastSwingHigh.price) {
    flags.push('bullish_bos');
    score = 72;

    // Check displacement: was there a large candle on the break bar?
    for (let i = Math.max(0, last - 5); i <= last; i++) {
      const body     = bars[i].c - bars[i].o;
      const isDisp   = atr[i] && body > atr[i] * 1.2 && bars[i].c > bars[i].o;
      if (isDisp) {
        flags.push('displacement_candle');
        score = 90;
        break;
      }
    }

    // BOS must hold: price should still be above the broken swing high
    if (price > lastSwingHigh.price * 1.005) score = Math.min(score + 5, 95);
  }
  // Bearish BOS: price closes below last swing low
  else if (lastSwingLow && price < lastSwingLow.price) {
    flags.push('bearish_bos');
    score = 15;
  }
  // Near-BOS: within 1% of swing high (potential imminent break)
  else if (lastSwingHigh) {
    const distPct = (lastSwingHigh.price - price) / lastSwingHigh.price;
    if (distPct < 0.01)      { flags.push('approaching_swing_high'); score = 62; }
    else if (distPct < 0.03) score = 55;
  }

  return { score: Math.min(100, score), flags };
}

/**
 * Fair Value Gap (FVG) Score — 3-candle imbalance indicating institutional intent.
 * Bullish FVG: bar[i-2].h < bar[i].l (gap between two candles, middle bar drives through).
 * Bearish FVG: bar[i-2].l > bar[i].h.
 */
function scoreFVG(bars) {
  if (bars.length < 10) return { score: 50, flags: ['insufficient_data'] };

  const last  = bars.length - 1;
  const price = bars[last].c;
  const flags = [];
  let score   = 50;

  // Scan last 20 bars for recent FVGs
  for (let i = last - 2; i >= Math.max(2, last - 20); i--) {
    const prev2 = bars[i - 2];
    const curr  = bars[i];

    // Bullish FVG
    if (prev2.h < curr.l) {
      const fvgTop    = curr.l;
      const fvgBottom = prev2.h;
      flags.push('bullish_fvg_present');

      // Is price above the FVG (respecting it)?
      if (price >= fvgBottom && price <= fvgTop) {
        score = 82;
        flags.push('price_in_fvg_support');
      } else if (price > fvgTop) {
        const dist = (price - fvgTop) / fvgTop;
        score = dist < 0.05 ? 70 : 58;
      }
      break;
    }

    // Bearish FVG
    if (prev2.l > curr.h) {
      flags.push('bearish_fvg');
      score = price < prev2.l ? 22 : 40;
      break;
    }
  }

  return { score, flags };
}

/**
 * Institutional Footprint Score — volume clustering at key levels as a proxy
 * for large-player activity (order flow imbalance).
 */
function scoreInstitutionalPrint(bars) {
  if (bars.length < 20) return { score: 50, flags: ['insufficient_data'] };

  const last   = bars.length - 1;
  const price  = bars[last].c;
  const atr    = computeATR(bars, 14);
  const flags  = [];

  // High-volume bars near current price (within 2 ATR) = institutional interest
  const atrVal = atr[last] || 1;
  const volBars = bars.slice(Math.max(0, last - 30), last).filter(b => {
    const nearPrice = Math.abs(b.c - price) < atrVal * 2;
    return nearPrice;
  });

  if (!volBars.length) return { score: 50, flags: [] };

  const avgVol   = bars.slice(Math.max(0, last - 30), last)
                       .reduce((s, b) => s + b.v, 0) / 30;
  const highVolNear = volBars.filter(b => b.v > avgVol * 1.5);

  let score = 50;
  if      (highVolNear.length >= 4) { score = 85; flags.push('strong_institutional_volume'); }
  else if (highVolNear.length >= 2) score = 68;
  else if (highVolNear.length === 1) score = 58;

  // Up-close high-volume bars near price = accumulation
  const upCloseHVol = highVolNear.filter(b => b.c > b.o);
  if (upCloseHVol.length > highVolNear.length * 0.6) {
    flags.push('accumulation_footprint');
    score = Math.min(100, score + 10);
  }

  return { score, flags };
}

// ── Engine class ──────────────────────────────────────────────────────────────

class ChartPrimeEngine {

  _scoreTF(bars) {
    if (!bars || bars.length < 15) {
      return {
        score: 50, direction: 'neutral', confidence: 0.3,
        subscores: {
          liquiditySweep: 50, orderBlock: 50, marketStructure: 50,
          bos: 50, fvg: 50, institutionalPrint: 50,
        },
        flags: ['insufficient_data'],
      };
    }

    const sweep  = scoreLiquiditySweep(bars);
    const ob     = scoreOrderBlock(bars);
    const ms     = scoreMarketStructure(bars);
    const bos    = scoreBOS(bars);
    const fvg    = scoreFVG(bars);
    const inst   = scoreInstitutionalPrint(bars);

    // Weighted: sweep 20, ob 20, ms 20, bos 20, fvg 10, inst 10
    const composite = (sweep.score * 0.20) + (ob.score * 0.20) +
                      (ms.score    * 0.20) + (bos.score * 0.20) +
                      (fvg.score   * 0.10) + (inst.score * 0.10);

    // Direction from Market Structure + BOS (most reliable SMC signals)
    const msScore  = ms.score;
    const bosScore = bos.score;
    let direction  = 'neutral';
    const bullSig  = msScore > 65 || bosScore > 70 || bos.flags.includes('bullish_bos');
    const bearSig  = msScore < 35 || bosScore < 30 || bos.flags.includes('bearish_bos');
    if (bullSig && !bearSig) direction = 'long';
    if (bearSig && !bullSig) direction = 'short';

    const confidence = Math.min(1, Math.round((bars.length / 252) * 100) / 100);

    const allFlags = [
      ...sweep.flags, ...ob.flags, ...ms.flags,
      ...bos.flags,   ...fvg.flags, ...inst.flags,
    ];

    return {
      score: Math.round(composite),
      direction,
      confidence,
      subscores: {
        liquiditySweep:    sweep.score,
        orderBlock:        ob.score,
        marketStructure:   ms.score,
        bos:               bos.score,
        fvg:               fvg.score,
        institutionalPrint: inst.score,
      },
      flags: allFlags,
    };
  }

  compute(mtfData) {
    const { ticker, W = [], D = [], H4 = [] } = mtfData;

    const tfW  = this._scoreTF(W);
    const tfD  = this._scoreTF(D);
    const tfH4 = this._scoreTF(H4);

    // MTF composite: Weekly 30%, Daily 45%, 4H 25%
    // Structure primarily forms on Daily + 4H; Weekly provides bias confirmation
    const composite = (tfW.score * 0.30) + (tfD.score * 0.45) + (tfH4.score * 0.25);

    const votes      = [tfW.direction, tfD.direction, tfH4.direction];
    const longVotes  = votes.filter(d => d === 'long').length;
    const shortVotes = votes.filter(d => d === 'short').length;
    let direction    = 'neutral';
    if (longVotes  >= 2) direction = 'long';
    if (shortVotes >= 2) direction = 'short';

    const confidence = Math.round(
      ((tfW.confidence * 0.30) + (tfD.confidence * 0.45) + (tfH4.confidence * 0.25)) * 100
    ) / 100;

    const allFlags = [...new Set([...tfW.flags, ...tfD.flags, ...tfH4.flags])];

    return {
      engine:  'chartprime',
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

module.exports = new ChartPrimeEngine();
