/**
 * MarketDataService — FREE real-time NSE/BSE data
 *
 * Data Sources (ALL FREE, no API keys):
 * 1. Yahoo Finance unofficial API (via query1.finance.yahoo.com)
 *    - Symbols: RELIANCE.NS, ^NSEI, ^INDIAVIX etc.
 *    - Latency: ~15 seconds (delayed quote)
 *    - Rate limit: ~2000 req/hour per IP
 *
 * 2. NSE India website (public endpoints, no key needed)
 *    - Market status, indices, top gainers/losers
 *    - Latency: real-time (same as NSE website)
 *    - Note: NSE blocks non-browser User-Agents — we set correct headers
 *
 * 3. Moneycontrol public API (undocumented, used by their website)
 *    - Used for India VIX and advance/decline
 *
 * FREE Data Providers Comparison:
 * ┌─────────────────┬────────────┬──────────┬─────────────┬──────────────────┐
 * │ Provider        │ Cost       │ Latency  │ NSE Cover   │ Key Required     │
 * ├─────────────────┼────────────┼──────────┼─────────────┼──────────────────┤
 * │ Yahoo Finance   │ FREE       │ 15s      │ Full NSE    │ No               │
 * │ NSE Website     │ FREE       │ Real-time│ Full NSE    │ No (scraping)    │
 * │ Upstox API      │ FREE*      │ 100ms    │ Full NSE    │ Yes (free acct)  │
 * │ Angel One API   │ FREE*      │ 500ms    │ Full NSE    │ Yes (free acct)  │
 * │ Zerodha Kite    │ ₹2,000/mo  │ 100ms    │ Full NSE    │ Yes (paid)       │
 * │ TrueData        │ ₹500/mo    │ 1s       │ Full NSE    │ Yes (paid)       │
 * │ NSE Official    │ ₹50k+/mo   │ Real-time│ Full NSE    │ Yes (enterprise) │
 * └─────────────────┴────────────┴──────────┴─────────────┴──────────────────┘
 * * Free with broker account (recommended upgrade path)
 */

const axios = require('axios');
const { createClient } = require('redis');

// ── NSE Yahoo Finance symbol map ─────────────────────────────────────────────
const SYMBOLS = {
  // Indices
  NIFTY50:   '^NSEI',
  BANKNIFTY: '^NSEBANK',
  MIDCAP150: '^NSEMDCP50',
  SMALLCAP:  '^NSESML',
  SENSEX:    '^BSESN',
  INDIAVIX:  '^INDIAVIX',
  NIFTYIT:   '^CNXIT',
  NIFTYPHARMA: '^CNXPHARMA',
  NIFTYFMCG: '^CNXFMCG',
  NIFTYAUTO: '^CNXAUTO',
  NIFTYMETAL: '^CNXMETAL',
  NIFTYREALTY: '^CNXREALTY',

  // Top NSE stocks
  RELIANCE:    'RELIANCE.NS',
  TCS:         'TCS.NS',
  HDFCBANK:    'HDFCBANK.NS',
  INFY:        'INFY.NS',
  ICICIBANK:   'ICICIBANK.NS',
  HINDUNILVR:  'HINDUNILVR.NS',
  BAJFINANCE:  'BAJFINANCE.NS',
  KOTAKBANK:   'KOTAKBANK.NS',
  LT:          'LT.NS',
  AXISBANK:    'AXISBANK.NS',
  ASIANPAINT:  'ASIANPAINT.NS',
  TITAN:       'TITAN.NS',
  DIXON:       'DIXON.NS',
  POLYCAB:     'POLYCAB.NS',
  TATAELXSI:   'TATAELXSI.NS',
  PERSISTENT:  'PERSISTENT.NS',
  COFORGE:     'COFORGE.NS',
  APOLLOHOSP:  'APOLLOHOSP.NS',
  ASTRAL:      'ASTRAL.NS',
  AUROPHARMA:  'AUROPHARMA.NS',
  CAMS:        'CAMS.NS',
  HCLTECH:     'HCLTECH.NS',
  SUZLON:      'SUZLON.NS',
  GRINDWELL:   'GRINDWELL.NS',
};

// ── Browser-like headers to avoid NSE blocking ───────────────────────────────
const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://www.nseindia.com/',
  'Origin': 'https://www.nseindia.com',
};

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; MarketBot/1.0)',
  'Accept': 'application/json',
};

class MarketDataService {
  constructor(redisClient) {
    this.redis = redisClient;
    this.cacheTTL = parseInt(process.env.YAHOO_FINANCE_CACHE_TTL || '15');
    this.nseSession = null;
    this._initNSESession();
  }

  // ── NSE requires a session cookie first ──────────────────────────────────
  async _initNSESession() {
    try {
      const resp = await axios.get('https://www.nseindia.com/', {
        headers: NSE_HEADERS,
        timeout: 10000,
      });
      const cookies = resp.headers['set-cookie'];
      if (cookies) {
        this.nseSession = cookies.map(c => c.split(';')[0]).join('; ');
      }
    } catch (e) {
      console.warn('[NSE] Session init failed, will retry:', e.message);
    }
    // Refresh session every 30 minutes
    setInterval(() => this._initNSESession(), 30 * 60 * 1000);
  }

  // ── Fetch single Yahoo Finance quote ─────────────────────────────────────
  async fetchYahooQuote(symbol) {
    const cacheKey = `quote:${symbol}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`;
      const resp = await axios.get(url, {
        headers: YAHOO_HEADERS,
        timeout: 8000,
      });

      const result = resp.data?.chart?.result?.[0];
      if (!result) throw new Error('No data returned');

      const meta = result.meta;
      const timestamps = result.timestamp || [];
      const closes = result.indicators?.quote?.[0]?.close || [];
      const volumes = result.indicators?.quote?.[0]?.volume || [];
      const highs = result.indicators?.quote?.[0]?.high || [];
      const lows = result.indicators?.quote?.[0]?.low || [];

      const quote = {
        symbol,
        name: meta.shortName || symbol,
        price: meta.regularMarketPrice,
        previousClose: meta.previousClose || meta.chartPreviousClose,
        open: meta.regularMarketOpen,
        dayHigh: meta.regularMarketDayHigh,
        dayLow: meta.regularMarketDayLow,
        volume: meta.regularMarketVolume,
        change: meta.regularMarketPrice - (meta.previousClose || meta.chartPreviousClose),
        changePct: ((meta.regularMarketPrice - (meta.previousClose || meta.chartPreviousClose)) / (meta.previousClose || meta.chartPreviousClose)) * 100,
        fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
        fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
        currency: meta.currency,
        marketState: meta.marketState,
        // Intraday chart data (for sparkline)
        chartData: timestamps.map((ts, i) => ({
          time: ts,
          close: closes[i],
          volume: volumes[i],
          high: highs[i],
          low: lows[i],
        })).filter(d => d.close != null),
        fetchedAt: Date.now(),
      };

      await this.redis.setEx(cacheKey, this.cacheTTL, JSON.stringify(quote));
      return quote;
    } catch (err) {
      console.error(`[Yahoo] Failed to fetch ${symbol}:`, err.message);
      // Return stale cache if available
      const stale = await this.redis.get(`stale:${cacheKey}`);
      return stale ? JSON.parse(stale) : null;
    }
  }

  // ── Fetch multiple quotes in parallel ────────────────────────────────────
  async fetchMultipleQuotes(symbolKeys) {
    const promises = symbolKeys.map(key => this.fetchYahooQuote(SYMBOLS[key] || key));
    const results = await Promise.allSettled(promises);
    const data = {};
    symbolKeys.forEach((key, i) => {
      if (results[i].status === 'fulfilled' && results[i].value) {
        data[key] = results[i].value;
        // Store as stale backup
        this.redis.setEx(`stale:quote:${SYMBOLS[key] || key}`, 300, JSON.stringify(results[i].value));
      }
    });
    return data;
  }

  // ── Get all indices ───────────────────────────────────────────────────────
  async getIndices() {
    const indexKeys = ['NIFTY50','BANKNIFTY','MIDCAP150','SMALLCAP','SENSEX','INDIAVIX'];
    return this.fetchMultipleQuotes(indexKeys);
  }

  // ── NSE Market Status (actual open/close) ─────────────────────────────────
  async getNSEMarketStatus() {
    const cacheKey = 'nse:marketstatus';
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    try {
      const resp = await axios.get('https://www.nseindia.com/api/marketStatus', {
        headers: { ...NSE_HEADERS, Cookie: this.nseSession || '' },
        timeout: 8000,
      });
      const status = {
        marketState: resp.data?.marketState || 'UNKNOWN',
        tradeDate: resp.data?.tradeDate,
        fetchedAt: Date.now(),
      };
      await this.redis.setEx(cacheKey, 30, JSON.stringify(status));
      return status;
    } catch (e) {
      return { marketState: 'UNKNOWN', fetchedAt: Date.now() };
    }
  }

  // ── NSE Advance/Decline ───────────────────────────────────────────────────
  async getAdvanceDecline() {
    const cacheKey = 'nse:advdec';
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    try {
      const resp = await axios.get('https://www.nseindia.com/api/equity-stockIndices?index=BROAD%20MARKET%20INDICES', {
        headers: { ...NSE_HEADERS, Cookie: this.nseSession || '' },
        timeout: 8000,
      });
      const data = resp.data?.data || [];
      let advances = 0, declines = 0, unchanged = 0;
      data.forEach(s => {
        if (s.pChange > 0) advances++;
        else if (s.pChange < 0) declines++;
        else unchanged++;
      });
      const result = { advances, declines, unchanged, fetchedAt: Date.now() };
      await this.redis.setEx(cacheKey, 30, JSON.stringify(result));
      return result;
    } catch (e) {
      return { advances: 0, declines: 0, unchanged: 0, fetchedAt: Date.now() };
    }
  }

  // ── NSE Top Gainers & Losers ──────────────────────────────────────────────
  async getTopMovers() {
    const cacheKey = 'nse:movers';
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    try {
      const resp = await axios.get('https://www.nseindia.com/api/live-analysis-variations?index=gainers', {
        headers: { ...NSE_HEADERS, Cookie: this.nseSession || '' },
        timeout: 8000,
      });
      const movers = resp.data;
      await this.redis.setEx(cacheKey, 30, JSON.stringify(movers));
      return movers;
    } catch (e) {
      return null;
    }
  }

  // ── NSE 52-week high breakouts ────────────────────────────────────────────
  async get52WeekHighs() {
    const cacheKey = 'nse:52wkhigh';
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    try {
      const resp = await axios.get('https://www.nseindia.com/api/live-analysis-52Week?index=52weekhigh', {
        headers: { ...NSE_HEADERS, Cookie: this.nseSession || '' },
        timeout: 8000,
      });
      const data = resp.data?.data || [];
      await this.redis.setEx(cacheKey, 60, JSON.stringify(data));
      return data;
    } catch (e) {
      return [];
    }
  }

  // ── Sector performance via sector indices ─────────────────────────────────
  async getSectorPerformance() {
    const sectorKeys = ['NIFTYIT','NIFTYPHARMA','NIFTYFMCG','NIFTYAUTO','NIFTYMETAL','NIFTYREALTY'];
    const data = await this.fetchMultipleQuotes(sectorKeys);
    return Object.entries(data).map(([k, v]) => ({
      name: k.replace('NIFTY',''),
      changePct: v?.changePct || 0,
      price: v?.price || 0,
    }));
  }

  // ── Full dashboard snapshot (one call fetches everything) ─────────────────
  async getDashboardSnapshot() {
    const [indices, advDec, marketStatus, sectors, highs] = await Promise.allSettled([
      this.getIndices(),
      this.getAdvanceDecline(),
      this.getNSEMarketStatus(),
      this.getSectorPerformance(),
      this.get52WeekHighs(),
    ]);

    return {
      indices:      indices.status === 'fulfilled' ? indices.value : {},
      advDec:       advDec.status === 'fulfilled' ? advDec.value : {},
      marketStatus: marketStatus.status === 'fulfilled' ? marketStatus.value : {},
      sectors:      sectors.status === 'fulfilled' ? sectors.value : [],
      highs52w:     highs.status === 'fulfilled' ? highs.value : [],
      snapshotAt:   Date.now(),
    };
  }
}

module.exports = MarketDataService;
