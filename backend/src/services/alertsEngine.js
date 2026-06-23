/**
 * AlertsEngine — System-generated scanner alert pipeline
 *
 * Derives alerts from live scanner results and news intelligence.
 * Every alert is:
 *   - Sourced exclusively from real scanner data / news DB (no fabrication)
 *   - Deduplicated via Redis SET + DB UNIQUE constraint
 *   - Scored for impact (0–100), confidence (0–100), urgency (LOW/MEDIUM/HIGH/CRITICAL)
 *   - Persisted to scanner_alerts table
 *   - Expired automatically after 8h (breakout/volume) or 24h (news)
 *
 * Breakout alert thresholds:
 *   - cat === 'active'   (confirmed breakout, not a pre-breakout setup)
 *   - conf >= 6/10       (scanner confidence gate)
 *   - vol >= 1.5x avg    (volume confirmation required)
 *
 * Volume alert thresholds:
 *   - vol >= 3.0x avg    (institutional-grade threshold — avoids noise below 3x)
 *
 * News alert source:
 *   - news_items WHERE impact_score >= 60 AND category != 'General' AND ai_scored
 */

'use strict';

class AlertsEngine {
  constructor(db, redis) {
    this.db    = db;
    this.redis = redis;
    this._breakoutCache = [];
    this._volumeCache   = [];
    this._newsCache     = [];
    this._lastBreakoutAt = 0;
    this._lastVolumeAt   = 0;
    this._lastNewsAt     = 0;
  }

  // ── Redis helpers ──────────────────────────────────────────────────────────

  async _redisGet(key) {
    try { return this.redis?.isReady ? await this.redis.get(key) : null; } catch { return null; }
  }
  async _redisSet(key, ttl, val) {
    try { if (this.redis?.isReady) await this.redis.setEx(key, ttl, val); } catch {}
  }
  async _redisSadd(key, ttl, member) {
    try {
      if (!this.redis?.isReady) return false;
      const added = await this.redis.sAdd(key, member);
      await this.redis.expire(key, ttl);
      return added > 0;
    } catch { return false; }
  }
  async _redisIsMember(key, member) {
    try { return this.redis?.isReady ? await this.redis.sIsMember(key, member) : false; } catch { return false; }
  }

  // ── Deduplication ──────────────────────────────────────────────────────────
  // Returns true if this is a NEW alert (not seen before in this time window).
  // Two-layer: Redis SET (fast) + DB UNIQUE constraint (durable).

  async _isNew(dedupKey, ttlSeconds) {
    const redisKey = `alerts:dedup`;
    const isMember = await _redisIsMember.call(this, redisKey, dedupKey);
    if (isMember) return false;
    await _redisSadd.call(this, redisKey, ttlSeconds, dedupKey);
    return true;
  }

  async _isNewAlert(dedupKey, ttlSeconds) {
    const redisKey = `alerts:dedup`;
    try {
      if (this.redis?.isReady) {
        const isMember = await this.redis.sIsMember(redisKey, dedupKey);
        if (isMember) return false;
        await this.redis.sAdd(redisKey, dedupKey);
        await this.redis.expire(redisKey, ttlSeconds);
      }
    } catch {}
    return true;
  }

  // ── Impact + Urgency scoring ───────────────────────────────────────────────

  _calcBreakoutImpact(r) {
    let score = r.conf * 10;               // 0–100 baseline from scanner conf
    if (r.vol >= 4.0)  score += 10;
    else if (r.vol >= 2.5) score += 5;
    if (r.rs  >= 85)   score += 10;
    else if (r.rs >= 75) score += 5;
    if (r.proximity52w >= 97) score += 8;
    else if (r.proximity52w >= 93) score += 4;
    if (r.strat === 'earnings_mom')  score += 12;
    if (r.strat === 'minervini')     score += 8;
    if (r.volConfirmed)              score += 5;
    return Math.min(100, Math.max(0, Math.round(score)));
  }

  _calcVolumeImpact(r) {
    let score = 40;
    if (r.vol >= 8)    score += 35;
    else if (r.vol >= 5) score += 25;
    else if (r.vol >= 4) score += 15;
    else if (r.vol >= 3) score += 5;
    if (r.rs >= 80)    score += 10;
    if (r.cat === 'active') score += 10;
    return Math.min(100, Math.max(0, Math.round(score)));
  }

  _urgency(impact) {
    if (impact >= 85) return 'CRITICAL';
    if (impact >= 70) return 'HIGH';
    if (impact >= 50) return 'MEDIUM';
    return 'LOW';
  }

  _newsUrgency(impact_score, urgency_from_ai) {
    if (urgency_from_ai === 'Immediate' || impact_score >= 85) return 'CRITICAL';
    if (urgency_from_ai === 'Short-Term' || impact_score >= 70) return 'HIGH';
    if (impact_score >= 55) return 'MEDIUM';
    return 'LOW';
  }

  // ── Breakout alert reasons builder ────────────────────────────────────────

  _breakoutReasons(r) {
    const reasons = [];
    if (r.cat === 'active')         reasons.push('✓ Breakout confirmed');
    if (r.vol >= 2.0)               reasons.push(`✓ Volume surge (${r.vol.toFixed(1)}x average)`);
    if (r.vol >= 1.5 && r.vol < 2) reasons.push(`✓ Above-average volume (${r.vol.toFixed(1)}x)`);
    if (r.rs >= 80)                 reasons.push(`✓ High relative strength (RS ${r.rs})`);
    else if (r.rs >= 70)            reasons.push(`✓ Strong relative strength (RS ${r.rs})`);
    if (r.conf >= 8)                reasons.push('✓ Multi-engine agreement (high confidence)');
    else if (r.conf >= 6)           reasons.push('✓ Multi-engine agreement');
    if (r.proximity52w >= 97)       reasons.push('✓ Near 52-week high');
    else if (r.proximity52w >= 90)  reasons.push('✓ Within 10% of 52-week high');
    if (r.strat === 'earnings_mom') reasons.push('✓ Earnings catalyst');
    if (r.strat === 'minervini')    reasons.push('✓ Minervini trend template');
    if (r.strat === 'darvas')       reasons.push('✓ Darvas box breakout');
    if (r.strat === 'vcp')          reasons.push('✓ VCP (Volatility Contraction Pattern)');
    if (r.strat === 'gap')          reasons.push('✓ Gap-up strength');
    if (r.strat === 'momentum')     reasons.push('✓ High momentum continuation');
    if (r.strat === 'mom_ignite')   reasons.push('✓ Momentum ignition signal');
    if (r.strat === 'rs')           reasons.push('✓ Stage 2 base (Weinstein)');
    if (r.foStock)                  reasons.push('✓ F&O eligible stock');
    return reasons.slice(0, 6);
  }

  // ── Volume alert reasons builder ──────────────────────────────────────────

  _volumeReasons(r) {
    const fmt = (n) => n >= 1e7 ? `${(n/1e7).toFixed(1)} Cr` : n >= 1e5 ? `${(n/1e5).toFixed(1)} L` : n.toLocaleString('en-IN');
    const reasons = [];
    reasons.push(`Volume ${r.vol.toFixed(1)}x 20-day average`);
    if (r.curVolume) reasons.push(`Current: ${fmt(r.curVolume)} shares`);
    if (r.avgVolume) reasons.push(`Average: ${fmt(r.avgVolume)} shares`);
    if (r.cat === 'active')         reasons.push('Price breakout confirmed');
    if (r.rs >= 75)                 reasons.push(`Strong RS score (${r.rs})`);
    if (r.strat === 'vol_shock')    reasons.push('Shock volume event (≥5x spike)');
    if (r.strat === 'earnings_mom') reasons.push('Post-earnings volume');
    return reasons.slice(0, 5);
  }

  // ── Dedup window helper ───────────────────────────────────────────────────
  // Quantise time to N-hour bucket so the same signal doesn't repeat within window.
  _timeWindow(hours) {
    return Math.floor(Date.now() / (hours * 60 * 60 * 1000));
  }

  // ── DB persist (non-throwing) ─────────────────────────────────────────────

  async _persist(alert) {
    if (!this.db) return;
    try {
      await this.db.query(`
        INSERT INTO scanner_alerts
          (alert_type, symbol, company_name, sector, industry, cap,
           signal_source, alert_title, alert_body, impact_score, confidence,
           urgency, sentiment, vol_ratio, avg_volume, cur_volume, cmp,
           entry_price, stop_price, target1_price, rs_score,
           reasons, dedup_key, triggered_at, expires_at, raw_data)
        VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,NOW(),$24,$25)
        ON CONFLICT (dedup_key) DO NOTHING
      `, [
        alert.alertType,
        alert.symbol,
        alert.companyName,
        alert.sector,
        alert.industry,
        alert.cap,
        alert.signalSource,
        alert.alertTitle,
        alert.alertBody || null,
        alert.impactScore,
        alert.confidence,
        alert.urgency,
        alert.sentiment || null,
        alert.volRatio  || null,
        alert.avgVolume || null,
        alert.curVolume || null,
        alert.cmp       || null,
        alert.entry     || null,
        alert.stop      || null,
        alert.target1   || null,
        alert.rs        || null,
        alert.reasons   || [],
        alert.dedupKey,
        alert.expiresAt,
        alert.rawData   ? JSON.stringify(alert.rawData) : null,
      ]);
    } catch (e) {
      // UNIQUE conflict → normal dedup; other errors: log only, non-fatal
      if (!e.message?.includes('unique')) {
        console.warn(`[AlertsEngine] Persist error (${alert.dedupKey?.slice(0,16)}): ${e.message}`);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PUBLIC — BREAKOUT ALERTS
  // ══════════════════════════════════════════════════════════════════════════

  async generateBreakoutAlerts(scanResults) {
    const alerts = [];
    const win4h  = this._timeWindow(4);  // 4-hour dedup window

    const candidates = (scanResults || []).filter(r =>
      r.cat === 'active' && r.conf >= 6 && r.vol >= 1.5
    );

    for (const r of candidates) {
      const impact    = this._calcBreakoutImpact(r);
      const urgency   = this._urgency(impact);
      const confidence = Math.round(r.conf * 10);
      const reasons   = this._breakoutReasons(r);
      const dedupKey  = `bo:${r.sym}:${r.strat}:${win4h}`;

      const isNew = await this._isNewAlert(dedupKey, 4 * 3600);
      if (!isNew) continue;

      const alert = {
        alertType:    'breakout',
        symbol:       r.sym,
        companyName:  r.name,
        sector:       r.sector,
        industry:     r.industry,
        cap:          r.cap,
        signalSource: r.stratName || r.strat,
        alertTitle:   `${r.sym} — ${r.stratName || 'Breakout Signal'}`,
        impactScore:  impact,
        confidence:   confidence,
        urgency,
        sentiment:    'Bullish',
        volRatio:     r.vol,
        avgVolume:    r.avgVolume,
        curVolume:    r.curVolume,
        cmp:          r.cmp,
        entry:        r.entry,
        stop:         r.stop,
        target1:      r.t1,
        rs:           r.rs,
        proximity52w: r.proximity52w,
        reasons,
        dedupKey,
        triggeredAt:  new Date().toISOString(),
        expiresAt:    new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
        rawData:      { strat: r.strat, cat: r.cat, conf: r.conf, volConfirmed: r.volConfirmed },
      };

      alerts.push(alert);
      await this._persist(alert);
    }

    // Sort by impact desc, urgency
    alerts.sort((a, b) => b.impactScore - a.impactScore);
    this._breakoutCache = alerts;
    this._lastBreakoutAt = Date.now();
    return alerts;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PUBLIC — VOLUME ALERTS
  // ══════════════════════════════════════════════════════════════════════════

  async generateVolumeAlerts(scanResults) {
    const alerts = [];

    const candidates = (scanResults || []).filter(r => r.vol >= 3.0)
      .sort((a, b) => b.vol - a.vol);

    for (const r of candidates) {
      const impact   = this._calcVolumeImpact(r);
      const urgency  = this._urgency(impact);

      // EXTREME (≥5x): 2h window. Others: 4h window.
      const winHours = r.vol >= 5 ? 2 : 4;
      const win      = this._timeWindow(winHours);
      const tier     = r.vol >= 5 ? 'EXTREME' : r.vol >= 4 ? 'HIGH' : 'ELEVATED';
      const dedupKey = `vol:${r.sym}:${tier}:${win}`;

      const isNew = await this._isNewAlert(dedupKey, winHours * 3600);
      if (!isNew) continue;

      const reasons = this._volumeReasons(r);

      const alert = {
        alertType:    'volume',
        symbol:       r.sym,
        companyName:  r.name,
        sector:       r.sector,
        industry:     r.industry,
        cap:          r.cap,
        signalSource: 'Volume Scanner',
        alertTitle:   `${r.sym} — Volume ${r.vol.toFixed(1)}x (${tier})`,
        alertBody:    `${r.name} trading at ${r.vol.toFixed(1)}x average volume`,
        impactScore:  impact,
        confidence:   Math.min(100, Math.round(r.vol * 15 + (r.cat === 'active' ? 10 : 0))),
        urgency,
        sentiment:    r.chg > 0 ? 'Bullish' : r.chg < 0 ? 'Bearish' : 'Neutral',
        volRatio:     r.vol,
        avgVolume:    r.avgVolume,
        curVolume:    r.curVolume,
        cmp:          r.cmp,
        rs:           r.rs,
        reasons,
        dedupKey,
        triggeredAt:  new Date().toISOString(),
        expiresAt:    new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
        rawData:      { strat: r.strat, cat: r.cat, chg: r.chg, tier },
      };

      alerts.push(alert);
      await this._persist(alert);
    }

    alerts.sort((a, b) => b.volRatio - a.volRatio);
    this._volumeCache = alerts;
    this._lastVolumeAt = Date.now();
    return alerts;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PUBLIC — NEWS ALERTS (from news_items DB — no fabrication, real AI scores)
  // ══════════════════════════════════════════════════════════════════════════

  async generateNewsAlerts() {
    if (!this.db) return [];

    // Check Redis cache first (news changes slowly — 5min cache)
    const cached = await this._redisGet('alerts:news:v2');
    if (cached) {
      this._newsCache = JSON.parse(cached);
      return this._newsCache;
    }

    try {
      const { rows } = await this.db.query(`
        SELECT id, source, title, summary, link, symbol, company_name,
               category, published_at, fetched_at,
               impact_score, confidence, trading_relevance,
               sentiment, urgency AS ai_urgency, why_it_matters, trading_implication,
               affected_sectors, affected_stocks
        FROM   news_items
        WHERE  impact_score >= 60
        AND    category != 'General'
        AND    ai_scored_at IS NOT NULL
        AND    COALESCE(published_at, fetched_at) >= NOW() - INTERVAL '24 hours'
        ORDER  BY impact_score DESC, COALESCE(published_at, fetched_at) DESC
        LIMIT  50
      `);

      const alerts = rows.map(row => ({
        alertType:          'news',
        symbol:             row.symbol || null,
        companyName:        row.company_name || null,
        signalSource:       row.source,
        alertTitle:         row.title,
        alertBody:          row.summary || null,
        link:               row.link || null,
        impactScore:        row.impact_score || 0,
        confidence:         row.confidence || 0,
        tradingRelevance:   row.trading_relevance || 0,
        urgency:            this._newsUrgency(row.impact_score || 0, row.ai_urgency),
        sentiment:          row.sentiment || 'Neutral',
        category:           row.category,
        whyItMatters:       row.why_it_matters || null,
        tradingImplication: row.trading_implication || null,
        affectedSectors:    row.affected_sectors || [],
        affectedStocks:     row.affected_stocks  || [],
        publishedAt:        row.published_at || row.fetched_at,
        triggeredAt:        new Date().toISOString(),
      }));

      await this._redisSet('alerts:news:v2', 300, JSON.stringify(alerts));  // 5min cache
      this._newsCache    = alerts;
      this._lastNewsAt   = Date.now();
      return alerts;
    } catch (e) {
      console.warn('[AlertsEngine] News query error:', e.message);
      return this._newsCache;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PUBLIC — CACHED GETTERS (for REST API — no re-generation)
  // ══════════════════════════════════════════════════════════════════════════

  getBreakoutAlerts()  { return this._breakoutCache; }
  getVolumeAlerts()    { return this._volumeCache;   }
  getNewsAlerts()      { return this._newsCache;     }

  // ── Historical alerts from DB ─────────────────────────────────────────────

  async getHistoricalAlerts({ type, hours = 24, limit = 100 } = {}) {
    if (!this.db) return { ok: true, data: [], total: 0 };
    try {
      const params = [hours, limit];
      const typeFilter = type ? `AND alert_type = $3` : '';
      if (type) params.push(type);

      const { rows } = await this.db.query(`
        SELECT * FROM scanner_alerts
        WHERE  triggered_at >= NOW() - ($1 || ' hours')::interval
        ${typeFilter}
        ORDER  BY triggered_at DESC
        LIMIT  $2
      `, params);

      const { rows: [ct] } = await this.db.query(`
        SELECT COUNT(*) AS total FROM scanner_alerts
        WHERE triggered_at >= NOW() - ($1 || ' hours')::interval
        ${typeFilter}
      `, type ? [hours, type] : [hours]);

      return { ok: true, data: rows, total: parseInt(ct.total) };
    } catch (e) {
      return { ok: false, error: e.message, data: [] };
    }
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  async getStats() {
    if (!this.db) return { ok: true, data: null };
    const cached = await this._redisGet('alerts:stats:v2');
    if (cached) return { ok: true, data: JSON.parse(cached) };
    try {
      const { rows: [row] } = await this.db.query(`
        SELECT
          COUNT(*) FILTER (WHERE alert_type = 'breakout')                      AS total_breakout,
          COUNT(*) FILTER (WHERE alert_type = 'volume')                        AS total_volume,
          COUNT(*) FILTER (WHERE alert_type = 'news')                          AS total_news,
          COUNT(*) FILTER (WHERE triggered_at >= NOW() - INTERVAL '24 hours')  AS last_24h,
          COUNT(*) FILTER (WHERE triggered_at >= NOW() - INTERVAL '1 hour')    AS last_1h,
          COUNT(*) FILTER (WHERE urgency = 'CRITICAL')                         AS critical_count,
          COUNT(*) FILTER (WHERE urgency = 'HIGH')                             AS high_count
        FROM scanner_alerts
      `);
      const data = {
        breakout:  parseInt(row.total_breakout),
        volume:    parseInt(row.total_volume),
        news:      parseInt(row.total_news),
        last24h:   parseInt(row.last_24h),
        last1h:    parseInt(row.last_1h),
        critical:  parseInt(row.critical_count),
        high:      parseInt(row.high_count),
        cacheAge:  {
          breakout: this._lastBreakoutAt ? Math.round((Date.now()-this._lastBreakoutAt)/1000) : null,
          volume:   this._lastVolumeAt   ? Math.round((Date.now()-this._lastVolumeAt)/1000)   : null,
          news:     this._lastNewsAt     ? Math.round((Date.now()-this._lastNewsAt)/1000)     : null,
        },
      };
      await this._redisSet('alerts:stats:v2', 120, JSON.stringify(data));
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

module.exports = AlertsEngine;
