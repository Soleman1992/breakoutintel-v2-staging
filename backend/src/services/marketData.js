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
      let adv = 0, dec = 0, unch = 0;
      data.forEach(s => { if (s.pChange > 0) adv++; else if (s.pChange < 0) dec++; else unch++; });
      const result = { advances: adv, declines: dec, unchanged: unch, fetchedAt: Date.now() };
      await this._safeRedisSet(cacheKey, 30, JSON.stringify(result));
      return result;
    } catch (e) {
      return { advances: 0, declines: 0, unchanged: 0, fetchedAt: Date.now() };
    }
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
