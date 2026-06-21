/**
 * MarketDataService — FREE real-time NSE/BSE data
 * Sources: Yahoo Finance (^NSEI, ^INDIAVIX etc.) + NSE India public API
 * No API keys required. Latency ~15 seconds.
 */

const axios = require('axios');

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
};

const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.nseindia.com/',
};

const INDEX_SYMBOLS = {
  NIFTY50:    '^NSEI',
  BANKNIFTY:  '^NSEBANK',
  MIDCAP150:  '^NSEMDCP50',
  SMALLCAP:   '^CRSLDX',     // Nifty500 — ^NSESML was delisted from Yahoo
  SENSEX:     '^BSESN',
  INDIAVIX:   '^INDIAVIX',
  NIFTYIT:    '^CNXIT',
  NIFTYPHARMA:'^CNXPHARMA',
  NIFTYFMCG:  '^CNXFMCG',
  NIFTYAUTO:  '^CNXAUTO',
  NIFTYMETAL: '^CNXMETAL',
  NIFTYREALTY:'^CNXREALTY',
  NIFTYBANK:  '^CNXPSUBANK', // ^CNXBANK was delisted — use PSU Bank index
};

class MarketDataService {
  constructor(redisClient) {
    this.redis = redisClient;
    this.cacheTTL = parseInt(process.env.YAHOO_FINANCE_CACHE_TTL || '15');
    this.nseSession = null;
    this._initNSESession();
  }

  async _safeRedisGet(key) {
    try {
      if (!this.redis || !this.redis.isReady) return null;
      return await this.redis.get(key);
    } catch (e) { return null; }
  }

  async _safeRedisSet(key, ttl, value) {
    try {
      if (!this.redis || !this.redis.isReady) return;
      await this.redis.setEx(key, ttl, value);
    } catch (e) {}
  }

  async _initNSESession() {
    try {
      const resp = await axios.get('https://www.nseindia.com/', {
        headers: NSE_HEADERS, timeout: 10000,
      });
      const cookies = resp.headers['set-cookie'];
      if (cookies) {
        this.nseSession = cookies.map(c => c.split(';')[0]).join('; ');
      }
    } catch (e) {
      console.warn('[NSE] Session init failed:', e.message);
    }
    setTimeout(() => this._initNSESession(), 30 * 60 * 1000);
  }

  async fetchYahooQuote(symbol) {
    const cacheKey = `quote:${symbol}`;
    const cached = await this._safeRedisGet(cacheKey);
    if (cached) return JSON.parse(cached);

    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=1d`;
      const resp = await axios.get(url, { headers: YAHOO_HEADERS, timeout: 8000 });
      const result = resp.data?.chart?.result?.[0];
      if (!result) throw new Error('No data');

      const meta = result.meta;
      const prev = meta.previousClose || meta.chartPreviousClose || meta.regularMarketPrice;
      const price = meta.regularMarketPrice || prev;
      const closes = result.indicators?.quote?.[0]?.close || [];

      const quote = {
        symbol,
        name: meta.shortName || symbol,
        price,
        previousClose: prev,
        change: price - prev,
        changePct: ((price - prev) / prev) * 100,
        open: meta.regularMarketOpen || prev,
        dayHigh: meta.regularMarketDayHigh || price,
        dayLow: meta.regularMarketDayLow || price,
        volume: meta.regularMarketVolume || 0,
        fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || price,
        fiftyTwoWeekLow: meta.fiftyTwoWeekLow || price,
        marketState: meta.marketState || 'UNKNOWN',
        chartData: closes.filter(c => c != null),
        fetchedAt: Date.now(),
        ok: true,
      };

      await this._safeRedisSet(cacheKey, this.cacheTTL, JSON.stringify(quote));
      return quote;
    } catch (e) {
      if (!e.message.includes('404') && !e.message.includes('403')) {
        console.warn(`[Yahoo] ${symbol}:`, e.message);
      }
      return { symbol, ok: false, error: e.message, price: 0, changePct: 0, chartData: [] };
    }
  }

  async fetchMultiple(symbolKeys) {
    const results = {};
    const promises = symbolKeys.map(async (key) => {
      const yahoo = INDEX_SYMBOLS[key] || key;
      results[key] = await this.fetchYahooQuote(yahoo);
    });
    await Promise.allSettled(promises);
    return results;
  }

  async getIndices() {
    return this.fetchMultiple(['NIFTY50','BANKNIFTY','MIDCAP150','SMALLCAP','SENSEX','INDIAVIX']);
  }

  async getSectorPerformance() {
    const data = await this.fetchMultiple(['NIFTYIT','NIFTYPHARMA','NIFTYFMCG','NIFTYAUTO','NIFTYMETAL','NIFTYREALTY','NIFTYBANK']);
    return Object.entries(data).map(([k, v]) => ({
      name: k.replace('NIFTY',''),
      changePct: v?.changePct || 0,
      price: v?.price || 0,
      ok: v?.ok || false,
    }));
  }

  async getNSEMarketStatus() {
    const cacheKey = 'nse:status';
    const cached = await this._safeRedisGet(cacheKey);
    if (cached) return JSON.parse(cached);
    try {
      const resp = await axios.get('https://www.nseindia.com/api/marketStatus', {
        headers: { ...NSE_HEADERS, Cookie: this.nseSession || '' },
        timeout: 8000,
      });
      const result = { marketState: resp.data?.marketState || 'UNKNOWN', fetchedAt: Date.now() };
      await this._safeRedisSet(cacheKey, 30, JSON.stringify(result));
      return result;
    } catch (e) {
      return { marketState: 'UNKNOWN', fetchedAt: Date.now() };
    }
  }

  async getAdvanceDecline() {
    const cacheKey = 'nse:advdec';
    const cached = await this._safeRedisGet(cacheKey);
    if (cached) return JSON.parse(cached);
    try {
      const resp = await axios.get('https://www.nseindia.com/api/equity-stockIndices?index=BROAD%20MARKET%20INDICES', {
        headers: { ...NSE_HEADERS, Cookie: this.nseSession || '' },
        timeout: 8000,
      });
      const data = resp.data?.data || [];
      if (!data.length) {
        // NSE returned an empty payload — treat as unavailable, not as 0/0
        return { ok: false, advances: null, declines: null, unchanged: null, fetchedAt: Date.now(), error: 'NSE returned empty dataset' };
      }
      let adv = 0, dec = 0, unch = 0;
      data.forEach(s => { if (s.pChange > 0) adv++; else if (s.pChange < 0) dec++; else unch++; });
      const result = { ok: true, advances: adv, declines: dec, unchanged: unch, fetchedAt: Date.now() };
      await this._safeRedisSet(cacheKey, 30, JSON.stringify(result));
      return result;
    } catch (e) {
      // Propagate ok:false — never silently return 0/0 which looks like real data
      console.warn('[NSE] getAdvanceDecline failed:', e.message);
      return { ok: false, advances: null, declines: null, unchanged: null, fetchedAt: Date.now(), error: e.message };
    }
  }

  // ── MARKET HEALTH SCORE ───────────────────────────────────────────────────
  // Deterministic, rule-based scoring. No randomness. No AI.
  //
  // Component weights (total = 100 pts):
  //   Nifty50 changePct      — 30 pts  (primary trend signal)
  //   BankNifty changePct    — 15 pts  (financial sector breadth)
  //   Midcap150 changePct    — 15 pts  (risk appetite / breadth)
  //   India VIX direction    — 20 pts  (fear gauge — inverse)
  //   Advance/Decline ratio  — 20 pts  (market breadth)
  //
  // Scoring per component:
  //   Index changePct:
  //     >= +1.5%  → full pts
  //     >= +0.5%  → 75%
  //     >= 0%     → 50%
  //     >= -0.5%  → 25%
  //     <  -0.5%  → 0
  //   VIX (inverse — lower VIX = healthier):
  //     changePct <= -1%  → full pts (VIX falling = bullish)
  //     changePct <= 0%   → 75%
  //     changePct <= +1%  → 50%
  //     changePct <= +3%  → 25%
  //     >  +3%            → 0
  //   A/D ratio (advances / (advances + declines)):
  //     >= 0.70  → full pts
  //     >= 0.55  → 75%
  //     >= 0.45  → 50%
  //     >= 0.30  → 25%
  //     <  0.30  → 0
  //
  // Label thresholds:
  //   >= 75  → STRONGLY BULLISH
  //   >= 60  → BULLISH
  //   >= 45  → NEUTRAL
  //   >= 30  → BEARISH
  //   <  30  → STRONGLY BEARISH
  async getMarketHealth() {
    const cacheKey = 'market:health';
    const cached = await this._safeRedisGet(cacheKey);
    if (cached) return JSON.parse(cached);

    // Fetch all inputs in parallel
    const [indicesResult, advDecResult] = await Promise.allSettled([
      this.fetchMultiple(['NIFTY50', 'BANKNIFTY', 'MIDCAP150', 'INDIAVIX']),
      this.getAdvanceDecline(),
    ]);

    const indices = indicesResult.status === 'fulfilled' ? indicesResult.value : {};
    const advDec  = advDecResult.status  === 'fulfilled' ? advDecResult.value  : { ok: false };

    // ── Helper: score a single component ──────────────────────────────────
    function scoreIndex(changePct, maxPts) {
      if (changePct == null) return { pts: maxPts * 0.5, available: false }; // neutral if data missing
      if (changePct >= 1.5)  return { pts: maxPts * 1.00, available: true };
      if (changePct >= 0.5)  return { pts: maxPts * 0.75, available: true };
      if (changePct >= 0.0)  return { pts: maxPts * 0.50, available: true };
      if (changePct >= -0.5) return { pts: maxPts * 0.25, available: true };
      return                        { pts: 0,              available: true };
    }

    function scoreVIX(changePct, maxPts) {
      if (changePct == null) return { pts: maxPts * 0.5, available: false };
      if (changePct <= -1.0) return { pts: maxPts * 1.00, available: true };
      if (changePct <=  0.0) return { pts: maxPts * 0.75, available: true };
      if (changePct <=  1.0) return { pts: maxPts * 0.50, available: true };
      if (changePct <=  3.0) return { pts: maxPts * 0.25, available: true };
      return                        { pts: 0,              available: true };
    }

    function scoreAdvDec(advances, declines, maxPts) {
      if (advances == null || declines == null) return { pts: maxPts * 0.5, available: false };
      const total = advances + declines;
      if (total === 0) return { pts: maxPts * 0.5, available: false };
      const ratio = advances / total;
      if (ratio >= 0.70) return { pts: maxPts * 1.00, available: true };
      if (ratio >= 0.55) return { pts: maxPts * 0.75, available: true };
      if (ratio >= 0.45) return { pts: maxPts * 0.50, available: true };
      if (ratio >= 0.30) return { pts: maxPts * 0.25, available: true };
      return                    { pts: 0,              available: true };
    }

    // ── Score each component ───────────────────────────────────────────────
    const n50   = indices['NIFTY50'];
    const bnk   = indices['BANKNIFTY'];
    const mid   = indices['MIDCAP150'];
    const vix   = indices['INDIAVIX'];

    const c_n50  = scoreIndex(n50?.ok  ? n50.changePct  : null, 30);
    const c_bnk  = scoreIndex(bnk?.ok  ? bnk.changePct  : null, 15);
    const c_mid  = scoreIndex(mid?.ok  ? mid.changePct  : null, 15);
    const c_vix  = scoreVIX  (vix?.ok  ? vix.changePct  : null, 20);
    const c_ad   = scoreAdvDec(
      advDec.ok ? advDec.advances : null,
      advDec.ok ? advDec.declines : null,
      20
    );

    const rawScore = c_n50.pts + c_bnk.pts + c_mid.pts + c_vix.pts + c_ad.pts;
    const score    = Math.round(rawScore);

    // ── Label ──────────────────────────────────────────────────────────────
    let label;
    if      (score >= 75) label = 'STRONGLY BULLISH';
    else if (score >= 60) label = 'BULLISH';
    else if (score >= 45) label = 'NEUTRAL';
    else if (score >= 30) label = 'BEARISH';
    else                  label = 'STRONGLY BEARISH';

    // ── dataComplete: true only when all 5 components have live data ───────
    const dataComplete = c_n50.available && c_bnk.available && c_mid.available &&
                         c_vix.available && c_ad.available;

    const result = {
      ok: true,
      score,
      label,
      dataComplete,
      breakdown: {
        nifty50:    { changePct: n50?.ok ? Math.round(n50.changePct * 100) / 100 : null, pts: Math.round(c_n50.pts), maxPts: 30, available: c_n50.available },
        bankNifty:  { changePct: bnk?.ok ? Math.round(bnk.changePct * 100) / 100 : null, pts: Math.round(c_bnk.pts), maxPts: 15, available: c_bnk.available },
        midcap:     { changePct: mid?.ok ? Math.round(mid.changePct * 100) / 100 : null, pts: Math.round(c_mid.pts), maxPts: 15, available: c_mid.available },
        vix:        { changePct: vix?.ok ? Math.round(vix.changePct * 100) / 100 : null, pts: Math.round(c_vix.pts), maxPts: 20, available: c_vix.available },
        advDec:     { advances: advDec.ok ? advDec.advances : null, declines: advDec.ok ? advDec.declines : null, pts: Math.round(c_ad.pts), maxPts: 20, available: c_ad.available },
      },
      fetchedAt: Date.now(),
    };

    // Cache for 15s (matches dashboard refresh cadence)
    await this._safeRedisSet(cacheKey, 15, JSON.stringify(result));
    return result;
  }

  async get52WeekHighs() {
    const cacheKey = 'nse:52wk';
    const cached = await this._safeRedisGet(cacheKey);
    if (cached) return JSON.parse(cached);
    try {
      const resp = await axios.get('https://www.nseindia.com/api/live-analysis-52Week?index=52weekhigh', {
        headers: { ...NSE_HEADERS, Cookie: this.nseSession || '' },
        timeout: 8000,
      });
      const data = resp.data?.data || [];
      await this._safeRedisSet(cacheKey, 60, JSON.stringify(data));
      return data;
    } catch (e) { return []; }
  }

  async getDashboardSnapshot() {
    const [indices, advDec, marketStatus, sectors] = await Promise.allSettled([
      this.getIndices(),
      this.getAdvanceDecline(),
      this.getNSEMarketStatus(),
      this.getSectorPerformance(),
    ]);
    return {
      indices:      indices.status === 'fulfilled' ? indices.value : {},
      advDec:       advDec.status === 'fulfilled' ? advDec.value : {},
      marketStatus: marketStatus.status === 'fulfilled' ? marketStatus.value : {},
      sectors:      sectors.status === 'fulfilled' ? sectors.value : [],
      snapshotAt:   Date.now(),
    };
  }
}

module.exports = MarketDataService;
