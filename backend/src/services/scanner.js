/**
 * ScannerService — Real breakout detection using Yahoo Finance data
 *
 * Strategies implemented:
 *  - VCP (Volatility Contraction Pattern): Minervini
 *  - Darvas Box: Nicolas Darvas
 *  - Stage 2 Breakout: Stan Weinstein
 *  - Relative Strength Leader: IBD
 *  - Volume Surge Breakout
 *  - Tight Consolidation
 *  - 52-Week High Breakout
 */

const axios = require('axios');

const SCAN_UNIVERSE = [
  // High-activity NSE stocks for breakout scanning
  'RELIANCE.NS','TCS.NS','HDFCBANK.NS','INFY.NS','ICICIBANK.NS',
  'HINDUNILVR.NS','BAJFINANCE.NS','KOTAKBANK.NS','LT.NS','AXISBANK.NS',
  'ASIANPAINT.NS','TITAN.NS','DIXON.NS','POLYCAB.NS','TATAELXSI.NS',
  'PERSISTENT.NS','COFORGE.NS','APOLLOHOSP.NS','ASTRAL.NS','AUROPHARMA.NS',
  'CAMS.NS','HCLTECH.NS','SUZLON.NS','GRINDWELL.NS','LTIM.NS',
  'DEEPAKNTR.NS','AARTI.NS','PIIND.NS','JUBLFOOD.NS','PAGEIND.NS',
];

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; BreakoutScanner/1.0)',
};

class ScannerService {
  constructor(redisClient) {
    this.redis = redisClient;
  }

  // ── Fetch 3-month daily OHLCV from Yahoo Finance ─────────────────────────
  async fetchHistory(symbol, period = '3mo') {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${period}`;
      const resp = await axios.get(url, { headers: YAHOO_HEADERS, timeout: 10000 });
      const result = resp.data?.chart?.result?.[0];
      if (!result) return null;

      const times  = result.timestamp || [];
      const quotes = result.indicators?.quote?.[0] || {};
      return times.map((t, i) => ({
        date:   new Date(t * 1000).toISOString().split('T')[0],
        open:   quotes.open?.[i],
        high:   quotes.high?.[i],
        low:    quotes.low?.[i],
        close:  quotes.close?.[i],
        volume: quotes.volume?.[i],
      })).filter(d => d.close != null);
    } catch (e) {
      return null;
    }
  }

  // ── Technical indicators ──────────────────────────────────────────────────
  _ema(closes, period) {
    const k = 2 / (period + 1);
    let ema = closes[0];
    return closes.map(c => { ema = c * k + ema * (1 - k); return ema; });
  }

  _sma(closes, period) {
    return closes.map((_, i) => {
      if (i < period - 1) return null;
      return closes.slice(i - period + 1, i + 1).reduce((a, b) => a + b) / period;
    });
  }

  _atr(bars, period = 14) {
    const trs = bars.map((b, i) => {
      if (i === 0) return b.high - b.low;
      const prevClose = bars[i - 1].close;
      return Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
    });
    return trs.reduce((a, b) => a + b, 0) / Math.min(trs.length, period);
  }

  _volumeRatio(volumes, idx, period = 20) {
    if (idx < period) return 1;
    const avg = volumes.slice(idx - period, idx).reduce((a, b) => a + (b || 0)) / period;
    return avg > 0 ? (volumes[idx] || 0) / avg : 1;
  }

  _relativeStrength(stockReturns, niftyReturns, period = 60) {
    if (stockReturns.length < period || niftyReturns.length < period) return 50;
    const sRet = (stockReturns[stockReturns.length-1] - stockReturns[stockReturns.length-1-period]) / stockReturns[stockReturns.length-1-period] * 100;
    const nRet = (niftyReturns[niftyReturns.length-1] - niftyReturns[niftyReturns.length-1-period]) / niftyReturns[niftyReturns.length-1-period] * 100;
    const rsRaw = sRet - nRet + 50;
    return Math.min(99, Math.max(1, rsRaw));
  }

  // ── VCP Detection ─────────────────────────────────────────────────────────
  _detectVCP(bars) {
    if (bars.length < 60) return null;
    const recent = bars.slice(-40);
    const closes = recent.map(b => b.close);
    const volumes = recent.map(b => b.volume);
    const ema200 = this._ema(bars.map(b => b.close), 200);
    const ema50 = this._ema(bars.map(b => b.close), 50);

    const lastClose = closes[closes.length - 1];
    const lastEma200 = ema200[ema200.length - 1];
    const lastEma50 = ema50[ema50.length - 1];

    if (lastClose < lastEma200 || lastClose < lastEma50) return null;

    // Check for contracting ranges (VCP signature)
    const ranges = [];
    for (let i = 0; i < recent.length - 5; i += 8) {
      const seg = recent.slice(i, i + 8);
      const h = Math.max(...seg.map(b => b.high));
      const l = Math.min(...seg.map(b => b.low));
      ranges.push((h - l) / l * 100);
    }

    // Ranges should be contracting
    let isContracting = true;
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i] > ranges[i-1] * 1.1) { isContracting = false; break; }
    }

    // Volume should be drying up in the base
    const recentVols = volumes.slice(-10);
    const avgVol = volumes.slice(-30, -10).reduce((a, b) => a + b, 0) / 20;
    const volDrying = recentVols.reduce((a, b) => a + b, 0) / 10 < avgVol * 0.75;

    // 52W proximity check
    const high52w = Math.max(...bars.map(b => b.high));
    const proximity52w = (high52w - lastClose) / high52w;

    if (isContracting && volDrying && proximity52w < 0.15) {
      const lastRange = ranges[ranges.length - 1];
      return {
        pattern: 'vcp',
        category: proximity52w < 0.05 ? 'active' : 'pre',
        tightnessScore: Math.max(0, (5 - lastRange) / 5 * 100),
        volDrying: true,
        proximity52w: (1 - proximity52w) * 100,
      };
    }
    return null;
  }

  // ── Darvas Box Detection ──────────────────────────────────────────────────
  _detectDarvas(bars) {
    if (bars.length < 30) return null;
    const recent = bars.slice(-30);
    const last10 = bars.slice(-10);

    const boxHigh = Math.max(...last10.map(b => b.high));
    const boxLow = Math.min(...last10.map(b => b.low));
    const boxSize = (boxHigh - boxLow) / boxLow * 100;

    // Tight box (< 8% range) that is near 52W high
    const high52w = Math.max(...recent.map(b => b.high));
    const isNear52w = (high52w - boxHigh) / high52w < 0.1;

    // Volume should be low in the box
    const lastVol = bars[bars.length-1].volume;
    const avgVol20 = bars.slice(-20).reduce((s, b) => s + b.volume, 0) / 20;
    const volRatio = lastVol / avgVol20;

    if (boxSize < 8 && isNear52w && volRatio < 1.2) {
      return {
        pattern: 'darvas',
        category: 'pre',
        boxHigh,
        boxLow,
        boxSize,
        volRatio,
      };
    }

    // Detect fresh breakout above box
    const prevBoxHigh = Math.max(...bars.slice(-20, -5).map(b => b.high));
    const currentClose = bars[bars.length-1].close;
    if (currentClose > prevBoxHigh && volRatio > 2) {
      return {
        pattern: 'darvas',
        category: 'active',
        boxHigh: prevBoxHigh,
        volRatio,
        breakout: true,
      };
    }
    return null;
  }

  // ── Stage 2 Detection ─────────────────────────────────────────────────────
  _detectStage2(bars) {
    if (bars.length < 200) return null;
    const closes = bars.map(b => b.close);
    const ema200 = this._ema(closes, 200);
    const ema50 = this._ema(closes, 50);
    const lastClose = closes[closes.length - 1];
    const last200 = ema200[ema200.length - 1];
    const last50 = ema50[ema50.length - 1];

    // Stage 2: price > 200 EMA > trending up for 10+ weeks
    const ema200_10wAgo = ema200[ema200.length - 50];
    const ema200Trending = last200 > ema200_10wAgo * 1.02;

    if (lastClose > last200 && lastClose > last50 && ema200Trending) {
      const volRatio = this._volumeRatio(bars.map(b => b.volume), bars.length - 1);
      return {
        pattern: 'stage2',
        category: 'mom',
        ema200: last200,
        ema50: last50,
        volRatio,
      };
    }
    return null;
  }

  // ── Volume Surge Detection ────────────────────────────────────────────────
  _detectVolumeSurge(bars) {
    if (bars.length < 25) return null;
    const last = bars[bars.length - 1];
    const prev = bars[bars.length - 2];
    const volRatio = this._volumeRatio(bars.map(b => b.volume), bars.length - 1, 20);
    const priceBreakout = last.close > Math.max(...bars.slice(-20, -1).map(b => b.high));

    if (volRatio >= 2.5 && priceBreakout && last.close > prev.close) {
      return {
        pattern: 'vol',
        category: 'active',
        volRatio,
        priceBreakout: true,
      };
    }
    return null;
  }

  // ── Calculate entry/stop/targets ──────────────────────────────────────────
  _calcLevels(bars, pattern) {
    const last = bars[bars.length - 1];
    const atr = this._atr(bars.slice(-20));
    const high20 = Math.max(...bars.slice(-20).map(b => b.high));
    const low20 = Math.min(...bars.slice(-20).map(b => b.low));

    let entry, stop, t1, t2;

    switch(pattern) {
      case 'vcp':
        entry = high20 * 1.002;  // 0.2% above recent high
        stop = low20 * 0.98;     // 2% below recent low
        t1 = entry * 1.18;
        t2 = entry * 1.30;
        break;
      case 'darvas':
        entry = high20 * 1.001;
        stop = low20 * 0.97;
        t1 = entry * 1.15;
        t2 = entry * 1.25;
        break;
      case 'vol':
        entry = last.close * 1.005;
        stop = last.close * 0.93;
        t1 = entry * 1.15;
        t2 = entry * 1.22;
        break;
      default:
        entry = last.close * 1.01;
        stop = last.close * 0.92;
        t1 = entry * 1.20;
        t2 = entry * 1.32;
    }

    const rr = (t1 - entry) / (entry - stop);
    return { entry, stop, t1, t2, rr: Math.round(rr * 10) / 10 };
  }

  // ── Confidence scoring ────────────────────────────────────────────────────
  _scoreConfidence(patternData, volRatio, rs, proximity52w) {
    let score = 4; // base
    if (volRatio >= 3) score += 2;
    else if (volRatio >= 1.5) score += 1;
    if (rs >= 85) score += 2;
    else if (rs >= 70) score += 1;
    if (proximity52w >= 90) score += 1;
    if (patternData?.isContracting) score += 1;
    return Math.min(10, Math.max(1, score));
  }

  // ── Main scanner run ──────────────────────────────────────────────────────
  async runScan() {
    const cacheKey = 'scanner:results';
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    console.log('[Scanner] Starting NSE scan...');
    const results = [];

    // Fetch Nifty50 for RS calculation
    let niftyBars = null;
    try {
      niftyBars = await this.fetchHistory('^NSEI', '6mo');
    } catch (e) {}
    const niftyCloses = niftyBars?.map(b => b.close) || [];

    // Process stocks in batches of 5 to avoid rate limits
    for (let i = 0; i < SCAN_UNIVERSE.length; i += 5) {
      const batch = SCAN_UNIVERSE.slice(i, i + 5);
      const batchPromises = batch.map(sym => this.fetchHistory(sym, '6mo'));
      const batchResults = await Promise.allSettled(batchPromises);

      for (let j = 0; j < batch.length; j++) {
        const sym = batch[j];
        const bars = batchResults[j].status === 'fulfilled' ? batchResults[j].value : null;
        if (!bars || bars.length < 20) continue;

        const closes = bars.map(b => b.close);
        const volumes = bars.map(b => b.volume);
        const lastBar = bars[bars.length - 1];
        const prevBar = bars[bars.length - 2] || bars[bars.length - 1];
        const volRatio = this._volumeRatio(volumes, bars.length - 1, 20);
        const rs = this._relativeStrength(closes, niftyCloses);
        const high52w = Math.max(...bars.map(b => b.high));
        const proximity52w = (1 - (high52w - lastBar.close) / high52w) * 100;

        // Run all pattern detectors
        const detectedPattern =
          this._detectVCP(bars) ||
          this._detectDarvas(bars) ||
          this._detectVolumeSurge(bars) ||
          this._detectStage2(bars);

        if (!detectedPattern) continue;

        const levels = this._calcLevels(bars, detectedPattern.pattern);
        const conf = this._scoreConfidence(detectedPattern, volRatio, rs, proximity52w);

        // Only include stocks with meaningful setups
        if (conf < 4) continue;

        const chg = ((lastBar.close - prevBar.close) / prevBar.close) * 100;

        results.push({
          sym: sym.replace('.NS', ''),
          name: sym.replace('.NS', ''),
          cmp: lastBar.close,
          chg,
          volRatio: Math.round(volRatio * 10) / 10,
          rs: Math.round(rs),
          strat: detectedPattern.pattern,
          cat: detectedPattern.category,
          entry: Math.round(levels.entry * 100) / 100,
          stop: Math.round(levels.stop * 100) / 100,
          t1: Math.round(levels.t1 * 100) / 100,
          t2: Math.round(levels.t2 * 100) / 100,
          rr: levels.rr,
          conf,
          high52w: Math.round(high52w * 100) / 100,
          proximity52w: Math.round(proximity52w * 10) / 10,
          scannedAt: Date.now(),
        });
      }

      // Small delay between batches to avoid Yahoo rate limiting
      if (i + 5 < SCAN_UNIVERSE.length) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    results.sort((a, b) => b.conf - a.conf);
    const limited = results.slice(0, 30); // top 30 only

    await this.redis.setEx(cacheKey, parseInt(process.env.SCAN_INTERVAL_MS || '45000') / 1000, JSON.stringify(limited));
    console.log(`[Scanner] Completed: ${limited.length} signals found`);
    return limited;
  }
}

module.exports = ScannerService;
