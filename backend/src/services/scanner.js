/**
 * ScannerService — Real breakout detection using Yahoo Finance OHLCV data
 * Patterns: VCP, Darvas Box, Stage 2 / RS Leader, Volume Surge, Tight Base
 * Universe: 100 NSE stocks across Large/Mid/Small cap + F&O names
 */

const axios = require('axios');

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
};

// ── 100-stock universe with sector + cap metadata ────────────────────────────
const STOCK_UNIVERSE = [
  // Nifty 50 / Large Cap
  {sym:'RELIANCE.NS',  name:'Reliance Industries', sector:'Energy',      cap:'Large'},
  {sym:'TCS.NS',       name:'TCS',                 sector:'IT',          cap:'Large'},
  {sym:'HDFCBANK.NS',  name:'HDFC Bank',           sector:'Banking',     cap:'Large'},
  {sym:'INFY.NS',      name:'Infosys',             sector:'IT',          cap:'Large'},
  {sym:'ICICIBANK.NS', name:'ICICI Bank',          sector:'Banking',     cap:'Large'},
  {sym:'HINDUNILVR.NS',name:'HUL',                 sector:'FMCG',        cap:'Large'},
  {sym:'ITC.NS',       name:'ITC',                 sector:'FMCG',        cap:'Large'},
  {sym:'SBIN.NS',      name:'SBI',                 sector:'Banking',     cap:'Large'},
  {sym:'BHARTIARTL.NS',name:'Bharti Airtel',       sector:'Telecom',     cap:'Large'},
  {sym:'BAJFINANCE.NS',name:'Bajaj Finance',       sector:'NBFC',        cap:'Large'},
  {sym:'KOTAKBANK.NS', name:'Kotak Mahindra Bank', sector:'Banking',     cap:'Large'},
  {sym:'LT.NS',        name:'Larsen & Toubro',     sector:'Infra',       cap:'Large'},
  {sym:'HCLTECH.NS',   name:'HCL Technologies',    sector:'IT',          cap:'Large'},
  {sym:'WIPRO.NS',     name:'Wipro',               sector:'IT',          cap:'Large'},
  {sym:'ASIANPAINT.NS',name:'Asian Paints',        sector:'Consumer',    cap:'Large'},
  {sym:'AXISBANK.NS',  name:'Axis Bank',           sector:'Banking',     cap:'Large'},
  {sym:'MARUTI.NS',    name:'Maruti Suzuki',       sector:'Auto',        cap:'Large'},
  {sym:'SUNPHARMA.NS', name:'Sun Pharma',          sector:'Pharma',      cap:'Large'},
  {sym:'TITAN.NS',     name:'Titan Company',       sector:'Consumer',    cap:'Large'},
  {sym:'NTPC.NS',      name:'NTPC',                sector:'Power',       cap:'Large'},
  {sym:'ONGC.NS',      name:'ONGC',                sector:'Energy',      cap:'Large'},
  {sym:'TATASTEEL.NS', name:'Tata Steel',          sector:'Metals',      cap:'Large'},
  {sym:'BAJAJFINSV.NS',name:'Bajaj Finserv',       sector:'NBFC',        cap:'Large'},
  {sym:'JSWSTEEL.NS',  name:'JSW Steel',           sector:'Metals',      cap:'Large'},
  {sym:'TECHM.NS',     name:'Tech Mahindra',       sector:'IT',          cap:'Large'},
  {sym:'HEROMOTOCO.NS',name:'Hero MotoCorp',       sector:'Auto',        cap:'Large'},
  {sym:'DRREDDY.NS',   name:'Dr Reddys',           sector:'Pharma',      cap:'Large'},
  {sym:'DIVISLAB.NS',  name:'Divis Labs',          sector:'Pharma',      cap:'Large'},
  {sym:'BAJAJ-AUTO.NS',name:'Bajaj Auto',          sector:'Auto',        cap:'Large'},
  {sym:'CIPLA.NS',     name:'Cipla',               sector:'Pharma',      cap:'Large'},
  // Mid Cap
  {sym:'DIXON.NS',     name:'Dixon Technologies',  sector:'Electronics', cap:'Mid'},
  {sym:'POLYCAB.NS',   name:'Polycab India',       sector:'Cables',      cap:'Mid'},
  {sym:'TATAELXSI.NS', name:'Tata Elxsi',          sector:'IT',          cap:'Mid'},
  {sym:'PERSISTENT.NS',name:'Persistent Systems',  sector:'IT',          cap:'Mid'},
  {sym:'COFORGE.NS',   name:'Coforge',             sector:'IT',          cap:'Mid'},
  {sym:'APOLLOHOSP.NS',name:'Apollo Hospitals',    sector:'Healthcare',  cap:'Mid'},
  {sym:'ASTRAL.NS',    name:'Astral',              sector:'Pipes',       cap:'Mid'},
  {sym:'AUROPHARMA.NS',name:'Aurobindo Pharma',    sector:'Pharma',      cap:'Mid'},
  {sym:'CAMS.NS',      name:'CAMS',                sector:'Fintech',     cap:'Mid'},
  {sym:'GRINDWELL.NS', name:'Grindwell Norton',    sector:'Industrials', cap:'Mid'},
  {sym:'LTIM.NS',      name:'LTIMindtree',         sector:'IT',          cap:'Mid'},
  {sym:'MPHASIS.NS',   name:'Mphasis',             sector:'IT',          cap:'Mid'},
  {sym:'CGPOWER.NS',   name:'CG Power',            sector:'Electrical',  cap:'Mid'},
  {sym:'PIIND.NS',     name:'PI Industries',       sector:'Agrochem',    cap:'Mid'},
  {sym:'SRF.NS',       name:'SRF',                 sector:'Chemicals',   cap:'Mid'},
  {sym:'CHOLAFIN.NS',  name:'Chola Finance',       sector:'NBFC',        cap:'Mid'},
  {sym:'CUMMINSIND.NS',name:'Cummins India',       sector:'Industrials', cap:'Mid'},
  {sym:'DEEPAKNTR.NS', name:'Deepak Nitrite',      sector:'Chemicals',   cap:'Mid'},
  {sym:'IRCTC.NS',     name:'IRCTC',               sector:'Travel',      cap:'Mid'},
  {sym:'LUPIN.NS',     name:'Lupin',               sector:'Pharma',      cap:'Mid'},
  {sym:'MARICO.NS',    name:'Marico',              sector:'FMCG',        cap:'Mid'},
  {sym:'MAXHEALTH.NS', name:'Max Healthcare',      sector:'Healthcare',  cap:'Mid'},
  {sym:'MOTHERSON.NS', name:'Motherson Sumi',      sector:'Auto Ancillary',cap:'Mid'},
  {sym:'MUTHOOTFIN.NS',name:'Muthoot Finance',     sector:'NBFC',        cap:'Mid'},
  {sym:'NAUKRI.NS',    name:'Info Edge',           sector:'Internet',    cap:'Mid'},
  {sym:'OBEROIRLTY.NS',name:'Oberoi Realty',       sector:'Realty',      cap:'Mid'},
  {sym:'PAGEIND.NS',   name:'Page Industries',     sector:'Consumer',    cap:'Mid'},
  {sym:'PHOENIXLTD.NS',name:'Phoenix Mills',       sector:'Realty',      cap:'Mid'},
  {sym:'PRESTIGE.NS',  name:'Prestige Estates',    sector:'Realty',      cap:'Mid'},
  {sym:'KEI.NS',       name:'KEI Industries',      sector:'Cables',      cap:'Mid'},
  {sym:'KPITTECH.NS',  name:'KPIT Technologies',   sector:'IT',          cap:'Mid'},
  // F&O / Liquid names
  {sym:'APOLLOTYRE.NS',name:'Apollo Tyres',        sector:'Auto Ancillary',cap:'Mid'},
  {sym:'ASHOKLEY.NS',  name:'Ashok Leyland',       sector:'Auto',        cap:'Mid'},
  {sym:'BIOCON.NS',    name:'Biocon',              sector:'Pharma',      cap:'Mid'},
  {sym:'BHEL.NS',      name:'BHEL',                sector:'Capital Goods',cap:'Mid'},
  {sym:'BPCL.NS',      name:'BPCL',               sector:'Energy',      cap:'Large'},
  {sym:'CANBK.NS',     name:'Canara Bank',         sector:'Banking',     cap:'Mid'},
  {sym:'CONCOR.NS',    name:'Container Corp',      sector:'Logistics',   cap:'Mid'},
  {sym:'DABUR.NS',     name:'Dabur India',         sector:'FMCG',        cap:'Large'},
  {sym:'DLF.NS',       name:'DLF',                 sector:'Realty',      cap:'Large'},
  {sym:'FEDERALBNK.NS',name:'Federal Bank',        sector:'Banking',     cap:'Mid'},
  {sym:'GAIL.NS',      name:'GAIL',                sector:'Energy',      cap:'Large'},
  {sym:'GODREJPROP.NS',name:'Godrej Properties',   sector:'Realty',      cap:'Mid'},
  {sym:'GRASIM.NS',    name:'Grasim Industries',   sector:'Conglomerate',cap:'Large'},
  {sym:'HAL.NS',       name:'HAL',                 sector:'Defence',     cap:'Large'},
  {sym:'HAVELLS.NS',   name:'Havells India',       sector:'Electrical',  cap:'Large'},
  {sym:'HINDALCO.NS',  name:'Hindalco',            sector:'Metals',      cap:'Large'},
  {sym:'IDFCFIRSTB.NS',name:'IDFC First Bank',     sector:'Banking',     cap:'Mid'},
  {sym:'INDHOTEL.NS',  name:'Indian Hotels',       sector:'Hotels',      cap:'Mid'},
  {sym:'INDIGO.NS',    name:'IndiGo',              sector:'Aviation',    cap:'Large'},
  {sym:'IRFC.NS',      name:'IRFC',                sector:'NBFC',        cap:'Large'},
  {sym:'JUBLFOOD.NS',  name:'Jubilant FoodWorks',  sector:'QSR',         cap:'Mid'},
  {sym:'M&M.NS',       name:'Mahindra & Mahindra', sector:'Auto',        cap:'Large'},
  {sym:'MANAPPURAM.NS',name:'Manappuram Finance',  sector:'NBFC',        cap:'Mid'},
  {sym:'NYKAA.NS',     name:'Nykaa',               sector:'Retail',      cap:'Mid'},
  {sym:'PFC.NS',       name:'Power Finance Corp',  sector:'NBFC',        cap:'Large'},
  {sym:'PNB.NS',       name:'Punjab National Bank',sector:'Banking',     cap:'Mid'},
  {sym:'SAIL.NS',      name:'SAIL',                sector:'Metals',      cap:'Mid'},
  {sym:'SHREECEM.NS',  name:'Shree Cement',        sector:'Cement',      cap:'Large'},
  {sym:'SIEMENS.NS',   name:'Siemens India',       sector:'Capital Goods',cap:'Large'},
  {sym:'TATACOMM.NS',  name:'Tata Communications', sector:'Telecom',     cap:'Mid'},
  {sym:'TATAMOTORS.NS',name:'Tata Motors',         sector:'Auto',        cap:'Large'},
  {sym:'TATAPOWER.NS', name:'Tata Power',          sector:'Power',       cap:'Mid'},
  {sym:'TORNTPHARM.NS',name:'Torrent Pharma',      sector:'Pharma',      cap:'Mid'},
  {sym:'TRENT.NS',     name:'Trent',               sector:'Retail',      cap:'Mid'},
  {sym:'UPL.NS',       name:'UPL',                 sector:'Agrochem',    cap:'Large'},
  {sym:'VEDL.NS',      name:'Vedanta',             sector:'Metals',      cap:'Large'},
  {sym:'ZOMATO.NS',    name:'Zomato',              sector:'Internet',    cap:'Large'},
  {sym:'ZYDUSLIFE.NS', name:'Zydus Lifesciences',  sector:'Pharma',      cap:'Large'},
  // Small Cap
  {sym:'SUZLON.NS',    name:'Suzlon Energy',       sector:'Energy',      cap:'Small'},
  {sym:'APLAPOLLO.NS', name:'APL Apollo Tubes',    sector:'Metals',      cap:'Small'},
  {sym:'CLEANSCIENCE.NS',name:'Clean Science',     sector:'Chemicals',   cap:'Small'},
  {sym:'FINEORG.NS',   name:'Fine Organics',       sector:'Chemicals',   cap:'Small'},
  {sym:'SOLARINDS.NS', name:'Solar Industries',    sector:'Chemicals',   cap:'Small'},
  {sym:'HEG.NS',       name:'HEG',                 sector:'Industrials', cap:'Small'},
  {sym:'LATENTVIEW.NS',name:'Latent View Analytics',sector:'IT',         cap:'Small'},
  {sym:'MASTEK.NS',    name:'Mastek',              sector:'IT',          cap:'Small'},
];

class ScannerService {
  constructor(redisClient) {
    this.redis = redisClient;
    this.lastResults = [];
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
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1y`;
      const resp = await axios.get(url, { headers: YAHOO_HEADERS, timeout: 12000 });
      const result = resp.data?.chart?.result?.[0];
      if (!result) return null;
      const times = result.timestamp || [];
      const q = result.indicators?.quote?.[0] || {};
      const bars = times.map((t, i) => ({
        date:   new Date(t * 1000).toISOString().split('T')[0],
        open:   q.open?.[i],
        high:   q.high?.[i],
        low:    q.low?.[i],
        close:  q.close?.[i],
        volume: q.volume?.[i],
      })).filter(d => d.close != null && d.high != null && d.low != null);
      return bars.length >= 20 ? bars : null;
    } catch (e) { return null; }
  }

  _ema(arr, p) {
    const k = 2 / (p + 1);
    let e = arr[0];
    return arr.map(v => { e = v * k + e * (1 - k); return e; });
  }

  _volRatio(vols, idx, p = 20) {
    if (idx < p) return 1;
    const slice = vols.slice(idx - p, idx).filter(v => v > 0);
    if (!slice.length) return 1;
    const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
    return avg > 0 ? (vols[idx] || 0) / avg : 1;
  }

  _detectVCP(bars) {
    if (bars.length < 50) return null;
    const closes = bars.map(b => b.close);
    const ema50  = this._ema(closes, 50);
    const ema200 = this._ema(closes, Math.min(200, closes.length));
    const last   = closes[closes.length - 1];
    if (last < ema50[ema50.length - 1] || last < ema200[ema200.length - 1]) return null;

    const recent = bars.slice(-30);
    const vols   = recent.map(b => b.volume || 0);
    const avgVol = vols.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
    const recVol = vols.slice(-10).reduce((a, b) => a + b, 0) / 10;
    if (recVol >= avgVol * 0.75) return null; // volume must be drying

    const hi52 = Math.max(...bars.map(b => b.high));
    const proximity = (hi52 - last) / hi52;
    if (proximity >= 0.15) return null;

    // Count contracting pivot highs
    const highs = recent.map(b => b.high);
    let contractions = 0;
    for (let i = 2; i < highs.length; i++) {
      if (highs[i] < highs[i - 2]) contractions++;
    }
    if (contractions < 3) return null;

    let vcpStage = 2;
    if (proximity < 0.03) vcpStage = 4;
    else if (proximity < 0.08) vcpStage = 3;

    const pivotHigh = Math.max(...bars.slice(-5).map(b => b.high));
    return {
      pattern: 'vcp',
      category: vcpStage >= 3 ? 'active' : 'pre',
      vcpStage,
      pivot: Math.round(pivotHigh * 100) / 100,
      volContraction: Math.round((1 - recVol / avgVol) * 100),
    };
  }

  _detectDarvas(bars) {
    if (bars.length < 25) return null;
    const last10 = bars.slice(-10);
    const bH = Math.max(...last10.map(b => b.high));
    const bL = Math.min(...last10.map(b => b.low));
    const boxRange = (bH - bL) / bL * 100;
    const hi52 = Math.max(...bars.map(b => b.high));
    const near52 = (hi52 - bH) / hi52 < 0.1;
    const vr = this._volRatio(bars.map(b => b.volume || 0), bars.length - 1);
    const last = bars[bars.length - 1];
    const prevBoxHigh = Math.max(...bars.slice(-20, -5).map(b => b.high));

    if (last.close > prevBoxHigh && vr > 2.0) {
      return { pattern: 'darvas', category: 'active',
        darvasHigh: Math.round(bH * 100) / 100,
        darvasLow:  Math.round(bL * 100) / 100,
        breakoutLevel: Math.round(prevBoxHigh * 100) / 100,
        volConfirmed: true };
    }
    if (boxRange < 8 && near52 && vr < 1.5) {
      return { pattern: 'darvas', category: 'pre',
        darvasHigh: Math.round(bH * 100) / 100,
        darvasLow:  Math.round(bL * 100) / 100,
        breakoutLevel: Math.round(bH * 1.002 * 100) / 100,
        volConfirmed: false };
    }
    return null;
  }

  _detectVolSurge(bars) {
    if (bars.length < 22) return null;
    const vr = this._volRatio(bars.map(b => b.volume || 0), bars.length - 1);
    if (vr < 2.5) return null;
    const last  = bars[bars.length - 1];
    const hi20  = Math.max(...bars.slice(-21, -1).map(b => b.high));
    const breakout = last.close > hi20;
    if (breakout || vr >= 3.0) {
      return { pattern: 'vol', category: 'active', volRatio: vr };
    }
    return null;
  }

  _detectStage2(bars) {
    if (bars.length < 60) return null;
    const closes  = bars.map(b => b.close);
    const ema200  = this._ema(closes, Math.min(200, closes.length));
    const ema50   = this._ema(closes, 50);
    const last    = closes[closes.length - 1];
    const e200    = ema200[ema200.length - 1];
    const e200_4w = ema200[Math.max(0, ema200.length - 20)];
    const e50     = ema50[ema50.length - 1];
    if (last > e200 && e200 > e200_4w * 1.01 && e50 > e200) {
      return { pattern: 'rs', category: 'mom' };
    }
    return null;
  }

  _detectTight(bars) {
    if (bars.length < 15) return null;
    const last10 = bars.slice(-10);
    const hi  = Math.max(...last10.map(b => b.high));
    const lo  = Math.min(...last10.map(b => b.low));
    const range = (hi - lo) / lo * 100;
    const vr  = this._volRatio(bars.map(b => b.volume || 0), bars.length - 1);
    const closes = bars.map(b => b.close);
    const ema50  = this._ema(closes, 50);
    const last   = closes[closes.length - 1];
    if (range < 5 && vr < 0.8 && last > ema50[ema50.length - 1]) {
      return { pattern: 'tight', category: 'pre' };
    }
    return null;
  }

  _levels(bars, detected) {
    const last  = bars[bars.length - 1];
    const hi20  = Math.max(...bars.slice(-20).map(b => b.high));
    const lo20  = Math.min(...bars.slice(-20).map(b => b.low));
    let entry, stop, t1, t2;

    if (detected.pattern === 'vcp') {
      entry = (detected.pivot || hi20) * 1.002;
      stop  = lo20 * 0.97;
      t1    = entry * 1.15;
      t2    = entry * 1.28;
    } else if (detected.pattern === 'darvas') {
      entry = (detected.breakoutLevel || hi20) * 1.002;
      stop  = (detected.darvasLow || lo20) * 0.97;
      t1    = entry * 1.18;
      t2    = entry * 1.30;
    } else if (detected.pattern === 'vol') {
      entry = last.close * 1.003;
      stop  = last.close * 0.93;
      t1    = entry * 1.12;
      t2    = entry * 1.20;
    } else {
      entry = hi20 * 1.002;
      stop  = lo20 * 0.97;
      t1    = entry * 1.15;
      t2    = entry * 1.25;
    }

    const rr = (t1 - entry) / Math.max(entry - stop, 1);
    const R  = v => Math.round(v * 100) / 100;
    return { entry: R(entry), stop: R(stop), t1: R(t1), t2: R(t2), rr: Math.round(rr * 10) / 10 };
  }

  _rsScore(stockCloses, benchCloses) {
    if (!benchCloses.length || !stockCloses.length) return 50;
    const periods = [63, 126, 189, 252];
    const weights = [2, 1, 1, 1];
    let score = 0, total = 0;
    for (let pi = 0; pi < periods.length; pi++) {
      const p = periods[pi];
      if (stockCloses.length <= p || benchCloses.length <= p) continue;
      const sRet = (stockCloses[stockCloses.length - 1] - stockCloses[stockCloses.length - 1 - p])
                 / stockCloses[stockCloses.length - 1 - p];
      const nRet = (benchCloses[benchCloses.length - 1] - benchCloses[benchCloses.length - 1 - p])
                 / benchCloses[benchCloses.length - 1 - p];
      score += (sRet - nRet) * weights[pi];
      total += weights[pi];
    }
    const raw = total > 0 ? score / total : 0;
    return Math.min(99, Math.max(1, Math.round(50 + raw * 300)));
  }

  _confidence(vr, rs, prox52w, detected) {
    let s = 3;
    if (vr >= 3) s += 3; else if (vr >= 2) s += 2; else if (vr >= 1.5) s += 1;
    if (rs >= 90) s += 3; else if (rs >= 80) s += 2; else if (rs >= 70) s += 1;
    if (prox52w >= 95) s += 2; else if (prox52w >= 85) s += 1;
    if (detected.pattern === 'vcp' && (detected.vcpStage || 0) >= 3) s += 1;
    if (detected.volConfirmed) s += 1;
    return Math.min(10, Math.max(1, s));
  }

  // ── Main scan ───────────────────────────────────────────────────────────────
  async runScan() {
    const cacheKey = 'scanner:results:v4';
    const cached = await this._safeGet(cacheKey);
    if (cached) {
      this.lastResults = JSON.parse(cached);
      return this.lastResults;
    }

    console.log('[Scanner] Starting scan of', STOCK_UNIVERSE.length, 'stocks...');
    const results = [];

    let niftyBars = null;
    try { niftyBars = await this.fetchHistory('^NSEI'); } catch (e) {}
    const niftyCloses = niftyBars?.map(b => b.close) || [];

    const BATCH = 4;
    for (let i = 0; i < STOCK_UNIVERSE.length; i += BATCH) {
      const batch   = STOCK_UNIVERSE.slice(i, i + BATCH);
      const batchData = await Promise.allSettled(batch.map(s => this.fetchHistory(s.sym)));

      for (let j = 0; j < batch.length; j++) {
        const meta = batch[j];
        const bars = batchData[j].status === 'fulfilled' ? batchData[j].value : null;
        if (!bars || bars.length < 20) continue;

        const closes   = bars.map(b => b.close);
        const vols     = bars.map(b => b.volume || 0);
        const last     = bars[bars.length - 1];
        const prev     = bars[bars.length - 2] || last;
        const vr       = Math.round(this._volRatio(vols, bars.length - 1) * 10) / 10;
        const hi52     = Math.max(...bars.map(b => b.high));
        const lo52     = Math.min(...bars.map(b => b.low));
        const prox52w  = Math.round((1 - (hi52 - last.close) / hi52) * 1000) / 10;
        const rs       = this._rsScore(closes, niftyCloses);

        const avgVol20 = vols.slice(-21, -1).filter(v => v > 0);
        const avgVolume = avgVol20.length
          ? Math.round(avgVol20.reduce((a, b) => a + b, 0) / avgVol20.length)
          : 0;

        const detected =
          this._detectVCP(bars)      ||
          this._detectDarvas(bars)   ||
          this._detectVolSurge(bars) ||
          this._detectStage2(bars)   ||
          this._detectTight(bars);
        if (!detected) continue;

        const lvl  = this._levels(bars, detected);
        const conf = this._confidence(vr, rs, prox52w, detected);
        if (conf < 4) continue;

        results.push({
          sym:          meta.sym.replace('.NS', ''),
          name:         meta.name,
          sector:       meta.sector,
          cap:          meta.cap,
          cmp:          Math.round(last.close * 100) / 100,
          chg:          Math.round(((last.close - prev.close) / prev.close) * 10000) / 100,
          vol:          vr,
          avgVolume,
          curVolume:    last.volume || 0,
          rs,
          strat:        detected.pattern,
          cat:          detected.category,
          vcpStage:     detected.vcpStage     || null,
          darvasHigh:   detected.darvasHigh   || null,
          darvasLow:    detected.darvasLow    || null,
          darvasBreakout: detected.breakoutLevel || null,
          volConfirmed: detected.volConfirmed || (vr >= 2.0),
          pivot:        detected.pivot        || null,
          volContraction: detected.volContraction || null,
          hi52w:        Math.round(hi52 * 100) / 100,
          lo52w:        Math.round(lo52 * 100) / 100,
          proximity52w: prox52w,
          ...lvl,
          conf,
          scannedAt:    Date.now(),
        });
      }

      if (i + BATCH < STOCK_UNIVERSE.length) {
        await new Promise(r => setTimeout(r, 900));
      }
    }

    results.sort((a, b) => b.conf - a.conf);
    // No slice — return ALL candidates
    const ttl = Math.floor(parseInt(process.env.SCAN_INTERVAL_MS || '300000') / 1000);
    await this._safeSet(cacheKey, ttl, JSON.stringify(results));
    this.lastResults = results;
    console.log(`[Scanner] Done — ${results.length} signals from ${STOCK_UNIVERSE.length} stocks`);
    return results;
  }

  // ── Derived views (instant, no re-scan) ─────────────────────────────────────

  getByStrategy(strategy) {
    const filters = {
      vcp:    r => r.strat === 'vcp',
      vcp2:   r => r.strat === 'vcp' && r.vcpStage === 2,
      vcp3:   r => r.strat === 'vcp' && r.vcpStage === 3,
      vcp4:   r => r.strat === 'vcp' && r.vcpStage === 4,
      darvas: r => r.strat === 'darvas',
      rs:     r => r.strat === 'rs',
      vol:    r => r.strat === 'vol',
      tight:  r => r.strat === 'tight',
      pre:    r => r.cat === 'pre',
      active: r => r.cat === 'active',
      mom:    r => r.cat === 'mom',
    };
    const fn = filters[strategy];
    return fn ? this.lastResults.filter(fn) : this.lastResults;
  }

  getVolumeAlerts() {
    return this.lastResults
      .filter(r => r.vol >= 2.5)
      .sort((a, b) => b.vol - a.vol)
      .map(r => ({
        sym: r.sym, name: r.name, sector: r.sector, cap: r.cap,
        volRatio:   r.vol,
        avgVolume:  r.avgVolume,
        curVolume:  r.curVolume,
        cmp:        r.cmp,
        chg:        r.chg,
        alertType:  r.vol >= 5 ? 'Extreme Volume (5x+)'
                  : r.vol >= 3 ? 'High Volume (3-5x)'
                  :              'Elevated Volume (2.5-3x)',
        breakoutConfirmed: r.cat === 'active',
        scannedAt:  r.scannedAt,
      }));
  }

  getBreakoutAlerts() {
    return this.lastResults
      .filter(r => r.cat === 'active')
      .sort((a, b) => b.conf - a.conf)
      .map(r => ({
        sym:      r.sym, name: r.name, sector: r.sector,
        alertType: r.strat === 'vcp'    ? `VCP Stage ${r.vcpStage || 2} Breakout`
                 : r.strat === 'darvas' ? 'Darvas Box Breakout'
                 : r.strat === 'vol'    ? 'Volume Surge Breakout'
                 :                        'Stage 2 Breakout',
        entry:    r.entry, stop:     r.stop,
        volRatio: r.vol,   rs:       r.rs,
        conf:     r.conf,  cmp:      r.cmp,
        chg:      r.chg,   volConfirmed: r.volConfirmed,
        scannedAt: r.scannedAt,
      }));
  }

  getRSLeaders() {
    return this.lastResults
      .sort((a, b) => b.rs - a.rs)
      .map((r, i) => ({
        rank:        i + 1,
        sym:         r.sym, name: r.name, sector: r.sector, cap: r.cap,
        rs:          r.rs,  cmp:  r.cmp,  chg:    r.chg,
        proximity52w: r.proximity52w,
        hi52w:       r.hi52w,
        strat:       r.strat, cat: r.cat, conf: r.conf,
      }));
  }
}

module.exports = ScannerService;
