/**
 * ScannerService v6 — Professional NSE Scanner Engine
 * Universe: 346 stocks (Nifty500 + F&O + Midcap + Smallcap + liquid penny), liquidity-filtered
 * Scanners: 18 technical strategies (Yahoo OHLCV) + 5 NSE-data strategies
 *   (Bulk Deal, Block Deal, Delivery Volume, Institutional Accumulation via real NSE bhav copy/deals,
 *    Corporate Announcement Alerts, Market Breadth)
 * Stats: total scanned, matches, duration, last scan time, universe before/after liquidity filter
 */

const axios = require('axios');
const { UNIVERSE, UNIVERSE_MAP, LIQUIDITY_FILTERS, UNIVERSE_STATS } = require('./universe');

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
};

const CACHE_KEY   = 'scanner:results:v5';
const CACHE_KEY_META = 'scanner:meta:v5';
const CACHE_TTL   = parseInt(process.env.SCAN_INTERVAL_MS || '300000') / 1000; // default 5 min

class ScannerService {
  constructor(redisClient, nseDataService = null) {
    this.redis       = redisClient;
    this.nseData     = nseDataService; // NSEDataService instance — may be null
    this.lastResults = [];
    this.scanUniverse = this._applyLiquidityFilter(UNIVERSE);
    this.lastMeta    = {
      totalScanned: 0, totalMatches: 0, duration: 0, lastScanAt: null,
      universeSizeBefore: UNIVERSE.length,
      universeSizeAfter:  this.scanUniverse.length,
      universeStats: UNIVERSE_STATS,
    };
  }

  // ── Liquidity filter ──────────────────────────────────────────────────────
  // Applies UNIVERSE-level liquidity gating before any stock enters the scan.
  // Rules (from universe.js LIQUIDITY_FILTERS):
  //   - Micro/penny stocks need a stock-specific minVolFilter (avg daily volume)
  //   - All other stocks pass the static metadata filter (real-time avg volume
  //     check happens during the scan itself once OHLCV data is available —
  //     see _passesRuntimeLiquidity())
  _applyLiquidityFilter(universe) {
    return universe.filter(s => {
      // Penny / Micro cap stocks must declare a minVolFilter — stocks without
      // one are excluded from the scan universe entirely (too illiquid)
      if (s.cap === 'Micro' && !s.minVolFilter) return false;
      return true;
    });
  }

  // Runtime liquidity check using actual fetched OHLCV (avg 20-day volume)
  // plus optional NSE Bhav Copy turnover (₹ lakhs/day) if available.
  _passesRuntimeLiquidity(meta, avgVol, turnoverLakhs = null) {
    const f = LIQUIDITY_FILTERS;
    if (avgVol < f.excludeBelowVol) return false;

    let volOk;
    if (meta.minVolFilter) volOk = avgVol >= meta.minVolFilter;
    else if (meta.cap === 'Large') volOk = avgVol >= f.minAvgVolLarge;
    else if (meta.cap === 'Mid')   volOk = avgVol >= f.minAvgVolMid;
    else if (meta.cap === 'Small') volOk = avgVol >= f.minAvgVolSmall;
    else if (meta.cap === 'Micro') volOk = avgVol >= f.minAvgVolMicro;
    else volOk = true;
    if (!volOk) return false;

    // Turnover check — only enforced when bhav copy data was available for
    // this scan. If turnoverLakhs is null (NSE unreachable / symbol not in
    // bhav copy), skip this check rather than excluding the stock.
    if (turnoverLakhs != null) {
      let minTurnover;
      if (meta.cap === 'Large') minTurnover = f.minTurnoverLakhsLarge;
      else if (meta.cap === 'Mid')   minTurnover = f.minTurnoverLakhsMid;
      else if (meta.cap === 'Small') minTurnover = f.minTurnoverLakhsSmall;
      else if (meta.cap === 'Micro') minTurnover = f.minTurnoverLakhsMicro;
      if (minTurnover != null && turnoverLakhs < minTurnover) return false;
    }

    return true;
  }

  // ── Redis helpers ──────────────────────────────────────────────────────────
  async _get(key)          { try { return this.redis?.isReady ? await this.redis.get(key) : null; } catch { return null; } }
  async _set(key, ttl, v)  { try { if (this.redis?.isReady) await this.redis.setEx(key, ttl, v); } catch {} }
  async _del(key)          { try { if (this.redis?.isReady) await this.redis.del(key); } catch {} }

  // ── Yahoo Finance fetch ────────────────────────────────────────────────────
  async fetchHistory(symbol) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1y`;
      const { data } = await axios.get(url, { headers: YAHOO_HEADERS, timeout: 12000 });
      const result = data?.chart?.result?.[0];
      if (!result) return null;
      const times = result.timestamp || [];
      const q     = result.indicators?.quote?.[0] || {};
      const bars  = times.map((t, i) => ({
        date:   new Date(t * 1000).toISOString().split('T')[0],
        open:   q.open?.[i],   high: q.high?.[i],
        low:    q.low?.[i],    close: q.close?.[i],
        volume: q.volume?.[i],
      })).filter(d => d.close != null && d.high != null && d.low != null);
      return bars.length >= 30 ? bars : null;
    } catch { return null; }
  }

  // ── Technical helpers ──────────────────────────────────────────────────────
  _ema(arr, p) {
    const k = 2 / (p + 1); let e = arr[0];
    return arr.map(v => { e = v * k + e * (1 - k); return e; });
  }
  _sma(arr, p) {
    return arr.map((_, i) => i < p - 1 ? null : arr.slice(i-p+1, i+1).reduce((a,b)=>a+b,0)/p);
  }
  _std(arr, p) {
    return arr.map((_, i) => {
      if (i < p - 1) return null;
      const sl = arr.slice(i-p+1, i+1);
      const m  = sl.reduce((a,b)=>a+b,0)/p;
      return Math.sqrt(sl.reduce((a,b)=>a+(b-m)**2,0)/p);
    });
  }
  _volRatio(vols, idx, p=20) {
    if (idx < p) return 1;
    const sl  = vols.slice(idx-p, idx).filter(v=>v>0);
    if (!sl.length) return 1;
    const avg = sl.reduce((a,b)=>a+b,0)/sl.length;
    return avg > 0 ? (vols[idx]||0)/avg : 1;
  }
  _avgVol(vols, idx, p=20) {
    const sl = vols.slice(Math.max(0,idx-p), idx).filter(v=>v>0);
    return sl.length ? Math.round(sl.reduce((a,b)=>a+b,0)/sl.length) : 0;
  }
  _rsScore(stockCloses, benchCloses) {
    if (!benchCloses.length || !stockCloses.length) return 50;
    const periods = [63,126,189,252], weights = [2,1,1,1];
    let score=0, total=0;
    for (let pi=0; pi<periods.length; pi++) {
      const p = periods[pi];
      if (stockCloses.length<=p || benchCloses.length<=p) continue;
      const n = stockCloses.length-1;
      const m = benchCloses.length-1;
      const sRet = (stockCloses[n]-stockCloses[n-p])/stockCloses[n-p];
      const nRet = (benchCloses[m]-benchCloses[m-p])/benchCloses[m-p];
      score += (sRet-nRet)*weights[pi]; total += weights[pi];
    }
    const raw = total>0 ? score/total : 0;
    return Math.min(99, Math.max(1, Math.round(50+raw*300)));
  }

  // Price Strength — independent of RS-vs-benchmark. Blends:
  //  60% position within 52-week range (0 = at 52wk low, 100 = at 52wk high)
  //  40% distance above/below 200-day EMA (±20% maps to 0-100, clamped)
  // Normalized to 1-99. Two stocks can have the same RS but different price
  // strength — e.g. one is near its 52wk high, the other recovering from a dip.
  _priceStrength(bars, closes) {
    const last = closes[closes.length-1];
    const hi52 = Math.max(...bars.map(b=>b.high));
    const lo52 = Math.min(...bars.map(b=>b.low));
    const rangePos = hi52 > lo52 ? ((last-lo52)/(hi52-lo52))*100 : 50;

    const ema200 = this._ema(closes, Math.min(200, closes.length));
    const e200 = ema200[ema200.length-1];
    const distPct = e200>0 ? ((last-e200)/e200)*100 : 0;
    const distScore = Math.min(100, Math.max(0, 50 + distPct*2.5)); // ±20% -> 0-100

    const blended = rangePos*0.6 + distScore*0.4;
    return Math.min(99, Math.max(1, Math.round(blended)));
  }
  _round(v, d=2) { return Math.round(v*(10**d))/(10**d); }

  // ── Entry / exit levels ────────────────────────────────────────────────────
  _levels(bars, pattern, extra={}) {
    const last  = bars[bars.length-1];
    const hi20  = Math.max(...bars.slice(-20).map(b=>b.high));
    const lo20  = Math.min(...bars.slice(-20).map(b=>b.low));
    let entry, stop, t1, t2;
    if (pattern==='vcp'||pattern==='tight'||pattern==='ema_comp'||pattern==='early') {
      entry = (extra.pivot||hi20)*1.002; stop=lo20*0.97; t1=entry*1.15; t2=entry*1.28;
    } else if (pattern==='darvas') {
      entry=(extra.breakoutLevel||hi20)*1.002; stop=(extra.darvasLow||lo20)*0.97; t1=entry*1.18; t2=entry*1.30;
    } else if (pattern==='vol'||pattern==='vol_shock'||pattern==='rel_vol'||pattern==='pp') {
      entry=last.close*1.003; stop=last.close*0.93; t1=entry*1.12; t2=entry*1.20;
    } else if (pattern==='52wkhi') {
      entry=hi20*1.001; stop=hi20*0.95; t1=entry*1.10; t2=entry*1.18;
    } else if (pattern==='gap') {
      entry=last.close*1.002; stop=last.open*0.97; t1=entry*1.12; t2=entry*1.22;
    } else if (pattern==='momentum'||pattern==='mom_ignite') {
      entry=last.close*1.005; stop=last.close*0.92; t1=entry*1.15; t2=entry*1.25;
    } else {
      entry=hi20*1.002; stop=lo20*0.97; t1=entry*1.15; t2=entry*1.25;
    }
    const rr=(t1-entry)/Math.max(entry-stop,1);
    const R=v=>this._round(v);
    return { entry:R(entry), stop:R(stop), t1:R(t1), t2:R(t2), rr:this._round(rr,1) };
  }

  // ── Confidence scoring ─────────────────────────────────────────────────────
  _confidence(vr, rs, prox52w, extra={}) {
    let s=3;
    if (vr>=4) s+=4; else if (vr>=3) s+=3; else if (vr>=2) s+=2; else if (vr>=1.5) s+=1;
    if (rs>=90) s+=3; else if (rs>=80) s+=2; else if (rs>=70) s+=1;
    if (prox52w>=97) s+=3; else if (prox52w>=92) s+=2; else if (prox52w>=85) s+=1;
    if (extra.volConfirmed) s+=1;
    if (extra.vcpStage>=3)  s+=1;
    if (extra.minerviniPass) s+=2;
    return Math.min(10, Math.max(1, s));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DETECTION METHODS (return null or { pattern, category, ...extras })
  // ══════════════════════════════════════════════════════════════════════════

  _detectVCP(bars) {
    if (bars.length<50) return null;
    const closes=bars.map(b=>b.close);
    const ema50=this._ema(closes,50);
    const ema200=this._ema(closes,Math.min(200,closes.length));
    const last=closes[closes.length-1];
    if (last<ema50[ema50.length-1]||last<ema200[ema200.length-1]) return null;
    const r30=bars.slice(-30), v=r30.map(b=>b.volume||0);
    const avgV=v.slice(0,20).reduce((a,b)=>a+b,0)/20;
    const recV=v.slice(-10).reduce((a,b)=>a+b,0)/10;
    if (recV>=avgV*0.75) return null;
    const hi52=Math.max(...bars.map(b=>b.high));
    const prox=(hi52-last)/hi52;
    if (prox>=0.15) return null;
    const highs=r30.map(b=>b.high);
    let contractions=0;
    for (let i=2;i<highs.length;i++) if (highs[i]<highs[i-2]) contractions++;
    if (contractions<3) return null;
    let vcpStage=2;
    if (prox<0.03) vcpStage=4; else if (prox<0.08) vcpStage=3;
    const pivot=Math.max(...bars.slice(-5).map(b=>b.high));
    return { pattern:'vcp', category:vcpStage>=3?'active':'pre', vcpStage,
      pivot:this._round(pivot), volContraction:this._round((1-recV/avgV)*100), stratName:'VCP Scanner' };
  }

  _detectDarvas(bars) {
    if (bars.length<25) return null;
    const l10=bars.slice(-10);
    const bH=Math.max(...l10.map(b=>b.high)), bL=Math.min(...l10.map(b=>b.low));
    const hi52=Math.max(...bars.map(b=>b.high));
    const near52=(hi52-bH)/hi52<0.1;
    const vr=this._volRatio(bars.map(b=>b.volume||0),bars.length-1);
    const last=bars[bars.length-1];
    const prevHi=Math.max(...bars.slice(-20,-5).map(b=>b.high));
    if (last.close>prevHi&&vr>2.0)
      return { pattern:'darvas', category:'active', darvasHigh:this._round(bH),
        darvasLow:this._round(bL), breakoutLevel:this._round(prevHi), volConfirmed:true, stratName:'Darvas Scanner' };
    if ((bH-bL)/bL*100<8&&near52&&vr<1.5)
      return { pattern:'darvas', category:'pre', darvasHigh:this._round(bH),
        darvasLow:this._round(bL), breakoutLevel:this._round(bH*1.002), volConfirmed:false, stratName:'Darvas Scanner' };
    return null;
  }

  _detectVolSurge(bars) {
    if (bars.length<22) return null;
    const vols=bars.map(b=>b.volume||0);
    const vr=this._volRatio(vols,bars.length-1);
    if (vr<2.5) return null;
    const last=bars[bars.length-1];
    const hi20=Math.max(...bars.slice(-21,-1).map(b=>b.high));
    if (last.close>hi20||vr>=3.0)
      return { pattern:'vol', category:'active', stratName:'Volume Surge' };
    return null;
  }

  _detectStage2(bars) {
    if (bars.length<60) return null;
    const closes=bars.map(b=>b.close);
    const ema200=this._ema(closes,Math.min(200,closes.length));
    const ema50=this._ema(closes,50);
    const last=closes[closes.length-1];
    const e200=ema200[ema200.length-1];
    const e200_4w=ema200[Math.max(0,ema200.length-20)];
    const e50=ema50[ema50.length-1];
    if (last>e200&&e200>e200_4w*1.01&&e50>e200)
      return { pattern:'rs', category:'mom', stratName:'Stage 2 Base' };
    return null;
  }

  _detectTight(bars) {
    if (bars.length<15) return null;
    const l10=bars.slice(-10);
    const hi=Math.max(...l10.map(b=>b.high)), lo=Math.min(...l10.map(b=>b.low));
    const range=(hi-lo)/lo*100;
    const vr=this._volRatio(bars.map(b=>b.volume||0),bars.length-1);
    const closes=bars.map(b=>b.close);
    const ema50=this._ema(closes,50);
    const last=closes[closes.length-1];
    if (range<5&&vr<0.8&&last>ema50[ema50.length-1])
      return { pattern:'tight', category:'pre', rangePercent:this._round(range), stratName:'Tight Consolidation' };
    return null;
  }

  _detectPocketPivot(bars) {
    if (bars.length<12) return null;
    const last=bars[bars.length-1];
    const prev10=bars.slice(-11,-1);
    const vols=prev10.map(b=>b.volume||0);
    const maxDownVol=Math.max(...prev10.filter((_,i)=>bars[bars.length-11+i].close<bars[bars.length-10+i].close).map(b=>b.volume||0),0);
    const lastVol=last.volume||0;
    if (lastVol<=maxDownVol) return null;
    const closes=bars.map(b=>b.close);
    const ema10=this._ema(closes,10);
    const ema50=this._ema(closes,50);
    const lastClose=closes[closes.length-1];
    if (lastClose<ema10[ema10.length-1]||lastClose<ema50[ema50.length-1]) return null;
    const vr=lastVol/Math.max(1,...vols);
    if (vr<1.0) return null;
    return { pattern:'pp', category:'active', stratName:'Pocket Pivot' };
  }

  _detect52wkHigh(bars) {
    if (bars.length<52) return null;
    const last=bars[bars.length-1];
    const hi52=Math.max(...bars.map(b=>b.high));
    const prox=(hi52-last.close)/hi52;
    const vr=this._volRatio(bars.map(b=>b.volume||0),bars.length-1);
    if (prox<=0.02&&vr>=1.5)
      return { pattern:'52wkhi', category:'active', proximity52w:this._round((1-prox)*100), stratName:'52-Week High Breakout' };
    return null;
  }

  _detectVolShock(bars) {
    if (bars.length<22) return null;
    const vols=bars.map(b=>b.volume||0);
    const vr=this._volRatio(vols,bars.length-1);
    const last=bars[bars.length-1];
    const prev=bars[bars.length-2];
    const chgPct=((last.close-prev.close)/prev.close)*100;
    if (vr>=5.0&&Math.abs(chgPct)>=2)
      return { pattern:'vol_shock', category:'active', volSpike:this._round(vr), stratName:'Volume Shock' };
    return null;
  }

  _detectMinervini(bars, rs) {
    // Minervini Trend Template: 8 conditions
    if (bars.length<200) return null;
    const closes=bars.map(b=>b.close);
    const last=closes[closes.length-1];
    const ema50=this._ema(closes,50);
    const ema150=this._ema(closes,150);
    const ema200=this._ema(closes,200);
    const e50=ema50[ema50.length-1];
    const e150=ema150[ema150.length-1];
    const e200=ema200[ema200.length-1];
    const e200_1m=ema200[ema200.length-22];
    const hi52=Math.max(...bars.map(b=>b.high));
    const lo52=Math.min(...bars.map(b=>b.low));
    const conds = [
      last>e150&&last>e200,              // 1. above 150 & 200 EMA
      e150>e200,                         // 2. 150 EMA above 200 EMA
      e200>e200_1m,                      // 3. 200 EMA trending up
      e50>e150&&e50>e200,                // 4. 50 EMA above 150 & 200
      last>e50,                          // 5. price above 50 EMA
      last>=(lo52*1.25),                 // 6. at least 25% above 52wk low
      last>=(hi52*0.75),                 // 7. within 25% of 52wk high
      rs>=70,                            // 8. RS rating >= 70 (vs Nifty 50, weighted 3/6/9/12mo)
    ];
    const passed=conds.filter(Boolean).length;
    if (passed>=7)
      return { pattern:'minervini', category:passed===8?'active':'pre', minerviniScore:passed, minerviniPass:true, stratName:'Minervini Trend Template' };
    return null;
  }

  // NOTE: _detectInstitutional (volume-pattern proxy) and _detectDeliverySpike
  // (price+volume proxy) were removed from the technical scan. These signals
  // are now sourced exclusively from real NSE data:
  //   - Institutional Accumulation -> getInstitutionalAccumulationReal()
  //     (NSE Bulk Deals BUY-side + Bhav Copy delivery% >= 50)
  //   - Delivery Volume Spike       -> getDeliveryVolumeScanner()
  //     (NSE Bhav Copy delivery% >= 60)
  // See "NSE-BACKED SCANNERS" section below.

  _detectEMACompression(bars) {
    if (bars.length<50) return null;
    const closes=bars.map(b=>b.close);
    const ema8=this._ema(closes,8);
    const ema21=this._ema(closes,21);
    const ema50=this._ema(closes,50);
    const n=closes.length-1;
    const e8=ema8[n], e21=ema21[n], e50=ema50[n], last=closes[n];
    const gap=Math.abs(e8-e21)/e50*100;
    const gap2=Math.abs(e21-e50)/e50*100;
    if (gap<1.5&&gap2<2.0&&last>e50&&last>e21&&last>e8)
      return { pattern:'ema_comp', category:'pre', emaGap:this._round(gap), stratName:'EMA Compression' };
    return null;
  }

  _detectGapUp(bars) {
    if (bars.length<5) return null;
    const last=bars[bars.length-1];
    const prev=bars[bars.length-2];
    const gapPct=(last.open-prev.close)/prev.close*100;
    const vols=bars.map(b=>b.volume||0);
    const vr=this._volRatio(vols,bars.length-1);
    if (gapPct>=1.5&&last.close>last.open*0.995&&vr>=1.5)
      return { pattern:'gap', category:'active', gapPct:this._round(gapPct), stratName:'Gap-Up Strength' };
    return null;
  }

  _detectMomentum(bars) {
    if (bars.length<65) return null;
    const closes=bars.map(b=>b.close);
    const last=closes[closes.length-1];
    const ret1m=(last-closes[closes.length-22])/closes[closes.length-22]*100;
    const ret3m=(last-closes[closes.length-65])/closes[closes.length-65]*100;
    const ema20=this._ema(closes,20);
    const ema50=this._ema(closes,50);
    const e20=ema20[ema20.length-1], e50=ema50[ema50.length-1];
    if (ret1m>=5&&ret3m>=15&&last>e20&&last>e50&&e20>e50)
      return { pattern:'momentum', category:'mom', ret1m:this._round(ret1m), ret3m:this._round(ret3m), stratName:'High Momentum' };
    return null;
  }

  _detectRelVol(bars) {
    if (bars.length<22) return null;
    const vols=bars.map(b=>b.volume||0);
    const vr=this._volRatio(vols,bars.length-1);
    const last=bars[bars.length-1];
    const closes=bars.map(b=>b.close);
    const ema50=this._ema(closes,50);
    if (vr>=2.0&&last.close>ema50[ema50.length-1])
      return { pattern:'rel_vol', category:vr>=3?'active':'pre', relVol:this._round(vr), stratName:'Relative Volume Breakout' };
    return null;
  }

  _detectEarlyBreakout(bars) {
    // Stock near pivot, volume picking up, not yet broken out
    if (bars.length<30) return null;
    const closes=bars.map(b=>b.close);
    const vols=bars.map(b=>b.volume||0);
    const hi20=Math.max(...bars.slice(-20).map(b=>b.high));
    const last=closes[closes.length-1];
    const prox=(hi20-last)/hi20;
    const vr=this._volRatio(vols,bars.length-1);
    const ema50=this._ema(closes,50);
    if (prox>0&&prox<=0.03&&vr>=1.3&&vr<2.5&&last>ema50[ema50.length-1])
      return { pattern:'early', category:'pre', distFromPivot:this._round(prox*100), stratName:'Early Breakout Candidate' };
    return null;
  }

  _detectMomentumIgnition(bars) {
    if (bars.length<10) return null;
    const last3=bars.slice(-3);
    const closes=bars.map(b=>b.close);
    const vols=bars.map(b=>b.volume||0);
    const allUpStrong=last3.every((b,i)=>
      i===0||(b.close>last3[i-1].close&&(b.close-b.open)/b.open>0.005));
    const vr=this._volRatio(vols,bars.length-1);
    const ema20=this._ema(closes,20);
    const last=closes[closes.length-1];
    if (allUpStrong&&vr>=2.5&&last>ema20[ema20.length-1])
      return { pattern:'mom_ignite', category:'active', stratName:'Momentum Ignition' };
    return null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MAIN SCAN
  // ══════════════════════════════════════════════════════════════════════════
  async runScan() {
    const cached = await this._get(CACHE_KEY);
    const cachedMeta = await this._get(CACHE_KEY_META);
    if (cached) {
      this.lastResults = JSON.parse(cached);
      if (cachedMeta) this.lastMeta = JSON.parse(cachedMeta);
      return this.lastResults;
    }

    const startTime = Date.now();
    console.log(`[Scanner] Starting full scan — ${this.scanUniverse.length} stocks (liquidity-filtered from ${UNIVERSE.length})`);
    const results = [];
    let scanned = 0;

    // Fetch benchmark (Nifty 50)
    let niftyCloses = [];
    try {
      const nb = await this.fetchHistory('^NSEI');
      if (nb) niftyCloses = nb.map(b=>b.close);
    } catch {}

    // Fetch NSE Bhav Copy turnover map once (₹ lakhs/day per symbol).
    // If NSE is unreachable, turnoverMap stays empty and the turnover
    // liquidity check is skipped for all stocks (see _passesRuntimeLiquidity).
    let turnoverMap = {};
    if (this.nseData) {
      try {
        const bhav = await this.nseData.getBhavCopy();
        if (bhav.ok) {
          bhav.data.forEach(r => { turnoverMap[r.sym] = r.tradedValue; });
          console.log(`[Scanner] Bhav Copy turnover loaded for ${Object.keys(turnoverMap).length} symbols`);
        } else {
          console.log(`[Scanner] Bhav Copy unavailable (${bhav.error}) — turnover filter skipped`);
        }
      } catch (e) {
        console.log(`[Scanner] Bhav Copy fetch error: ${e.message} — turnover filter skipped`);
      }
    }

    // Run in batches of 5, 800ms between batches
    const BATCH = 5;
    for (let i=0; i<this.scanUniverse.length; i+=BATCH) {
      const batch = this.scanUniverse.slice(i, i+BATCH);
      const fetched = await Promise.allSettled(batch.map(s=>this.fetchHistory(s.sym)));

      for (let j=0; j<batch.length; j++) {
        const stockMeta = batch[j];
        const bars = fetched[j].status==='fulfilled' ? fetched[j].value : null;
        scanned++;
        if (!bars||bars.length<30) continue;

        const closes  = bars.map(b=>b.close);
        const vols    = bars.map(b=>b.volume||0);
        const last    = bars[bars.length-1];
        const prev    = bars[bars.length-2]||last;
        const vr      = this._round(this._volRatio(vols, bars.length-1), 1);
        const hi52    = Math.max(...bars.map(b=>b.high));
        const lo52    = Math.min(...bars.map(b=>b.low));
        const prox52w = this._round((1-(hi52-last.close)/hi52)*100, 1);
        const rs      = this._rsScore(closes, niftyCloses);
        const priceStrength = this._priceStrength(bars, closes);
        const avgVol  = this._avgVol(vols, bars.length-1);

        // Liquidity gate — exclude illiquid stocks even if a pattern matches
        const turnoverLakhs = turnoverMap[stockMeta.sym.replace('.NS','')] ?? null;
        if (!this._passesRuntimeLiquidity(stockMeta, avgVol, turnoverLakhs)) continue;

        // Run ALL detectors — collect every signal (a stock can match multiple)
        const detectors = [
          ()=>this._detectVCP(bars),
          ()=>this._detectDarvas(bars),
          ()=>this._detectVolSurge(bars),
          ()=>this._detectStage2(bars),
          ()=>this._detectTight(bars),
          ()=>this._detectPocketPivot(bars),
          ()=>this._detect52wkHigh(bars),
          ()=>this._detectVolShock(bars),
          ()=>this._detectMinervini(bars, rs),
          ()=>this._detectEMACompression(bars),
          ()=>this._detectGapUp(bars),
          ()=>this._detectMomentum(bars),
          ()=>this._detectRelVol(bars),
          ()=>this._detectEarlyBreakout(bars),
          ()=>this._detectMomentumIgnition(bars),
        ];

        // Take first match to avoid duplicate entries per stock
        let detected = null;
        for (const fn of detectors) {
          detected = fn();
          if (detected) break;
        }
        if (!detected) continue;

        const lvl  = this._levels(bars, detected.pattern, detected);
        const conf = this._confidence(vr, rs, prox52w, detected);
        if (conf < 4) continue;

        results.push({
          sym:          stockMeta.sym.replace('.NS',''),
          name:         stockMeta.name,
          sector:       stockMeta.sector,
          industry:     stockMeta.industry,
          cap:          stockMeta.cap,
          foStock:      stockMeta.foStock,
          cmp:          this._round(last.close),
          chg:          this._round(((last.close-prev.close)/prev.close)*100),
          vol:          vr,
          avgVolume:    avgVol,
          curVolume:    last.volume||0,
          turnoverLakhs: turnoverLakhs,
          rs,
          priceStrength,
          strat:        detected.pattern,
          stratName:    detected.stratName||detected.pattern,
          cat:          detected.category,
          vcpStage:     detected.vcpStage||null,
          minerviniScore:detected.minerviniScore||null,
          darvasHigh:   detected.darvasHigh||null,
          darvasLow:    detected.darvasLow||null,
          darvasBreakout:detected.breakoutLevel||null,
          volConfirmed: detected.volConfirmed||(vr>=2.0)||false,
          pivot:        detected.pivot||null,
          volContraction:detected.volContraction||null,
          ret1m:        detected.ret1m||null,
          ret3m:        detected.ret3m||null,
          gapPct:       detected.gapPct||null,
          hi52w:        this._round(hi52),
          lo52w:        this._round(lo52),
          proximity52w: prox52w,
          ...lvl,
          conf,
          scannedAt:    Date.now(),
        });
      }

      if (i+BATCH < this.scanUniverse.length) await new Promise(r=>setTimeout(r,900));
    }

    results.sort((a,b)=>b.conf-a.conf);
    const duration = Date.now()-startTime;

    const scanMeta = {
      totalScanned: scanned,
      totalMatches: results.length,
      universeSizeBefore: UNIVERSE.length,
      universeSizeAfter:  this.scanUniverse.length,
      universeStats: UNIVERSE_STATS,
      duration:     duration,
      lastScanAt:   new Date().toISOString(),
    };

    await this._set(CACHE_KEY, CACHE_TTL, JSON.stringify(results));
    await this._set(CACHE_KEY_META, CACHE_TTL, JSON.stringify(scanMeta));
    this.lastResults = results;
    this.lastMeta    = scanMeta;


    console.log(`[Scanner] Done — ${results.length} signals from ${scanned}/${this.scanUniverse.length} stocks in ${(duration/1000).toFixed(1)}s`);
    return results;
  }

  async invalidateCache() {
    await this._del(CACHE_KEY);
    await this._del(CACHE_KEY_META);
  }

  getMeta() { return this.lastMeta; }

  // ── Derived views ──────────────────────────────────────────────────────────
  // NOTE: 'inst' (Institutional Accumulation) and 'delivery' (Delivery Volume
  // Spike) are NOT keys here — those signals come exclusively from real NSE
  // data via getInstitutionalAccumulationReal() and getDeliveryVolumeScanner()
  // (see NSE-BACKED SCANNERS section). Calling getByStrategy('inst') or
  // getByStrategy('delivery') returns the full unfiltered result set (fallback).
  getByStrategy(strategy) {
    const map = {
      vcp:       r=>r.strat==='vcp',
      vcp2:      r=>r.strat==='vcp'&&r.vcpStage===2,
      vcp3:      r=>r.strat==='vcp'&&r.vcpStage===3,
      vcp4:      r=>r.strat==='vcp'&&r.vcpStage===4,
      darvas:    r=>r.strat==='darvas',
      rs:        r=>r.strat==='rs',
      vol:       r=>r.strat==='vol',
      tight:     r=>r.strat==='tight',
      pp:        r=>r.strat==='pp',
      '52wkhi':  r=>r.strat==='52wkhi',
      vol_shock: r=>r.strat==='vol_shock',
      minervini: r=>r.strat==='minervini',
      ema_comp:  r=>r.strat==='ema_comp',
      gap:       r=>r.strat==='gap',
      momentum:  r=>r.strat==='momentum',
      rel_vol:   r=>r.strat==='rel_vol',
      early:     r=>r.strat==='early',
      mom_ignite:r=>r.strat==='mom_ignite',
      pre:       r=>r.cat==='pre',
      active:    r=>r.cat==='active',
      mom:       r=>r.cat==='mom',
    };
    const fn = map[strategy];
    return fn ? this.lastResults.filter(fn) : this.lastResults;
  }

  getVolumeAlerts() {
    return this.lastResults
      .filter(r=>r.vol>=2.5)
      .sort((a,b)=>b.vol-a.vol)
      .map(r=>({
        sym:r.sym, name:r.name, sector:r.sector, industry:r.industry, cap:r.cap,
        volRatio:r.vol, avgVolume:r.avgVolume, curVolume:r.curVolume,
        cmp:r.cmp, chg:r.chg,
        alertType: r.vol>=5?'Extreme Volume (5x+)':r.vol>=3?'High Volume (3x+)':'Elevated Volume (2.5x+)',
        breakoutConfirmed:r.cat==='active', scannedAt:r.scannedAt,
      }));
  }

  getBreakoutAlerts() {
    return this.lastResults
      .filter(r=>r.cat==='active')
      .sort((a,b)=>b.conf-a.conf)
      .map(r=>({
        sym:r.sym, name:r.name, sector:r.sector, industry:r.industry,
        alertType: r.stratName||r.strat,
        entry:r.entry, stop:r.stop, volRatio:r.vol, rs:r.rs,
        conf:r.conf, cmp:r.cmp, chg:r.chg, volConfirmed:r.volConfirmed,
        scannedAt:r.scannedAt,
      }));
  }

  // RS Leaders — full universe ranking with:
  //   rank        = overall RS rank (1 = strongest RS in entire result set)
  //   sectorRank  = rank within the stock's own sector by RS
  //   priceStrength = independent 52wk-range + 200EMA-distance score (1-99)
  getRSLeaders() {
    const sorted = [...this.lastResults].sort((a,b)=>b.rs-a.rs);

    // Sector rank: group by sector, sort each group by rs desc
    const sectorRankMap = {}; // sym -> sectorRank
    const bySector = {};
    for (const r of sorted) {
      if (!bySector[r.sector]) bySector[r.sector] = [];
      bySector[r.sector].push(r);
    }
    for (const sector of Object.keys(bySector)) {
      bySector[sector]
        .sort((a,b)=>b.rs-a.rs)
        .forEach((r,i) => { sectorRankMap[r.sym] = i+1; });
    }

    return sorted.map((r,i)=>({
      rank: i+1,
      sectorRank: sectorRankMap[r.sym] || null,
      sym:r.sym, name:r.name, sector:r.sector, industry:r.industry, cap:r.cap,
      rs:r.rs, priceStrength:r.priceStrength,
      cmp:r.cmp, chg:r.chg, proximity52w:r.proximity52w,
      hi52w:r.hi52w, strat:r.strat, cat:r.cat, conf:r.conf,
    }));
  }

  getSectorLeaders() {
    const sectorMap = {};
    for (const r of this.lastResults) {
      if (!sectorMap[r.sector]) sectorMap[r.sector] = { stocks:[], totalRS:0, count:0 };
      sectorMap[r.sector].stocks.push(r);
      sectorMap[r.sector].totalRS += r.rs;
      sectorMap[r.sector].count++;
    }
    return Object.entries(sectorMap)
      .map(([sector, d]) => ({
        sector,
        avgRS:     this._round(d.totalRS/d.count, 1),
        stockCount: d.count,
        topStock:  d.stocks.sort((a,b)=>b.rs-a.rs)[0]?.sym||'',
        activeBreakouts: d.stocks.filter(s=>s.cat==='active').length,
        momentum:  d.stocks.filter(s=>s.cat==='mom').length,
      }))
      .sort((a,b)=>b.avgRS-a.avgRS);
  }

  // Industry Group Leaders — same as sector leaders but grouped by `industry`.
  // NOTE: only covers industries represented in lastResults (i.e. industries
  // that had at least one stock match a technical scanner during the main
  // scan). Industries with zero matching stocks will not appear here.
  getIndustryLeaders() {
    const industryMap = {};
    for (const r of this.lastResults) {
      if (!industryMap[r.industry]) industryMap[r.industry] = { stocks:[], totalRS:0, count:0 };
      industryMap[r.industry].stocks.push(r);
      industryMap[r.industry].totalRS += r.rs;
      industryMap[r.industry].count++;
    }
    return Object.entries(industryMap)
      .map(([industry, d]) => ({
        industry,
        sector:    d.stocks[0]?.sector || '',
        avgRS:     this._round(d.totalRS/d.count, 1),
        stockCount: d.count,
        topStock:  d.stocks.sort((a,b)=>b.rs-a.rs)[0]?.sym||'',
        activeBreakouts: d.stocks.filter(s=>s.cat==='active').length,
        momentum:  d.stocks.filter(s=>s.cat==='mom').length,
      }))
      .sort((a,b)=>b.avgRS-a.avgRS);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // NSE-BACKED SCANNERS — real data only, no proxies
  // All methods below return { ok:false, error, data:[] } if NSE is unreachable.
  // ══════════════════════════════════════════════════════════════════════════

  _ensureNSE() {
    if (!this.nseData) {
      return { ok: false, error: 'NSE data service not configured', data: [], source: 'NSE' };
    }
    return null;
  }

  // Bulk Deal Scanner — real NSE bulk deals, filtered to our scan universe
  async getBulkDealScanner() {
    const guard = this._ensureNSE();
    if (guard) return guard;

    const result = await this.nseData.getBulkDeals(7);
    if (!result.ok) return result;

    const universeSymbols = new Set(this.scanUniverse.map(s => s.sym.replace('.NS', '')));
    const filtered = result.data
      .filter(d => universeSymbols.has(d.sym))
      .map(d => {
        const stockMeta = UNIVERSE_MAP[`${d.sym}.NS`] || {};
        const live = this.lastResults.find(r => r.sym === d.sym);
        return {
          sym: d.sym, name: stockMeta.name || d.name, sector: stockMeta.sector || '',
          industry: stockMeta.industry || '', cap: stockMeta.cap || '',
          clientName: d.clientName, dealType: d.dealType,
          qty: d.qty, price: d.price, date: d.date,
          cmp: live?.cmp ?? null, chg: live?.chg ?? null,
          stratName: 'Bulk Deal Scanner',
        };
      });

    return { ok: true, data: filtered, source: result.source, total: filtered.length };
  }

  // Block Deal Scanner — real NSE block deals, filtered to our scan universe
  async getBlockDealScanner() {
    const guard = this._ensureNSE();
    if (guard) return guard;

    const result = await this.nseData.getBlockDeals(7);
    if (!result.ok) return result;

    const universeSymbols = new Set(this.scanUniverse.map(s => s.sym.replace('.NS', '')));
    const filtered = result.data
      .filter(d => universeSymbols.has(d.sym))
      .map(d => {
        const stockMeta = UNIVERSE_MAP[`${d.sym}.NS`] || {};
        const live = this.lastResults.find(r => r.sym === d.sym);
        return {
          sym: d.sym, name: stockMeta.name || d.name, sector: stockMeta.sector || '',
          industry: stockMeta.industry || '', cap: stockMeta.cap || '',
          clientName: d.clientName, dealType: d.dealType,
          qty: d.qty, price: d.price, date: d.date,
          cmp: live?.cmp ?? null, chg: live?.chg ?? null,
          stratName: 'Block Deal Scanner',
        };
      });

    return { ok: true, data: filtered, source: result.source, total: filtered.length };
  }

  // Delivery Volume Scanner — real NSE bhav copy delivery %, spike vs own history
  // A "spike" = today's delivery % is at least 1.3x the stock's typical delivery %
  // (Note: bhav copy is single-day; we use the day's delivery% directly and flag
  // stocks with delivery% >= 60% as high-conviction delivery-based buying.)
  async getDeliveryVolumeScanner() {
    const guard = this._ensureNSE();
    if (guard) return guard;

    const symbols = this.scanUniverse.map(s => s.sym);
    const result = await this.nseData.getDeliveryData(symbols);
    if (!result.ok) return result;

    const filtered = result.data
      .filter(d => d.deliveryPct >= 60 && d.totalTradedQty > 0)
      .map(d => {
        const stockMeta = UNIVERSE_MAP[`${d.sym}.NS`] || {};
        const live = this.lastResults.find(r => r.sym === d.sym);
        return {
          sym: d.sym, name: stockMeta.name || '', sector: stockMeta.sector || '',
          industry: stockMeta.industry || '', cap: stockMeta.cap || '',
          deliveryPct: d.deliveryPct, deliveryQty: d.deliveryQty,
          totalTradedQty: d.totalTradedQty, tradedValueLakhs: d.tradedValueLakhs,
          cmp: d.close, chg: live?.chg ?? null, date: d.date,
          stratName: 'Delivery Volume Spike',
        };
      })
      .sort((a,b)=>b.deliveryPct-a.deliveryPct);

    return { ok: true, data: filtered, source: result.source, total: filtered.length };
  }

  // Institutional Accumulation Scanner — real NSE data:
  // combines bulk-deal BUY activity with high delivery % (>=50%) for the same symbol
  async getInstitutionalAccumulationReal() {
    const guard = this._ensureNSE();
    if (guard) return guard;

    const [bulkResult, deliveryResult] = await Promise.all([
      this.nseData.getBulkDeals(7),
      this.nseData.getDeliveryData(this.scanUniverse.map(s => s.sym)),
    ]);

    if (!bulkResult.ok && !deliveryResult.ok) {
      return { ok: false, error: `Bulk deals: ${bulkResult.error}; Delivery: ${deliveryResult.error}`, data: [], source: 'NSE' };
    }

    const deliveryMap = {};
    if (deliveryResult.ok) deliveryResult.data.forEach(d => { deliveryMap[d.sym] = d; });

    const universeSymbols = new Set(this.scanUniverse.map(s => s.sym.replace('.NS', '')));
    const buySideBulk = bulkResult.ok
      ? bulkResult.data.filter(d => universeSymbols.has(d.sym) && d.dealType?.toUpperCase().includes('BUY'))
      : [];

    const filtered = buySideBulk
      .map(d => {
        const delivery = deliveryMap[d.sym];
        const stockMeta = UNIVERSE_MAP[`${d.sym}.NS`] || {};
        const live = this.lastResults.find(r => r.sym === d.sym);
        return {
          sym: d.sym, name: stockMeta.name || d.name, sector: stockMeta.sector || '',
          industry: stockMeta.industry || '', cap: stockMeta.cap || '',
          clientName: d.clientName, bulkDealQty: d.qty, bulkDealPrice: d.price, bulkDealDate: d.date,
          deliveryPct: delivery?.deliveryPct ?? null,
          cmp: live?.cmp ?? delivery?.close ?? null, chg: live?.chg ?? null,
          stratName: 'Institutional Accumulation',
        };
      })
      .filter(d => d.deliveryPct === null || d.deliveryPct >= 50);

    return { ok: true, data: filtered, source: 'NSE Bulk Deals + Bhav Copy Delivery %', total: filtered.length };
  }

  // Corporate Announcement Alerts — real NSE announcements, filtered to scan universe
  async getCorporateAnnouncementsForUniverse() {
    const guard = this._ensureNSE();
    if (guard) return guard;

    const result = await this.nseData.getCorporateAnnouncements(100);
    if (!result.ok) return result;

    const universeSymbols = new Set(this.scanUniverse.map(s => s.sym.replace('.NS', '')));
    const filtered = result.data
      .filter(a => universeSymbols.has(a.sym))
      .map(a => {
        const stockMeta = UNIVERSE_MAP[`${a.sym}.NS`] || {};
        return {
          sym: a.sym, name: stockMeta.name || a.name, sector: stockMeta.sector || '',
          industry: stockMeta.industry || '', cap: stockMeta.cap || '',
          subject: a.subject, category: a.category, timestamp: a.timestamp,
        };
      });

    return { ok: true, data: filtered, source: result.source, total: filtered.length };
  }

  // Market Breadth Dashboard — real NSE advance/decline data (passthrough)
  async getMarketBreadthData() {
    const guard = this._ensureNSE();
    if (guard) return guard;
    return this.nseData.getMarketBreadth();
  }
}

module.exports = ScannerService;
