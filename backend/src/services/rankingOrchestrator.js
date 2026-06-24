/**
 * rankingOrchestrator.js — Phase 5: The Ranking Pipeline
 *
 * Scheduled job that:
 *   1. Loads stock universe (Nifty 100 + Midcap 150 + Smallcap 250 + Microcap 250 ≈ 750 stocks)
 *   2. Fetches live constituents from NSE API (falls back to hardcoded list)
 *   3. Applies category-specific liquidity + RS filters
 *   4. Fans out 5 engines across eligible stocks in controlled batches
 *   5. Runs consensus engine on each stock's 5 engine results
 *   6. Persists ranked snapshots to PostgreSQL (Supabase) + Redis Sorted Sets
 *   7. Broadcasts tier-change deltas via WebSocket
 *
 * Scheduling (setInterval, no external cron dependency):
 *   EOD scan:    fires once daily at 16:30 IST (full universe, all TFs)
 *   Intraday:    fires every 4H during market hours (4H scores only, fast path)
 *
 * Render free-tier friendly:
 *   - Batch size 5 concurrent (Yahoo Finance rate limit protection)
 *   - 600ms delay between batches
 *   - Redis OHLCV cache absorbs repeat runs within TTL window
 *   - DB writes use upsert; Redis writes are idempotent
 */

'use strict';

const axios  = require('axios');
const { CATEGORIES, FALLBACK_TICKERS, toYahooSymbol, detectCategory } = require('../engines/universeConfig');

// ── Engines ───────────────────────────────────────────────────────────────────
const emaVol    = require('../engines/emaVolEngine');
const lux       = require('../engines/luxAlgoEngine');
const ts        = require('../engines/trendSpiderEngine');
const cp        = require('../engines/chartPrimeEngine');
const aa        = require('../engines/algoAlphaEngine');
const consensus = require('../engines/consensusEngine');

// ── NSE request headers (mirrors MarketDataService) ───────────────────────────
const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.nseindia.com/',
};

// ── Redis key schema ──────────────────────────────────────────────────────────
const REDIS_KEYS = {
  scanMeta:     (runId) => `scan:run:${runId}`,
  scanLatest:   'scan:latest',
  rankAll:      'rankings:all',          // SORTED SET — consensus score
  rankCategory: (cat)  => `rankings:${cat.toLowerCase()}`,
  rankTier:     (tier) => `rankings:tier:${tier}`,
  stockRecord:  (ticker) => `stock:${ticker}:consensus`,
  stockReject:  (ticker) => `stock:${ticker}:rejected`,
};

const SCAN_CONCURRENCY   = 3;    // reduced from 5 — phone RAM protection (Android kills heavy processes)
const BATCH_DELAY_MS     = 1000; // increased from 600ms — gives Yahoo Finance breathing room
const STOCK_RECORD_TTL   = 86400; // 24h — full consensus record per stock
const RANKINGS_TTL       = 86400; // 24h — sorted sets

// IST timezone offset in ms (UTC+5:30)
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

// ── Orchestrator class ────────────────────────────────────────────────────────

class RankingOrchestrator {

  /**
   * @param {Object} marketDataService — instance of MarketDataService (for fetchMTFOHLCV)
   * @param {Object} db               — pg Pool instance (Supabase/PostgreSQL)
   * @param {Object} redisClient      — redis client instance
   * @param {Object} wss              — optional WebSocket server for live deltas
   */
  constructor(marketDataService, db, redisClient, wss = null) {
    this.mds   = marketDataService;
    this.db    = db;
    this.redis = redisClient;
    this.wss   = wss;

    this.isRunning    = false;
    this.lastRunId    = null;
    this.lastRunAt    = null;
    this.schedulerRef = null;

    // NSE session cookies (refreshed every 30 min)
    this.nseSession  = null;
    this._refreshNSESession();
  }

  // ── NSE session ─────────────────────────────────────────────────────────────

  async _refreshNSESession() {
    try {
      const resp = await axios.get('https://www.nseindia.com/', {
        headers: NSE_HEADERS, timeout: 10000,
      });
      const cookies = resp.headers['set-cookie'];
      if (cookies) this.nseSession = cookies.map(c => c.split(';')[0]).join('; ');
    } catch (e) {
      console.warn('[Orchestrator] NSE session refresh failed:', e.message);
    }
    setTimeout(() => this._refreshNSESession(), 30 * 60 * 1000);
  }

  // ── Step 1: Universe loading ─────────────────────────────────────────────────

  /**
   * Load constituents for a single NSE index category.
   * Returns array of { ticker, yahooSymbol, category, sector }.
   */
  async _loadCategoryFromNSE(categoryKey) {
    const cat   = CATEGORIES[categoryKey];
    const index = encodeURIComponent(cat.nseIndex);
    const url   = `https://www.nseindia.com/api/equity-stockIndices?index=${index}`;

    try {
      const resp = await axios.get(url, {
        headers: { ...NSE_HEADERS, Cookie: this.nseSession || '' },
        timeout: 15000,
      });
      const data = resp.data?.data;
      if (!Array.isArray(data) || !data.length) throw new Error('Empty payload');

      return data
        .filter(s => s.symbol && s.symbol !== cat.nseIndex) // exclude the index row itself
        .map(s => ({
          ticker:      s.symbol,
          yahooSymbol: toYahooSymbol(s.symbol),
          category:    categoryKey,
          sector:      s.meta?.industry || 'Unknown',
          lastPrice:   s.lastPrice || 0,
          pChange:     s.pChange   || 0,
          // Approximate ADV from NSE data (totalTradedValue in Lakh → divide by 100 for Cr)
          advEstCr:    (s.totalTradedValue || 0) / 100,
        }));
    } catch (e) {
      console.warn(`[Universe] NSE fetch failed for ${cat.nseIndex}: ${e.message} — using fallback`);
      return null; // signal fallback needed
    }
  }

  /**
   * Load the full universe across all four categories.
   * NSE API is primary; hardcoded FALLBACK_TICKERS used per-category on failure.
   */
  async loadUniverse() {
    console.log('[Universe] Loading stock universe...');
    const universe = [];

    for (const categoryKey of Object.keys(CATEGORIES)) {
      let stocks = await this._loadCategoryFromNSE(categoryKey);

      if (!stocks) {
        // Fallback: use hardcoded tickers for this category
        const fallback = FALLBACK_TICKERS[categoryKey] || [];
        stocks = fallback.map(ticker => ({
          ticker,
          yahooSymbol: toYahooSymbol(ticker),
          category:    categoryKey,
          sector:      'Unknown',
          lastPrice:   0,
          pChange:     0,
          advEstCr:    0,
        }));
        console.log(`[Universe] ${categoryKey}: using ${stocks.length} fallback tickers`);
      } else {
        console.log(`[Universe] ${categoryKey}: ${stocks.length} stocks from NSE`);
      }

      universe.push(...stocks);
    }

    // Deduplicate by ticker (a stock may appear in multiple index responses)
    const seen = new Set();
    const deduped = universe.filter(s => {
      if (seen.has(s.ticker)) return false;
      seen.add(s.ticker);
      return true;
    });

    console.log(`[Universe] Total unique stocks: ${deduped.length}`);
    return deduped;
  }

  // ── Step 2: Universe filters ──────────────────────────────────────────────────

  /**
   * Apply category-specific liquidity filters.
   * Returns { eligible, rejected } where each is an array of stock objects.
   * Stocks from NSE API have advEstCr from today's data.
   * Fallback stocks skip ADV filter (can't estimate without live data).
   */
  applyFilters(stocks) {
    const eligible = [];
    const rejected = [];

    for (const stock of stocks) {
      const cat    = CATEGORIES[stock.category];
      const reason = this._filterReason(stock, cat);

      if (reason) {
        rejected.push({ ...stock, rejectReason: reason });
      } else {
        eligible.push(stock);
      }
    }

    console.log(`[Filter] Eligible: ${eligible.length} | Rejected: ${rejected.length}`);
    return { eligible, rejected };
  }

  _filterReason(stock, cat) {
    // If ADV estimate is available (from NSE live fetch), apply ADV filter
    if (stock.advEstCr > 0 && stock.advEstCr < cat.minADV) {
      return `adv_too_low (est ₹${stock.advEstCr.toFixed(1)} Cr < ₹${cat.minADV} Cr)`;
    }
    // Price sanity (skip stocks under ₹5 — penny stocks / corporate actions)
    if (stock.lastPrice > 0 && stock.lastPrice < 5) {
      return 'price_below_5';
    }
    return null; // eligible
  }

  // ── Step 3: Process a single stock ───────────────────────────────────────────

  async _processStock(stock) {
    const { ticker, yahooSymbol, category } = stock;
    try {
      // Fetch MTF OHLCV (cached by MarketDataService with tiered TTLs)
      const mtfData = await this.mds.fetchMTFOHLCV(ticker);

      // Check data quality — need at least 20 daily bars
      if (!mtfData.D || mtfData.D.length < 20) {
        return { ticker, category, ok: false, rejectReason: 'insufficient_daily_data' };
      }

      // Run all 5 engines
      const engineResults = [
        emaVol.compute(mtfData),
        lux.compute(mtfData),
        ts.compute(mtfData),
        cp.compute(mtfData),
        aa.compute(mtfData),
      ];

      // Run consensus
      const result = consensus.run(engineResults, { ticker });

      return {
        ...result,
        ticker,
        yahooSymbol,
        category,
        sector: stock.sector,
        lastPrice: stock.lastPrice || mtfData.D.at(-1)?.c || 0,
      };
    } catch (e) {
      console.warn(`[Stock] ${ticker} failed:`, e.message);
      return { ticker, category, ok: false, rejectReason: `engine_error: ${e.message}` };
    }
  }

  // ── Step 4: Batch processor ───────────────────────────────────────────────────

  async _runBatch(stocks) {
    const results = [];
    let processed = 0;

    for (let i = 0; i < stocks.length; i += SCAN_CONCURRENCY) {
      const batch   = stocks.slice(i, i + SCAN_CONCURRENCY);
      const settled = await Promise.allSettled(batch.map(s => this._processStock(s)));

      settled.forEach((r, idx) => {
        if (r.status === 'fulfilled') {
          results.push(r.value);
        } else {
          results.push({ ticker: batch[idx].ticker, category: batch[idx].category, ok: false, rejectReason: r.reason?.message || 'unknown' });
        }
      });

      processed += batch.length;
      if (processed % 25 === 0) {
        console.log(`[Orchestrator] Progress: ${processed}/${stocks.length} stocks processed`);
      }

      // Rate limit protection: pause between batches
      if (i + SCAN_CONCURRENCY < stocks.length) {
        await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    return results;
  }

  // ── Step 5: Persist results ───────────────────────────────────────────────────

  async _safeRedisOp(fn) {
    try {
      if (!this.redis?.isReady) return;
      return await fn();
    } catch (e) {
      console.warn('[Redis] Operation failed:', e.message);
    }
  }

  async persistResults(allResults, runId) {
    const accepted = allResults.filter(r => r.ok && !r.rejected);
    const rejected = allResults.filter(r => !r.ok || r.rejected);

    console.log(`[Persist] Accepted: ${accepted.length} | Rejected/failed: ${rejected.length}`);

    // ── Redis Sorted Sets ───────────────────────────────────────────────────
    await this._safeRedisOp(async () => {
      const pipeline = this.redis.multi();

      // Clear previous snapshots
      pipeline.del(REDIS_KEYS.rankAll);
      for (const cat of Object.keys(CATEGORIES)) {
        pipeline.del(REDIS_KEYS.rankCategory(cat));
      }
      for (const tier of ['S', 'A', 'B', 'C']) {
        pipeline.del(REDIS_KEYS.rankTier(tier));
      }
      await pipeline.exec();

      // Write new rankings
      for (const r of accepted) {
        const score  = r.consensusScore;
        const member = r.ticker;
        const record = JSON.stringify(r);

        // All stocks combined set
        await this.redis.zAdd(REDIS_KEYS.rankAll, { score, value: member });

        // Per-category set
        await this.redis.zAdd(REDIS_KEYS.rankCategory(r.category), { score, value: member });

        // Per-tier set
        if (r.tier && r.tier !== 'REJECT') {
          await this.redis.zAdd(REDIS_KEYS.rankTier(r.tier), { score, value: member });
        }

        // Full record per stock (TTL 24h)
        await this.redis.setEx(REDIS_KEYS.stockRecord(r.ticker), STOCK_RECORD_TTL, record);
      }

      // Cache rejected stocks with reason
      for (const r of rejected) {
        if (r.ticker) {
          await this.redis.setEx(
            REDIS_KEYS.stockReject(r.ticker),
            STOCK_RECORD_TTL,
            JSON.stringify({ ticker: r.ticker, category: r.category, rejectReason: r.rejectReason, runId })
          );
        }
      }

      // Run metadata
      const meta = {
        runId,
        completedAt:   Date.now(),
        totalProcessed: allResults.length,
        accepted:      accepted.length,
        rejected:      rejected.length,
        tierCounts: {
          S: accepted.filter(r => r.tier === 'S').length,
          A: accepted.filter(r => r.tier === 'A').length,
          B: accepted.filter(r => r.tier === 'B').length,
          C: accepted.filter(r => r.tier === 'C').length,
        },
      };
      await this.redis.setEx(REDIS_KEYS.scanMeta(runId), STOCK_RECORD_TTL, JSON.stringify(meta));
      await this.redis.set(REDIS_KEYS.scanLatest, JSON.stringify(meta));
    });

    // ── Supabase (pg) persistence ───────────────────────────────────────────
    if (this.db) {
      try {
        // Insert scan_runs FIRST — consensus_results has FK → scan_runs.run_id
        // Previous bug: consensus_results inserted first, causing FK violation
        await this.db.query(`
          INSERT INTO scan_runs (run_id, universe_size, accepted, rejected, tier_counts, completed_at)
          VALUES ($1, $2, $3, $4, $5, NOW())
          ON CONFLICT (run_id) DO NOTHING
        `, [
          runId,
          allResults.length,
          accepted.length,
          rejected.length,
          JSON.stringify({
            S: accepted.filter(r => r.tier === 'S').length,
            A: accepted.filter(r => r.tier === 'A').length,
            B: accepted.filter(r => r.tier === 'B').length,
            C: accepted.filter(r => r.tier === 'C').length,
          }),
        ]);

        // Now safe to insert consensus_results (parent row exists)
        for (const r of accepted) {
          await this.db.query(`
            INSERT INTO consensus_results (
              run_id, ticker, category, sector, last_price,
              consensus_score, tier, direction,
              agreement_pct, confidence_score,
              institutional_prob, trend_continuation_prob,
              breakout_prob, false_bo_risk,
              quality_dims, engine_scores, explain_data,
              created_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
            ON CONFLICT (run_id, ticker)
            DO UPDATE SET
              consensus_score        = EXCLUDED.consensus_score,
              tier                   = EXCLUDED.tier,
              direction              = EXCLUDED.direction,
              agreement_pct          = EXCLUDED.agreement_pct,
              confidence_score       = EXCLUDED.confidence_score,
              institutional_prob     = EXCLUDED.institutional_prob,
              trend_continuation_prob = EXCLUDED.trend_continuation_prob,
              breakout_prob          = EXCLUDED.breakout_prob,
              false_bo_risk          = EXCLUDED.false_bo_risk,
              quality_dims           = EXCLUDED.quality_dims,
              engine_scores          = EXCLUDED.engine_scores,
              explain_data           = EXCLUDED.explain_data
          `, [
            runId,
            r.ticker,
            r.category,
            r.sector || 'Unknown',
            r.lastPrice || 0,
            r.consensusScore,
            r.tier,
            r.direction,
            r.agreementPct,
            r.confidenceScore,
            r.institutionalProb,
            r.trendContinuationProb,
            r.breakoutProb,
            r.falseBORisk,
            JSON.stringify(r.qualityDims   || {}),
            JSON.stringify(r.engines       || {}),
            JSON.stringify(r.explain       || {}),
          ]);
        }
        console.log('[Persist] PostgreSQL upsert complete');
      } catch (e) {
        // Table may not exist yet (Phase 6 migration pending) — non-fatal
        if (e.message?.includes('does not exist')) {
          console.warn('[Persist] DB table not found — run Phase 6 migration. Redis data is live.');
        } else {
          console.warn('[Persist] DB write failed:', e.message);
        }
      }
    }

    // ── WebSocket broadcast — tier changes ─────────────────────────────────
    if (this.wss) {
      try {
        const tierS = accepted.filter(r => r.tier === 'S').map(r => ({
          ticker: r.ticker, category: r.category, score: r.consensusScore, tier: r.tier,
        }));
        const delta = JSON.stringify({ type: 'rankings_update', runId, tierS });
        this.wss.clients?.forEach(client => {
          if (client.readyState === 1) client.send(delta);
        });
      } catch (e) { /* non-fatal */ }
    }

    return accepted;
  }

  // ── Main scan pipeline ────────────────────────────────────────────────────────

  /**
   * Full scan: universe → filter → engines → consensus → persist.
   * @param {Object} opts — { dryRun: bool, categoryFilter: string[] }
   */
  async runScan(opts = {}) {
    if (this.isRunning) {
      console.log('[Orchestrator] Scan already running — skipping');
      return null;
    }

    this.isRunning = true;
    const runId    = `run_${Date.now()}`;
    const started  = Date.now();
    console.log(`[Orchestrator] ── Scan started — runId: ${runId} ──`);

    try {
      // Step 1: Load universe
      let universe = await this.loadUniverse();

      // Optional: restrict to specific categories (e.g. intraday fast-path)
      if (opts.categoryFilter?.length) {
        universe = universe.filter(s => opts.categoryFilter.includes(s.category));
        console.log(`[Orchestrator] Category filter: ${opts.categoryFilter.join(', ')} → ${universe.length} stocks`);
      }

      // Step 2: Apply filters
      const { eligible, rejected: filteredOut } = this.applyFilters(universe);

      if (opts.dryRun) {
        console.log(`[Orchestrator] Dry run — eligible: ${eligible.length}, would process`);
        this.isRunning = false;
        return { dryRun: true, eligible: eligible.length, universe: universe.length };
      }

      // Step 3+4: Process all eligible stocks
      const allResults = await this._runBatch(eligible);

      // Add filtered-out stocks as rejected records
      filteredOut.forEach(s => allResults.push({
        ticker: s.ticker, category: s.category, ok: false, rejectReason: s.rejectReason,
      }));

      // Step 5: Persist
      const accepted = await this.persistResults(allResults, runId);

      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      this.lastRunId = runId;
      this.lastRunAt = Date.now();

      // Summary
      const tiers = { S: 0, A: 0, B: 0, C: 0 };
      accepted.forEach(r => { if (tiers[r.tier] !== undefined) tiers[r.tier]++; });
      console.log(`[Orchestrator] ── Scan complete in ${elapsed}s ──`);
      console.log(`[Orchestrator]    S:${tiers.S} A:${tiers.A} B:${tiers.B} C:${tiers.C} | accepted:${accepted.length}/${eligible.length}`);

      return { runId, elapsed, accepted: accepted.length, eligible: eligible.length, tiers };

    } catch (e) {
      console.error('[Orchestrator] Scan failed:', e.message);
      throw e;
    } finally {
      this.isRunning = false;
    }
  }

  // ── Scheduler ──────────────────────────────────────────────────────────────

  /**
   * Start the scheduler.
   * EOD scan: daily at 16:30 IST (10:00 UTC).
   * Intraday fast-path: every 4H during market hours (03:45–10:00 UTC = 09:15–15:30 IST).
   */
  startScheduler() {
    console.log('[Orchestrator] Scheduler started');

    // Check every minute whether a scan is due
    this.schedulerRef = setInterval(async () => {
      const nowUTC  = new Date();
      const nowIST  = new Date(nowUTC.getTime() + IST_OFFSET_MS);
      const hh      = nowIST.getUTCHours();
      const mm      = nowIST.getUTCMinutes();
      const timeMin = hh * 60 + mm;

      const EOD_TIME     = 16 * 60 + 30; // 16:30 IST
      const MARKET_OPEN  = 9  * 60 + 15; // 09:15 IST
      const MARKET_CLOSE = 15 * 60 + 30; // 15:30 IST

      const inMarketHours = timeMin >= MARKET_OPEN && timeMin <= MARKET_CLOSE;
      const isEOD         = timeMin >= EOD_TIME && timeMin < EOD_TIME + 2; // 2-min window

      // EOD full scan
      if (isEOD) {
        const today = nowIST.toISOString().slice(0, 10);
        if (this.lastRunAt) {
          const lastDate = new Date(this.lastRunAt + IST_OFFSET_MS).toISOString().slice(0, 10);
          if (lastDate === today) return; // already ran today
        }
        console.log('[Scheduler] EOD scan triggered');
        this.runScan().catch(e => console.error('[Scheduler] EOD scan error:', e.message));
        return;
      }

      // Intraday 4H fast-path: only during market hours, every 4H
      if (inMarketHours && this.lastRunAt) {
        const msSinceLast = Date.now() - this.lastRunAt;
        if (msSinceLast >= 4 * 3600 * 1000) {
          console.log('[Scheduler] Intraday 4H refresh triggered');
          this.runScan({ categoryFilter: ['LARGECAP', 'MIDCAP'] })
              .catch(e => console.error('[Scheduler] Intraday error:', e.message));
        }
      }
    }, 60 * 1000); // check every minute
  }

  stopScheduler() {
    if (this.schedulerRef) {
      clearInterval(this.schedulerRef);
      this.schedulerRef = null;
      console.log('[Orchestrator] Scheduler stopped');
    }
  }

  // ── Query helpers (used by API routes in Phase 7) ─────────────────────────

  async getTopRankings(opts = {}) {
    const { category, tier, limit = 50, minScore = 0 } = opts;

    if (!this.redis?.isReady) return [];

    try {
      const key = category ? REDIS_KEYS.rankCategory(category)
                : tier     ? REDIS_KEYS.rankTier(tier)
                :            REDIS_KEYS.rankAll;

      // ZREVRANGEBYSCORE: highest scores first
      const members = await this.redis.zRangeByScoreWithScores(key, minScore, 100, {
        REV: true, LIMIT: { offset: 0, count: limit },
      });

      const results = await Promise.all(
        members.map(async ({ value: ticker }) => {
          const raw = await this.redis.get(REDIS_KEYS.stockRecord(ticker));
          return raw ? JSON.parse(raw) : { ticker };
        })
      );

      return results.filter(Boolean);
    } catch (e) {
      console.warn('[Query] getTopRankings failed:', e.message);
      return [];
    }
  }

  async getStockConsensus(ticker) {
    if (!this.redis?.isReady) return null;
    try {
      const raw = await this.redis.get(REDIS_KEYS.stockRecord(ticker));
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  async getRejects(opts = {}) {
    // Returns cached reject reasons from Redis (for API transparency)
    return [];  // Phase 7 implements the full reject query endpoint
  }

  getStatus() {
    return {
      isRunning:  this.isRunning,
      lastRunId:  this.lastRunId,
      lastRunAt:  this.lastRunAt,
      scheduled:  !!this.schedulerRef,
    };
  }
}

module.exports = RankingOrchestrator;
