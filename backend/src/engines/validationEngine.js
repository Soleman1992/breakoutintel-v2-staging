/**
 * validationEngine.js — Phase 8: Anti-Overfitting Validation Protocol
 *
 * Runs against live scan data to verify the consensus engine is behaving
 * correctly and not overfitting. Produces a structured health report.
 *
 * Checks performed:
 *   1. Engine independence — pairwise Pearson correlation matrix.
 *      If any pair > 0.75, consensus is double-counting that signal.
 *   2. Score distribution health — mean, std, min, max per engine.
 *      Flat distributions (low std) = engine not discriminating.
 *   3. Direction gate stats — pass rate, long/short/neutral split.
 *   4. Tier distribution — S/A/B/C/REJECT counts and alerts.
 *   5. False-breakout risk audit — gate integrity check (no Tier S with FB>20).
 *   6. Weight drift monitor — current weights vs baseline, alert if >±5%.
 *   7. Forward return tracking — infrastructure ready; needs 20+ days of data.
 *
 * Objective function (per blueprint): maximise risk-adjusted return per unit
 * of false-breakout rate — NOT win rate.
 */

'use strict';

// ── Statistical utilities ─────────────────────────────────────────────────────

function pearsonR(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 4) return null;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  const den = Math.sqrt(dx2 * dy2);
  return den === 0 ? 0 : Math.round((num / den) * 1000) / 1000;
}

function stats(arr) {
  const clean = arr.filter(v => v != null && !isNaN(v));
  if (!clean.length) return null;
  const mean = clean.reduce((s, v) => s + v, 0) / clean.length;
  const variance = clean.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, clean.length - 1);
  return {
    mean:   Math.round(mean * 10) / 10,
    std:    Math.round(Math.sqrt(variance) * 10) / 10,
    min:    Math.min(...clean),
    max:    Math.max(...clean),
    n:      clean.length,
    range:  Math.max(...clean) - Math.min(...clean),
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ENGINES = ['emavol', 'lux', 'trendspider', 'chartprime', 'algoalpha'];
const ENGINE_LABELS = {
  emavol:      'EMA + Vol',
  lux:         'LuxAlgo',
  trendspider: 'TrendSpider',
  chartprime:  'ChartPrime',
  algoalpha:   'AlgoAlpha',
};

const BASE_WEIGHTS = { emavol: 0.20, lux: 0.20, trendspider: 0.20, chartprime: 0.22, algoalpha: 0.18 };

// Thresholds (from blueprint)
const CORR_HIGH     = 0.75;  // above = correlated, double-counting risk
const CORR_MODERATE = 0.50;  // above = worth watching
const DRIFT_LIMIT   = 0.05;  // ±5% weight drift = regime-change alert
const TIER_S_MAX_PCT = 5;    // Tier S should be < 5% of universe

// ── Validation Engine ─────────────────────────────────────────────────────────

class ValidationEngine {
  constructor(db) {
    this.db = db;
  }

  // ── Data loading ──────────────────────────────────────────────────────────

  async _loadLatestRun() {
    if (!this.db) return { error: 'Database not connected' };
    try {
      const runRes = await this.db.query(`
        SELECT run_id, universe_size, accepted, rejected, tier_counts, completed_at
        FROM scan_runs ORDER BY completed_at DESC LIMIT 1
      `);
      if (!runRes.rows.length) return { error: 'No scan runs found — trigger a scan first' };
      const run = runRes.rows[0];

      const dataRes = await this.db.query(`
        SELECT ticker, category, consensus_score, tier, direction,
               agreement_pct, false_bo_risk, confidence_score,
               engine_scores, quality_dims, explain_data
        FROM consensus_results WHERE run_id = $1
      `, [run.run_id]);

      return { run, rows: dataRes.rows };
    } catch (e) {
      return { error: `DB query failed: ${e.message}` };
    }
  }

  async _loadWeightConfig() {
    if (!this.db) return BASE_WEIGHTS;
    try {
      const res = await this.db.query(`
        SELECT weights FROM weight_config ORDER BY fitted_at DESC LIMIT 1
      `);
      return res.rows.length ? res.rows[0].weights : BASE_WEIGHTS;
    } catch (e) {
      return BASE_WEIGHTS;
    }
  }

  // ── Check 1: Engine independence ──────────────────────────────────────────

  checkCorrelations(rows) {
    const engineScores = {};
    for (const eng of ENGINES) {
      engineScores[eng] = rows.map(r => r.engine_scores?.[eng]?.score ?? 50);
    }

    const pairs = [];
    const alerts = [];
    const warnings = [];

    for (let i = 0; i < ENGINES.length; i++) {
      for (let j = i + 1; j < ENGINES.length; j++) {
        const a = ENGINES[i], b = ENGINES[j];
        const r = pearsonR(engineScores[a], engineScores[b]);

        let status = 'independent';
        if (r !== null) {
          if (r >= CORR_HIGH)     status = 'correlated';
          else if (r >= CORR_MODERATE) status = 'moderate';
        }

        pairs.push({
          engineA: a, engineB: b,
          labelA: ENGINE_LABELS[a], labelB: ENGINE_LABELS[b],
          r, status,
        });

        if (r !== null && r >= CORR_HIGH) {
          alerts.push(`${ENGINE_LABELS[a]} ↔ ${ENGINE_LABELS[b]}: r=${r} — CORRELATED. Consensus is double-counting the shared dimension. Consider redesigning one engine to capture a different market behaviour.`);
        } else if (r !== null && r >= CORR_MODERATE) {
          warnings.push(`${ENGINE_LABELS[a]} ↔ ${ENGINE_LABELS[b]}: r=${r} — moderate overlap. Monitor.`);
        }
      }
    }

    // Decorrelation shrinkage already handles lux+emavol. Flag if others emerge.
    const highCorr = pairs.filter(p => p.status === 'correlated');
    const independence_score = Math.max(0, 100 - highCorr.length * 25);

    return { pairs, alerts, warnings, independence_score, n_stocks: rows.length };
  }

  // ── Check 2: Score distribution health ───────────────────────────────────

  checkDistributions(rows) {
    const dists = {};
    const alerts = [];

    for (const eng of ENGINES) {
      const scores = rows.map(r => r.engine_scores?.[eng]?.score ?? null);
      const s = stats(scores);
      if (!s) continue;
      dists[eng] = s;

      if (s.std < 8) {
        alerts.push(`${ENGINE_LABELS[eng]}: std=${s.std} — very low variance. Engine may not be discriminating between stocks.`);
      }
      if (s.range < 20) {
        alerts.push(`${ENGINE_LABELS[eng]}: range=${s.range} — compressed scores. Check sub-score logic.`);
      }
    }

    // Consensus score distribution
    const cs = rows.map(r => r.consensus_score).filter(v => v != null);
    dists['consensus'] = stats(cs);

    return { distributions: dists, alerts };
  }

  // ── Check 3: Direction gate stats ─────────────────────────────────────────

  checkDirectionGate(rows) {
    const total    = rows.length;
    const long_    = rows.filter(r => r.direction === 'long').length;
    const short_   = rows.filter(r => r.direction === 'short').length;
    const neutral_ = rows.filter(r => r.direction === 'neutral').length;
    const rejected = rows.filter(r => r.tier === 'REJECT').length;
    const passed   = total - rejected;

    const alerts = [];
    const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;

    if (passRate < 30) alerts.push(`Direction gate pass rate is ${passRate}% — market may be in a mixed/choppy regime. Expected 40-70% in normal conditions.`);
    if (passRate > 85) alerts.push(`Direction gate pass rate is ${passRate}% — unusually high. Check that engine directions are not all defaulting to 'long'.`);
    if (long_ > 0 && short_ === 0) alerts.push('Zero short signals — all engines biased long. Normal in a bull market but verify.');

    return {
      total, passed, rejected, long: long_, short: short_, neutral: neutral_,
      passRate,
      longPct:  total > 0 ? Math.round((long_  / total) * 100) : 0,
      shortPct: total > 0 ? Math.round((short_ / total) * 100) : 0,
      alerts,
    };
  }

  // ── Check 4: Tier distribution ────────────────────────────────────────────

  checkTierDistribution(run, rows) {
    const counts = { S: 0, A: 0, B: 0, C: 0, REJECT: 0 };
    rows.forEach(r => { if (counts[r.tier] !== undefined) counts[r.tier]++; });
    const total = rows.length;
    const alerts = [];

    const sPct = total > 0 ? (counts.S / total) * 100 : 0;
    if (sPct > TIER_S_MAX_PCT) {
      alerts.push(`Tier S = ${counts.S} stocks (${sPct.toFixed(1)}% of universe) — criteria may be too permissive. Expected < ${TIER_S_MAX_PCT}%.`);
    }
    if (counts.S === 0 && total > 20) {
      alerts.push('Tier S = 0 — direction gate + score + agreement + FB-risk gates are eliminating all candidates. Check gate thresholds.');
    }
    if ((counts.A + counts.S) === 0 && total > 20) {
      alerts.push('No Tier S or A stocks — system may be in a regime where no setups meet institutional quality.');
    }

    const pcts = {};
    for (const [k, v] of Object.entries(counts)) {
      pcts[k] = total > 0 ? Math.round((v / total) * 100) : 0;
    }

    return { counts, percentages: pcts, total, alerts };
  }

  // ── Check 5: False-breakout risk gate integrity ───────────────────────────

  checkFBRiskGates(rows) {
    const alerts = [];

    // Tier S: FB risk must be < 20 by gate design
    const tierS = rows.filter(r => r.tier === 'S');
    const tierS_highFB = tierS.filter(r => (r.false_bo_risk ?? 100) >= 20);
    if (tierS_highFB.length > 0) {
      alerts.push(`GATE BREACH: ${tierS_highFB.length} Tier S stocks have FB risk ≥ 20. Gate logic may have a bug.`);
    }

    // Tier A: FB risk must be < 30
    const tierA = rows.filter(r => r.tier === 'A');
    const tierA_highFB = tierA.filter(r => (r.false_bo_risk ?? 100) >= 30);
    if (tierA_highFB.length > 0) {
      alerts.push(`GATE BREACH: ${tierA_highFB.length} Tier A stocks have FB risk ≥ 30. Gate logic may have a bug.`);
    }

    // Distribution of FB risk among accepted stocks
    const accepted = rows.filter(r => r.tier !== 'REJECT');
    const fbScores = accepted.map(r => r.false_bo_risk).filter(v => v != null);
    const fbDist = {
      low:      fbScores.filter(v => v < 25).length,
      moderate: fbScores.filter(v => v >= 25 && v < 45).length,
      high:     fbScores.filter(v => v >= 45).length,
    };
    const avgFB = fbScores.length > 0 ? Math.round(fbScores.reduce((s,v)=>s+v,0)/fbScores.length) : null;

    return {
      tierS: { count: tierS.length, gateBreach: tierS_highFB.length },
      tierA: { count: tierA.length, gateBreach: tierA_highFB.length },
      fbDistribution: fbDist,
      avgFBRisk: avgFB,
      alerts,
    };
  }

  // ── Check 6: Weight drift ─────────────────────────────────────────────────

  async checkWeightDrift() {
    const current = await this._loadWeightConfig();
    const drifts = [];
    const alerts = [];

    for (const [eng, baseW] of Object.entries(BASE_WEIGHTS)) {
      const currW  = current[eng] ?? baseW;
      const drift  = Math.round((currW - baseW) * 1000) / 1000;
      const absDrift = Math.abs(drift);
      const alert  = absDrift > DRIFT_LIMIT;
      drifts.push({ engine: eng, label: ENGINE_LABELS[eng], base: baseW, current: currW, drift, alert });
      if (alert) {
        alerts.push(`${ENGINE_LABELS[eng]}: weight drifted ${drift > 0 ? '+' : ''}${(drift*100).toFixed(1)}% from baseline — possible regime change. Investigate before accepting new weights.`);
      }
    }

    return { baseline: BASE_WEIGHTS, current, drifts, alerts };
  }

  // ── Forward return tracking (infrastructure) ──────────────────────────────

  async checkForwardReturns() {
    if (!this.db) return { status: 'unavailable', note: 'DB not connected' };
    try {
      const res = await this.db.query(`SELECT COUNT(*) FROM scan_runs`);
      const runs = parseInt(res.rows[0].count);
      const needed = 3; // need at least 3 runs spanning 20+ days
      if (runs < needed) {
        return {
          status: 'insufficient_data',
          runsAvailable: runs,
          runsNeeded: needed,
          note: `Forward return tracking needs ${needed}+ scan runs spanning 20+ trading days. Currently ${runs} run(s). Check back in ~30 days.`,
        };
      }
      // Future: join scan_runs → consensus_results → fetch current price → compute return
      return { status: 'ready', runsAvailable: runs, note: 'Sufficient data. Query not yet implemented.' };
    } catch (e) {
      return { status: 'error', error: e.message };
    }
  }

  // ── Main report ───────────────────────────────────────────────────────────

  async runValidation() {
    const loaded = await this._loadLatestRun();
    if (loaded.error) {
      return { ok: false, error: loaded.error, generatedAt: new Date().toISOString() };
    }

    const { run, rows } = loaded;

    if (rows.length < 5) {
      return {
        ok: false,
        error: `Latest run has only ${rows.length} stocks — need ≥ 5 for meaningful validation.`,
        generatedAt: new Date().toISOString(),
      };
    }

    // Run all checks in parallel
    const [correlations, weightDrift, forwardReturns] = await Promise.all([
      Promise.resolve(this.checkCorrelations(rows)),
      this.checkWeightDrift(),
      this.checkForwardReturns(),
    ]);

    const distributions = this.checkDistributions(rows);
    const directionStats = this.checkDirectionGate(rows);
    const tierStats = this.checkTierDistribution(run, rows);
    const fbRisk = this.checkFBRiskGates(rows);

    // Aggregate all alerts
    const allAlerts = [
      ...correlations.alerts,
      ...distributions.alerts,
      ...directionStats.alerts,
      ...tierStats.alerts,
      ...fbRisk.alerts,
      ...weightDrift.alerts,
    ];

    // Health score (starts at 100, deduct per alert)
    const gateBreach = fbRisk.tierS.gateBreach + fbRisk.tierA.gateBreach;
    const highCorrCount = correlations.pairs.filter(p => p.status === 'correlated').length;

    let health = 100;
    health -= gateBreach * 30;     // gate breaches are severe
    health -= highCorrCount * 15;  // correlated engines
    health -= Math.min(30, allAlerts.filter(a => !a.includes('Forward')).length * 8);
    health = Math.max(0, Math.min(100, Math.round(health)));

    const status = health >= 80 ? 'HEALTHY'
                 : health >= 60 ? 'WARNING'
                 :                'CRITICAL';

    return {
      ok:     true,
      health,
      status,
      runId:            run.run_id,
      runAt:            run.completed_at,
      universeSize:     run.universe_size || rows.length,
      stocksEvaluated:  rows.length,

      correlations,
      distributions,
      directionStats,
      tierStats,
      fbRisk,
      weightDrift,
      forwardReturns,

      alerts: allAlerts,
      notes: [
        'Independence threshold: r > 0.75 = correlated engines (consensus double-counts).',
        'Objective: maximise risk-adjusted return per unit of false-breakout rate — not win rate.',
        'Walk-forward weight optimisation: run quarterly, constrain weights to ±5% of prior.',
        'Forward return tracking activates after 3+ scan runs spanning 20+ trading days.',
      ],
      generatedAt: new Date().toISOString(),
    };
  }
}

module.exports = ValidationEngine;
