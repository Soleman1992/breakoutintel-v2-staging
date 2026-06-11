/**
 * ScannerService — Real breakout detection using Yahoo Finance OHLCV data
 * Patterns: VCP, Darvas Box, Stage 2, Volume Surge, Tight Base
 */

const axios = require('axios');

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; BreakoutScanner/2.0)',
};

const SCAN_UNIVERSE = [
  'RELIANCE.NS','TCS.NS','HDFCBANK.NS','INFY.NS','ICICIBANK.NS',
  'BAJFINANCE.NS','TITAN.NS','DIXON.NS','POLYCAB.NS','TATAELXSI.NS',
  'PERSISTENT.NS','COFORGE.NS','APOLLOHOSP.NS','ASTRAL.NS','AUROPHARMA.NS',
  'CAMS.NS','HCLTECH.NS','SUZLON.NS','GRINDWELL.NS','LTIM.NS',
];

class ScannerService {
  constructor(redisClient) {
    this.redis = redisClient;
  }

  async _safeGet(key) {
    try {
      if (!this.redis || !this.redis.isReady) return null;
      return await this.redis.get(key);
    } catch (e) { return null; }
  }

  async _safeSet(key, ttl, value) {
    try {
      if (!this.redis || !this.redis.isReady) return;
      await this.redis.setEx(key, ttl, value);
    } catch (e) {}
  }

  async fetchHistory(symbol) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=6mo`;
      const resp = await axios.get(url, { headers: YAHOO_HEADERS, timeout: 10000 });
      const result = resp.data?.chart?.result?.[0];
      if (!result) return null;
      const times  = result.timestamp || [];
      const q = result.indicators?.quote?.[0] || {};
      return times.map((t, i) => ({
        date:   new Date(t * 1000).toISOString().split('T')[0],
        open:   q.open?.[i],  high: q.high?.[i],
        low:    q.low?.[i],   close: q.close?.[i],
        volume: q.volume?.[i],
      })).filter(d => d.close != null);
    } catch (e) { return null; }
  }

  _ema(arr, p) {
    const k = 2 / (p + 1); let e = arr[0];
    return arr.map(v => { e = v * k + e * (1 - k); return e; });
  }

  _volRatio(vols, idx, p = 20) {
    if (idx < p) return 1;
    const avg = vols.slice(idx - p, idx).reduce((a, b) => a + (b || 0), 0) / p;
    return avg > 0 ? (vols[idx] || 0) / avg : 1;
  }

  _detectVCP(bars) {
    if (bars.length < 50) return null;
    const closes = bars.map(b => b.close);
    const ema200 = this._ema(closes, 200);
    const ema50  = this._ema(closes, 50);
    const last   = closes[closes.length - 1];
    if (last < ema200[ema200.length - 1] || last < ema50[ema50.length - 1]) return null;
    const recent = bars.slice(-30);
    const vols = recent.map(b => b.volume);
    const avgVol = vols.slice(0, 20).reduce((a, b) => a + (b || 0), 0) / 20;
    const recentVol = vols.slice(-10).reduce((a, b) => a + (b || 0), 0) / 10;
    const volDrying = recentVol < avgVol * 0.75;
    const hi = Math.max(...bars.map(b => b.high));
    const proximity = (hi - last) / hi;
    if (volDrying && proximity < 0.15) {
      return { pattern: 'vcp', category: proximity < 0.05 ? 'active' : 'pre' };
    }
    return null;
  }

  _detectDarvas(bars) {
    if (bars.length < 25) return null;
    const last10 = bars.slice(-10);
    const bH = Math.max(...last10.map(b => b.high));
    const bL = Math.min(...last10.map(b => b.low));
    const boxSize = (bH - bL) / bL * 100;
    const hi52 = Math.max(...bars.map(b => b.high));
    const near52 = (hi52 - bH) / hi52 < 0.1;
    const vr = this._volRatio(bars.map(b => b.volume), bars.length - 1);
    if (boxSize < 8 && near52 && vr < 1.5) return { pattern: 'darvas', category: 'pre' };
    if (bars[bars.length-1].close > Math.max(...bars.slice(-20,-5).map(b=>b.high)) && vr > 2) {
      return { pattern: 'darvas', category: 'active' };
    }
    return null;
  }

  _detectVolSurge(bars) {
    if (bars.length < 22) return null;
    const vr = this._volRatio(bars.map(b => b.volume), bars.length - 1);
    const breakout = bars[bars.length-1].close > Math.max(...bars.slice(-20,-1).map(b=>b.high));
    if (vr >= 2.5 && breakout) return { pattern: 'vol', category: 'active' };
    return null;
  }

  _detectStage2(bars) {
    if (bars.length < 100) return null;
    const closes = bars.map(b => b.close);
    const ema200 = this._ema(closes, 200);
    const last = closes[closes.length - 1];
    const e200 = ema200[ema200.length - 1];
    const e200_prev = ema200[ema200.length - 50];
    if (last > e200 && e200 > e200_prev * 1.02) return { pattern: 'rs', category: 'mom' };
    return null;
  }

  _detectTight(bars) {
    if (bars.length < 15) return null;
    const last10 = bars.slice(-10);
    const hi = Math.max(...last10.map(b => b.high));
    const lo = Math.min(...last10.map(b => b.low));
    const range = (hi - lo) / lo * 100;
    const vr = this._volRatio(bars.map(b => b.volume), bars.length - 1);
    if (range < 5 && vr < 0.8) return { pattern: 'tight', category: 'pre' };
    return null;
  }

  _levels(bars, pattern) {
    const last = bars[bars.length - 1];
    const hi20 = Math.max(...bars.slice(-20).map(b => b.high));
    const lo20 = Math.min(...bars.slice(-20).map(b => b.low));
    let entry = hi20 * 1.002, stop = lo20 * 0.97;
    let t1 = entry * 1.18, t2 = entry * 1.30;
    if (pattern === 'vol') { entry = last.close * 1.005; stop = last.close * 0.93; t1 = entry * 1.15; t2 = entry * 1.22; }
    const rr = (t1 - entry) / (entry - stop);
    return { entry: Math.round(entry*100)/100, stop: Math.round(stop*100)/100, t1: Math.round(t1*100)/100, t2: Math.round(t2*100)/100, rr: Math.round(rr*10)/10 };
  }

  _confidence(vr, rs, proximity) {
    let s = 4;
    if (vr >= 3) s += 2; else if (vr >= 1.5) s += 1;
    if (rs >= 85) s += 2; else if (rs >= 70) s += 1;
    if (proximity >= 90) s += 1;
    return Math.min(10, Math.max(1, s));
  }

  async runScan() {
    const cacheKey = 'scanner:results';
    const cached = await this._safeGet(cacheKey);
    if (cached) return JSON.parse(cached);

    console.log('[Scanner] Starting scan of', SCAN_UNIVERSE.length, 'stocks...');
    const results = [];

    // Fetch Nifty50 for RS calculation
    let niftyBars = null;
    try { niftyBars = await this.fetchHistory('^NSEI'); } catch(e) {}
    const niftyCloses = niftyBars?.map(b => b.close) || [];

    // Batch in groups of 4
    for (let i = 0; i < SCAN_UNIVERSE.length; i += 4) {
      const batch = SCAN_UNIVERSE.slice(i, i + 4);
      const batchData = await Promise.allSettled(batch.map(s => this.fetchHistory(s)));

      for (let j = 0; j < batch.length; j++) {
        const sym = batch[j];
        const bars = batchData[j].status === 'fulfilled' ? batchData[j].value : null;
        if (!bars || bars.length < 20) continue;

        const closes = bars.map(b => b.close);
        const last = bars[bars.length - 1];
        const prev = bars[bars.length - 2] || last;
        const vr = Math.round(this._volRatio(bars.map(b => b.volume), bars.length - 1) * 10) / 10;
        const hi52 = Math.max(...bars.map(b => b.high));
        const prox = (1 - (hi52 - last.close) / hi52) * 100;

        // RS score
        let rs = 50;
        if (niftyCloses.length >= 60 && closes.length >= 60) {
          const sRet = (closes[closes.length-1] - closes[closes.length-61]) / closes[closes.length-61] * 100;
          const nRet = (niftyCloses[niftyCloses.length-1] - niftyCloses[niftyCloses.length-61]) / niftyCloses[niftyCloses.length-61] * 100;
          rs = Math.min(99, Math.max(1, Math.round(sRet - nRet + 50)));
        }

        const detected = this._detectVCP(bars) || this._detectDarvas(bars) || this._detectVolSurge(bars) || this._detectStage2(bars) || this._detectTight(bars);
        if (!detected) continue;

        const lvl = this._levels(bars, detected.pattern);
        const conf = this._confidence(vr, rs, prox);
        if (conf < 4) continue;

        results.push({
          sym: sym.replace('.NS', ''),
          cmp: Math.round(last.close * 100) / 100,
          chg: Math.round(((last.close - prev.close) / prev.close) * 10000) / 100,
          vol: vr, rs,
          strat: detected.pattern,
          cat: detected.category,
          ...lvl, conf,
          proximity52w: Math.round(prox * 10) / 10,
          scannedAt: Date.now(),
        });
      }

      if (i + 4 < SCAN_UNIVERSE.length) await new Promise(r => setTimeout(r, 800));
    }

    results.sort((a, b) => b.conf - a.conf);
    const top = results.slice(0, 25);
    const ttl = Math.floor(parseInt(process.env.SCAN_INTERVAL_MS || '45000') / 1000);
    await this._safeSet(cacheKey, ttl, JSON.stringify(top));
    console.log(`[Scanner] Done — ${top.length} signals`);
    return top;
  }
}

module.exports = ScannerService;
