/**
 * consensusEngine.js — Phase 4: The Consensus Layer
 *
 * Takes 5 engine results and produces a single defensible ranking record.
 *
 * Pipeline (in order):
 *   1. Direction gate     — need ≥3/5 engines aligned; fail = REJECT
 *   2. Confidence weight  — effective_score = engine.score × engine.confidence
 *   3. Decorrelation      — shrink lux+emavol combined weight when scores converge
 *   4. Consensus score    — weighted blend of effective scores (0-100)
 *   5. Six metrics        — agreement%, confidence, inst.prob, trend-cont, breakout, FB-risk
 *   6. Tier assignment    — S/A/B/C/REJECT with hard gates (score + agreement + FB-risk)
 *   7. Quality dims       — pre-computed sort columns for the UI ranking table
 *   8. Explainability     — human-auditable rationale from flags + subscores
 *
 * Design rule: every output value traces to a specific numeric input.
 * No qualitative fluff; no randomness; deterministic given same inputs.
 */

'use strict';

// ── Engine weights (theory-based priors, before decorrelation) ────────────────
// ChartPrime weighted highest: lowest correlation to other engines, highest edge.
// AlgoAlpha weighted slightly lower: fires early, false-positive prone.
const BASE_WEIGHTS = {
  emavol:      0.20,
  lux:         0.20,
  trendspider: 0.20,
  chartprime:  0.22,
  algoalpha:   0.18,
};

// Decorrelation pairs: [engineA, engineB, shrinkageFactor]
// Applied when the pair scores within DECORR_THRESHOLD of each other
// (similar scores = likely measuring the same thing = double-counting)
const DECORR_PAIRS      = [['lux', 'emavol', 0.14]];
const DECORR_THRESHOLD  = 15;  // score diff below this = apply shrinkage

// ── Tier gates — ALL conditions must pass ─────────────────────────────────────
const TIER_GATES = {
  S: { minScore: 95, minAgreement: 4, maxFBRisk: 20, minConfidence: 0.75 },
  A: { minScore: 90, minAgreement: 4, maxFBRisk: 30, minConfidence: 0.65 },
  B: { minScore: 80, minAgreement: 3, maxFBRisk: 45, minConfidence: 0.00 },
  C: { minScore: 70, minAgreement: 3, maxFBRisk: 100, minConfidence: 0.00 },
};

// ── Helper ────────────────────────────────────────────────────────────────────

function byId(results) {
  return results.reduce((acc, e) => { acc[e.engine] = e; return acc; }, {});
}

// ── Consensus Engine class ────────────────────────────────────────────────────

class ConsensusEngine {

  /**
   * Main entry point.
   * @param {Array}  engineResults — array of 5 engine output objects
   * @param {Object} opts          — { ticker, mtfData }
   * @returns {Object} full consensus record
   */
  run(engineResults, opts = {}) {
    const { ticker = null } = opts;

    // ── Validate inputs ──────────────────────────────────────────────────────
    if (!Array.isArray(engineResults) || engineResults.length !== 5) {
      return this._fail('invalid_engine_count',
        `Expected 5 engine results, got ${engineResults?.length ?? 0}.`);
    }

    // ── Step 1: Direction gate ───────────────────────────────────────────────
    const longVotes  = engineResults.filter(e => e.direction === 'long').length;
    const shortVotes = engineResults.filter(e => e.direction === 'short').length;
    const dominant   = longVotes >= 3 ? 'long' : shortVotes >= 3 ? 'short' : null;

    if (!dominant) {
      const best = Math.max(longVotes, shortVotes);
      return this._fail('direction_gate',
        `Only ${best}/5 engines agree on direction (need ≥3). Votes — long: ${longVotes}, short: ${shortVotes}.`);
    }

    const agreementCount = dominant === 'long' ? longVotes : shortVotes;

    // ── Step 2: Confidence-weighted effective scores ─────────────────────────
    const weighted = engineResults.map(e => ({
      ...e,
      effectiveScore: Math.round(e.score * Math.min(1, Math.max(0, e.confidence))),
    }));

    // ── Step 3: Decorrelation shrinkage ──────────────────────────────────────
    const weights = this._applyDecorrelation({ ...BASE_WEIGHTS }, weighted);

    // ── Step 4: Consensus score ──────────────────────────────────────────────
    const consensusScore = this._computeConsensusScore(weighted, weights, dominant);

    // ── Step 5: Six probability metrics ─────────────────────────────────────
    const metrics = this._computeMetrics(engineResults, dominant, agreementCount, weights);

    // ── Step 6: Tier assignment ──────────────────────────────────────────────
    const tier = this._assignTier(consensusScore, agreementCount, metrics);

    // ── Step 7: Quality dimension scores (UI sort columns) ───────────────────
    const qualityDims = this._computeQualityDims(engineResults);

    // ── Step 8: Explainability ───────────────────────────────────────────────
    const explain = this._buildExplain(engineResults, dominant, metrics, tier, ticker);

    return {
      ok:            true,
      rejected:      false,
      ticker,
      consensusScore,
      tier,
      direction:     dominant,

      // Agreement
      agreementCount,
      agreementPct:  Math.round((agreementCount / 5) * 100),

      // Engine breakdown (for UI drill-down)
      engines: engineResults.reduce((acc, e) => {
        acc[e.engine] = {
          score:     e.score,
          direction: e.direction,
          confidence: e.confidence,
          subscores: e.subscores,
          flags:     e.flags,
          timeframe_scores: e.timeframe_scores,
        };
        return acc;
      }, {}),

      // Six probability metrics
      confidenceScore:         metrics.confidenceScore,
      institutionalProb:       metrics.institutionalProb,
      trendContinuationProb:   metrics.trendContinuationProb,
      breakoutProb:            metrics.breakoutProb,
      falseBORisk:             metrics.falseBORisk,

      // Quality dims
      qualityDims,

      // Explainability
      explain,

      // Audit trail
      weightsUsed:  weights,
      computedAt:   Date.now(),
    };
  }

  // ── Step 3 helper: decorrelation ─────────────────────────────────────────────

  _applyDecorrelation(weights, weighted) {
    for (const [eA, eB, shrink] of DECORR_PAIRS) {
      const a = weighted.find(e => e.engine === eA);
      const b = weighted.find(e => e.engine === eB);
      if (!a || !b) continue;

      if (Math.abs(a.score - b.score) < DECORR_THRESHOLD) {
        // They're measuring the same thing — split the shrinkage, redistribute
        const half = shrink / 2;
        weights[eA]          = Math.max(0.06, weights[eA]          - half);
        weights[eB]          = Math.max(0.06, weights[eB]          - half);
        weights['chartprime']  = Math.min(0.35, weights['chartprime']  + shrink * 0.55);
        weights['algoalpha']   = Math.min(0.28, weights['algoalpha']   + shrink * 0.45);
      }
    }

    // Normalise to sum = 1
    const total = Object.values(weights).reduce((s, w) => s + w, 0);
    Object.keys(weights).forEach(k => { weights[k] = Math.round((weights[k] / total) * 1000) / 1000; });

    return weights;
  }

  // ── Step 4 helper: consensus score ───────────────────────────────────────────

  _computeConsensusScore(weighted, weights, dominant) {
    let score = 0;
    let totalW = 0;

    for (const e of weighted) {
      const w = weights[e.engine] ?? 0.20;
      // Engines opposing the dominant direction contribute a penalty (flipped score)
      const contribution = (e.direction === dominant || e.direction === 'neutral')
        ? e.effectiveScore
        : 100 - e.effectiveScore;
      score  += contribution * w;
      totalW += w;
    }

    return Math.max(0, Math.min(100, Math.round(totalW > 0 ? score / totalW : score)));
  }

  // ── Step 5 helper: six probability metrics ────────────────────────────────────

  _computeMetrics(results, dominant, agreementCount, weights) {
    const eng = byId(results);
    const em  = eng['emavol'];
    const lux = eng['lux'];
    const ts  = eng['trendspider'];
    const cp  = eng['chartprime'];
    const aa  = eng['algoalpha'];

    // ── 1. Confidence Score (weighted avg of engine confidences × 100) ───────
    let confNum = 0, confDen = 0;
    for (const e of results) {
      const w = weights[e.engine] ?? 0.20;
      confNum += e.confidence * w;
      confDen += w;
    }
    const confidenceScore = Math.round((confDen > 0 ? confNum / confDen : 0.5) * 100);

    // ── 2. Institutional Probability ──────────────────────────────────────────
    // ChartPrime OB + sweep + print, weighted by EMA volume
    const instProb = Math.round(
      ((cp?.subscores?.orderBlock         ?? 50) * 0.30) +
      ((cp?.subscores?.liquiditySweep     ?? 50) * 0.25) +
      ((cp?.subscores?.institutionalPrint ?? 50) * 0.20) +
      ((em?.subscores?.volume             ?? 50) * 0.25)
    );

    // ── 3. Trend Continuation Probability ─────────────────────────────────────
    // LuxAlgo trend persistence + EMA trend quality + TrendSpider alignment + MTF
    const trendContinuationProb = Math.round(
      ((lux?.subscores?.trend         ?? 50) * 0.35) +
      ((em?.subscores?.trendQuality   ?? 50) * 0.30) +
      ((ts?.subscores?.trendAlignment ?? 50) * 0.20) +
      ((ts?.subscores?.mtfScore       ?? 50) * 0.15)
    );

    // ── 4. Breakout Probability ───────────────────────────────────────────────
    // TrendSpider breakout quality + AlgoAlpha squeeze-fire + EMA breakout
    const breakoutProb = Math.round(
      ((ts?.subscores?.breakoutQuality      ?? 50) * 0.40) +
      ((aa?.subscores?.volatilityExpansion  ?? 50) * 0.35) +
      ((em?.subscores?.breakout             ?? 50) * 0.25)
    );

    // ── 5. False Breakout Risk (inverse — higher = more dangerous) ────────────
    const allFlags     = results.flatMap(e => e.flags ?? []);
    const volumeFail   = allFlags.includes('volume_fail') ||
                         allFlags.includes('breakout_volume_fail') ||
                         allFlags.includes('score_capped_volume_fail');
    const squeezeFired = allFlags.includes('squeeze_fire');
    const emConfirms   = (em?.subscores?.volume ?? 0) >= 60 &&
                         (em?.subscores?.trendQuality ?? 0) >= 55;
    const deadVol      = allFlags.includes('dead_volatility');
    const weeklyConflict = allFlags.includes('weekly_daily_conflict');
    const bosConfirmed = allFlags.includes('bullish_bos') || allFlags.includes('displacement_candle');

    let fbRisk = 35; // baseline risk

    // Risk factors (add)
    if (volumeFail)             fbRisk += 22;
    if (deadVol)                fbRisk += 18;
    if (squeezeFired && !emConfirms) fbRisk += 14;
    if (weeklyConflict)         fbRisk += 12;
    if (agreementCount === 3)   fbRisk += 10; // only 3/5 agree — marginal
    if ((lux?.subscores?.volatility ?? 50) > 85) fbRisk += 8; // extreme vol = chasing

    // Risk reducers (subtract)
    if (bosConfirmed)           fbRisk -= 18;
    if (emConfirms)             fbRisk -= 12;
    if (agreementCount === 5)   fbRisk -= 14;
    if ((cp?.subscores?.bos ?? 0) >= 80) fbRisk -= 8;

    const falseBORisk = Math.max(0, Math.min(100, Math.round(fbRisk)));

    return {
      confidenceScore,
      institutionalProb:     instProb,
      trendContinuationProb,
      breakoutProb,
      falseBORisk,
    };
  }

  // ── Step 6 helper: tier assignment ───────────────────────────────────────────

  _assignTier(score, agreementCount, metrics) {
    const { confidenceScore, falseBORisk } = metrics;
    const confidence = confidenceScore / 100; // gate uses 0-1

    // Check from highest tier downward — first gate that passes wins
    for (const [tier, gate] of Object.entries(TIER_GATES)) {
      if (score         >= gate.minScore      &&
          agreementCount >= gate.minAgreement  &&
          falseBORisk    <= gate.maxFBRisk     &&
          confidence     >= gate.minConfidence) {
        return tier;
      }
    }

    return 'REJECT';
  }

  // ── Step 7 helper: quality dimension scores ───────────────────────────────────

  _computeQualityDims(results) {
    const eng = byId(results);
    const em  = eng['emavol'];
    const lux = eng['lux'];
    const ts  = eng['trendspider'];
    const cp  = eng['chartprime'];
    const aa  = eng['algoalpha'];

    return {
      // For the UI ranking table — sortable columns
      trendQuality: Math.round(
        ((em?.subscores?.trendQuality ?? 50) * 0.50) +
        ((lux?.subscores?.trend       ?? 50) * 0.50)
      ),
      volumeQuality: em?.subscores?.volume ?? 50,
      structureQuality: Math.round(
        ((cp?.subscores?.marketStructure ?? 50) * 0.55) +
        ((cp?.subscores?.bos             ?? 50) * 0.45)
      ),
      momentumQuality: Math.round(
        ((lux?.subscores?.momentum          ?? 50) * 0.45) +
        ((aa?.subscores?.momentumExpansion  ?? 50) * 0.55)
      ),
      relativeStrength: Math.round(
        ((em?.subscores?.relativeStrength ?? 50) * 0.50) +
        ((ts?.subscores?.relativeStrength ?? 50) * 0.50)
      ),
    };
  }

  // ── Step 8 helper: explainability ────────────────────────────────────────────

  _buildExplain(results, dominant, metrics, tier, ticker) {
    const allFlags = results.flatMap(e => e.flags ?? []);
    const flagSet  = new Set(allFlags);

    const aligned  = results.filter(e => e.direction === dominant);
    const opposing = results.filter(e => e.direction !== dominant && e.direction !== 'neutral');

    // Map known flags to human-readable signal strings
    const POSITIVE_SIGNALS = [
      ['ema_stack_full',                  'Full EMA stack aligned (20 > 50 > 100 > 200)'],
      ['strong_accumulation',             'Strong accumulation: U/D volume ratio ≥ 2×'],
      ['obv_rising',                      'OBV trending up — institutional accumulation'],
      ['squeeze_fire',                    'AlgoAlpha: volatility squeeze fired'],
      ['kama_accelerating',               'AlgoAlpha: adaptive trend accelerating'],
      ['dual_tf_momentum_expansion',      'AlgoAlpha: momentum expansion confirmed on 2 TFs'],
      ['bullish_bos',                     'ChartPrime: bullish Break of Structure'],
      ['displacement_candle',             'ChartPrime: displacement candle on BOS'],
      ['bullish_liquidity_sweep',         'ChartPrime: bullish liquidity sweep (stop hunt)'],
      ['price_in_order_block',            'ChartPrime: price retesting order block'],
      ['strong_institutional_volume',     'ChartPrime: strong institutional volume at level'],
      ['accumulation_footprint',          'ChartPrime: accumulation volume footprint'],
      ['full_mtf_bullish_alignment',      'TrendSpider: all 3 timeframes bullish aligned'],
      ['vcp_tight_base',                  'TrendSpider: VCP tight base detected'],
      ['decisive_breakout',               'TrendSpider: decisive breakout above range'],
      ['near_52wk_high',                  'Near 52-week high — relative strength leader'],
      ['strong_bull_market_structure',    'Strong bull structure: consistent HH + HL sequence'],
      ['strong_trend_persistence',        'LuxAlgo: trend persisted 15+ bars'],
      ['supertrend_bullish',              'LuxAlgo: SuperTrend direction bullish'],
      ['ema20_pullback_hold',             'EMA+Vol: pullback to EMA20 held — continuation signal'],
      ['ema50_pullback_hold',             'EMA+Vol: pullback to EMA50 held — healthy trend'],
      ['volume_surge_2x',                 'Breakout volume surge ≥ 2× average'],
      ['tight_base',                      'Consolidation base tighter than 80% of prior range'],
      ['bullish_fvg_present',             'ChartPrime: bullish fair value gap (imbalance)'],
    ];

    const RISK_SIGNALS = [
      ['volume_fail',                     'Breakout lacks volume confirmation (volume_fail)'],
      ['breakout_volume_fail',            'TrendSpider: breakout-volume penalty applied'],
      ['score_capped_volume_fail',        'EMA+Vol score capped at 60: no volume confirmation'],
      ['dead_volatility',                 'ATR in dead-volatility zone (<30th percentile)'],
      ['extreme_volatility',              'ATR in extreme-volatility zone (>95th percentile)'],
      ['weekly_daily_conflict',           'Weekly and Daily trend in conflict'],
      ['ob_invalidated',                  'Order block zone invalidated'],
      ['bear_market_structure',           'Bearish market structure: LL + LH sequence'],
      ['momentum_decelerating',           'AlgoAlpha: momentum decelerating'],
      ['mtf_conflict',                    'Multi-timeframe conflict detected'],
      ['bearish_bos',                     'ChartPrime: bearish Break of Structure'],
      ['bearish_liquidity_sweep',         'ChartPrime: bearish liquidity sweep'],
      ['subscore_penalty_cap',            'LuxAlgo: sub-score penalty cap triggered'],
    ];

    const positiveSignals = POSITIVE_SIGNALS
      .filter(([flag]) => flagSet.has(flag))
      .map(([, label]) => label)
      .slice(0, 6);

    const riskSignals = RISK_SIGNALS
      .filter(([flag]) => flagSet.has(flag))
      .map(([, label]) => label);

    // Auto-add metric-based risk statements
    if (metrics.falseBORisk >= 40 && !riskSignals.length) {
      riskSignals.push(`Elevated false-breakout risk: ${metrics.falseBORisk}/100`);
    }

    return {
      summary: this._buildSummary(aligned, opposing, tier, metrics, ticker),
      positiveSignals,
      riskSignals: riskSignals.slice(0, 4),
      alignedEngines:  aligned.map(e  => ({ engine: e.engine, score: e.score })),
      opposingEngines: opposing.map(e => ({ engine: e.engine, score: e.score, reason: e.direction })),
      keyFlags: [...flagSet].slice(0, 14),
    };
  }

  _buildSummary(aligned, opposing, tier, metrics, ticker) {
    const t    = ticker ? `${ticker}: ` : '';
    const eng  = aligned.map(e => `${e.engine}(${e.score})`).join(', ');
    const opp  = opposing.length
      ? ` Dissenter — ${opposing.map(e => `${e.engine}(${e.score})`).join(', ')}.`
      : ' All engines aligned.';
    return `${t}Tier ${tier}. ${aligned.length}/5 engines agree (${eng}).${opp} ` +
           `Breakout prob: ${metrics.breakoutProb}. False-breakout risk: ${metrics.falseBORisk}.`;
  }

  // ── Reject helper ─────────────────────────────────────────────────────────────

  _fail(reason, detail = '') {
    return {
      ok:              false,
      rejected:        true,
      rejectReason:    reason,
      rejectDetail:    detail,
      ticker:          null,
      consensusScore:  0,
      tier:            'REJECT',
      direction:       'neutral',
      agreementCount:  0,
      agreementPct:    0,
      confidenceScore: 0,
      institutionalProb:      0,
      trendContinuationProb:  0,
      breakoutProb:           0,
      falseBORisk:            100,
      qualityDims:     { trendQuality: 0, volumeQuality: 0, structureQuality: 0, momentumQuality: 0, relativeStrength: 0 },
      explain:         { summary: `Rejected: ${reason}. ${detail}`, positiveSignals: [], riskSignals: [detail], alignedEngines: [], opposingEngines: [], keyFlags: [] },
      weightsUsed:     BASE_WEIGHTS,
      computedAt:      Date.now(),
    };
  }
}

module.exports = new ConsensusEngine();
