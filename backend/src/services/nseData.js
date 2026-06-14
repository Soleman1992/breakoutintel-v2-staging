/**
 * NSEDataService — Real NSE data sources (no proxies, no mock data)
 *
 * Sources:
 *  - NSE Bulk Deals     : nseindia.com/api/historical/bulk-deals
 *  - NSE Block Deals    : nseindia.com/api/historical/block-deals
 *  - NSE Bhav Copy      : nsearchives.nseindia.com (daily CSV — price/volume/delivery%)
 *  - NSE Corporate Announcements : nseindia.com/api/corporate-announcements
 *  - NSE Market Breadth : nseindia.com/api/equity-stockIndices (advance/decline)
 *
 * IMPORTANT: NSE requires a valid session cookie obtained by visiting nseindia.com
 * first. This service maintains a rolling session, identical in approach to
 * MarketDataService._initNSESession(). If NSE blocks the request (403/timeout),
 * methods return { ok:false, error, data:[] } — callers MUST show
 * "Data unavailable" rather than fabricating data, per project rules.
 */

const axios = require('axios');

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://www.nseindia.com/',
  'Connection': 'keep-alive',
};

class NSEDataService {
  constructor(redisClient) {
    this.redis = redisClient;
    this.session = null;       // cookie string
    this.sessionAt = 0;
    this._refreshSession();
  }

  // ── Redis cache helpers ───────────────────────────────────────────────────
  async _get(key)        { try { return this.redis?.isReady ? await this.redis.get(key) : null; } catch { return null; } }
  async _set(key, ttl, v) { try { if (this.redis?.isReady) await this.redis.setEx(key, ttl, v); } catch {} }

  // ── Session management ────────────────────────────────────────────────────
  async _refreshSession() {
    try {
      const resp = await axios.get('https://www.nseindia.com/', {
        headers: BROWSER_HEADERS, timeout: 10000,
      });
      const cookies = resp.headers['set-cookie'];
      if (cookies) {
        this.session = cookies.map(c => c.split(';')[0]).join('; ');
        this.sessionAt = Date.now();
        console.log('[NSEData] Session refreshed ✓');
      }
    } catch (e) {
      console.warn('[NSEData] Session refresh failed:', e.message);
      this.session = null;
    }
    // Refresh every 25 minutes
    setTimeout(() => this._refreshSession(), 25 * 60 * 1000);
  }

  async _ensureSession() {
    if (!this.session || Date.now() - this.sessionAt > 20 * 60 * 1000) {
      await this._refreshSession();
    }
  }

  _headers() {
    return { ...BROWSER_HEADERS, Cookie: this.session || '' };
  }

  // ── Generic NSE API GET with retry-on-401/403 (one session refresh) ─────────
  async _nseGet(url, timeout = 12000) {
    await this._ensureSession();
    try {
      const resp = await axios.get(url, { headers: this._headers(), timeout });
      return { ok: true, data: resp.data };
    } catch (e) {
      const status = e.response?.status;
      if (status === 401 || status === 403) {
        // retry once with fresh session
        await this._refreshSession();
        try {
          const resp2 = await axios.get(url, { headers: this._headers(), timeout });
          return { ok: true, data: resp2.data };
        } catch (e2) {
          return { ok: false, error: `NSE blocked (${e2.response?.status || e2.message})` };
        }
      }
      return { ok: false, error: e.message };
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BULK DEALS
  // ══════════════════════════════════════════════════════════════════════════
  async getBulkDeals(days = 7) {
    const cacheKey = 'nse:bulkdeals';
    const cached = await this._get(cacheKey);
    if (cached) return JSON.parse(cached);

    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - days);
    const fmt = d => `${String(d.getDate()).padStart(2,'0')}-${String(d.getMonth()+1).padStart(2,'0')}-${d.getFullYear()}`;

    const url = `https://www.nseindia.com/api/historical/bulk-deals?from=${fmt(from)}&to=${fmt(to)}`;
    const result = await this._nseGet(url);

    if (!result.ok) {
      const fallback = { ok: false, error: result.error, data: [], source: 'NSE Bulk Deals API' };
      return fallback;
    }

    const rows = result.data?.data || [];
    const mapped = rows.map(r => ({
      sym:        r.BD_SYMBOL || r.symbol,
      name:       r.BD_SCRIP_NAME || r.scripName || '',
      clientName: r.BD_CLIENT_NAME || r.clientName || '',
      dealType:   r.BD_BUY_SELL || r.buySell || '',     // BUY / SELL
      qty:        Number(r.BD_QTY_TRD || r.qty || 0),
      price:      Number(r.BD_TP_WATP || r.price || 0),
      date:       r.BD_DT_DATE || r.date || '',
    }));

    const payload = { ok: true, data: mapped, source: 'NSE Bulk Deals API', total: mapped.length };
    await this._set(cacheKey, 1800, JSON.stringify(payload)); // 30 min cache
    return payload;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BLOCK DEALS
  // ══════════════════════════════════════════════════════════════════════════
  async getBlockDeals(days = 7) {
    const cacheKey = 'nse:blockdeals';
    const cached = await this._get(cacheKey);
    if (cached) return JSON.parse(cached);

    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - days);
    const fmt = d => `${String(d.getDate()).padStart(2,'0')}-${String(d.getMonth()+1).padStart(2,'0')}-${d.getFullYear()}`;

    const url = `https://www.nseindia.com/api/historical/block-deals?from=${fmt(from)}&to=${fmt(to)}`;
    const result = await this._nseGet(url);

    if (!result.ok) {
      return { ok: false, error: result.error, data: [], source: 'NSE Block Deals API' };
    }

    const rows = result.data?.data || [];
    const mapped = rows.map(r => ({
      sym:        r.BD_SYMBOL || r.symbol,
      name:       r.BD_SCRIP_NAME || r.scripName || '',
      clientName: r.BD_CLIENT_NAME || r.clientName || '',
      dealType:   r.BD_BUY_SELL || r.buySell || '',
      qty:        Number(r.BD_QTY_TRD || r.qty || 0),
      price:      Number(r.BD_TP_WATP || r.price || 0),
      date:       r.BD_DT_DATE || r.date || '',
    }));

    const payload = { ok: true, data: mapped, source: 'NSE Block Deals API', total: mapped.length };
    await this._set(cacheKey, 1800, JSON.stringify(payload));
    return payload;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BHAV COPY (daily full-market CSV — has delivery % per stock)
  // ══════════════════════════════════════════════════════════════════════════
  async getBhavCopy(date = null) {
    const d = date ? new Date(date) : new Date();
    // NSE bhav copy uses previous trading day if today's not published yet
    const cacheKey = `nse:bhavcopy:${d.toISOString().split('T')[0]}`;
    const cached = await this._get(cacheKey);
    if (cached) return JSON.parse(cached);

    const dd = String(d.getDate()).padStart(2, '0');
    const mon = d.toLocaleString('en-US', { month: 'short' }).toUpperCase();
    const yyyy = d.getFullYear();
    const dateStr = `${dd}${mon}${yyyy}`;

    // Modern NSE bhav copy (sec_bhavdata_full)
    const url = `https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${dd}${String(d.getMonth()+1).padStart(2,'0')}${yyyy}.csv`;
    const result = await this._nseGet(url, 20000);

    if (!result.ok || typeof result.data !== 'string') {
      return { ok: false, error: result.error || 'Bhav copy not available for this date', data: [], source: 'NSE Bhav Copy' };
    }

    // Parse CSV
    const lines = result.data.split('\n').filter(l => l.trim());
    if (lines.length < 2) {
      return { ok: false, error: 'Empty bhav copy', data: [], source: 'NSE Bhav Copy' };
    }
    const headers = lines[0].split(',').map(h => h.trim().toUpperCase());
    const rows = lines.slice(1).map(line => {
      const cols = line.split(',').map(c => c.trim());
      const obj = {};
      headers.forEach((h, i) => { obj[h] = cols[i]; });
      return obj;
    });

    const mapped = rows
      .filter(r => r.SERIES === 'EQ')
      .map(r => ({
        sym:           r.SYMBOL,
        prevClose:     Number(r.PREV_CLOSE) || 0,
        open:          Number(r.OPEN_PRICE) || 0,
        high:          Number(r.HIGH_PRICE) || 0,
        low:           Number(r.LOW_PRICE) || 0,
        close:         Number(r.CLOSE_PRICE) || 0,
        totalTradedQty:Number(r.TTL_TRD_QNTY) || 0,
        deliveryQty:   Number(r.DELIV_QTY) || 0,
        deliveryPct:   Number(r.DELIV_PER) || 0,
        tradedValue:   Number(r.TURNOVER_LACS) || 0, // in lakhs
        date:          r.DATE1 || dateStr,
      }));

    const payload = { ok: true, data: mapped, source: 'NSE Bhav Copy', total: mapped.length, date: dateStr };
    await this._set(cacheKey, 6 * 3600, JSON.stringify(payload)); // 6 hr cache
    return payload;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CORPORATE ANNOUNCEMENTS
  // ══════════════════════════════════════════════════════════════════════════
  async getCorporateAnnouncements(limit = 50) {
    const cacheKey = 'nse:announcements';
    const cached = await this._get(cacheKey);
    if (cached) return JSON.parse(cached);

    const url = 'https://www.nseindia.com/api/corporate-announcements?index=equities';
    const result = await this._nseGet(url);

    if (!result.ok) {
      return { ok: false, error: result.error, data: [], source: 'NSE Corporate Announcements' };
    }

    const rows = Array.isArray(result.data) ? result.data : (result.data?.data || []);
    const mapped = rows.slice(0, limit).map(r => ({
      sym:       r.symbol || r.SYMBOL || '',
      name:      r.sm_name || r.companyName || '',
      subject:   r.subject || r.desc || '',
      details:   r.attchmntText || r.details || '',
      category:  this._categorize(r.subject || r.desc || ''),
      timestamp: r.an_dt || r.broadcastdate || r.attchmntDt || '',
      attachment:r.attchmntFile || null,
    }));

    const payload = { ok: true, data: mapped, source: 'NSE Corporate Announcements', total: mapped.length };
    await this._set(cacheKey, 900, JSON.stringify(payload)); // 15 min cache
    return payload;
  }

  // Categorize announcement subject into known buckets
  _categorize(subject) {
    const s = (subject || '').toLowerCase();
    if (s.includes('bulk deal')) return 'Bulk Deal';
    if (s.includes('block deal')) return 'Block Deal';
    if (s.includes('insider') && (s.includes('buy') || s.includes('acqui'))) return 'Insider Buying';
    if (s.includes('insider') && (s.includes('sell') || s.includes('dispos'))) return 'Insider Selling';
    if (s.includes('financial result') || s.includes('quarterly result') || s.includes('earnings')) return 'Earnings';
    if (s.includes('dividend') || s.includes('bonus') || s.includes('split') || s.includes('buyback')) return 'Corporate Action';
    if (s.includes('shareholding') || s.includes('shareholder pattern')) return 'Shareholding Change';
    if (s.includes('credit rating')) return 'Credit Rating';
    return 'General';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MARKET BREADTH (Advance/Decline + 52-week highs/lows)
  // ══════════════════════════════════════════════════════════════════════════
  async getMarketBreadth() {
    const cacheKey = 'nse:breadth';
    const cached = await this._get(cacheKey);
    if (cached) return JSON.parse(cached);

    const url = 'https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%20500';
    const result = await this._nseGet(url);

    if (!result.ok) {
      return { ok: false, error: result.error, data: null, source: 'NSE Market Breadth' };
    }

    const rows = result.data?.data || [];
    let advances = 0, declines = 0, unchanged = 0, newHigh = 0, newLow = 0;
    rows.forEach(r => {
      const chg = Number(r.pChange) || 0;
      if (chg > 0) advances++;
      else if (chg < 0) declines++;
      else unchanged++;
      const last = Number(r.lastPrice) || 0;
      const yHi  = Number(r.yearHigh) || 0;
      const yLo  = Number(r.yearLow) || 0;
      if (yHi && last >= yHi * 0.999) newHigh++;
      if (yLo && last <= yLo * 1.001) newLow++;
    });

    const payload = {
      ok: true,
      data: { advances, declines, unchanged, newHigh, newLow, total: rows.length },
      source: 'NSE Market Breadth (Nifty 500)',
    };
    await this._set(cacheKey, 60, JSON.stringify(payload)); // 1 min cache
    return payload;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DELIVERY DATA LOOKUP (from bhav copy, per-symbol)
  // ══════════════════════════════════════════════════════════════════════════
  async getDeliveryData(symbols = []) {
    const bhav = await this.getBhavCopy();
    if (!bhav.ok) return { ok: false, error: bhav.error, data: [], source: 'NSE Bhav Copy (delivery)' };

    const bhavMap = {};
    bhav.data.forEach(r => { bhavMap[r.sym] = r; });

    const data = symbols
      .map(sym => bhavMap[sym.replace('.NS', '')])
      .filter(Boolean)
      .map(r => ({
        sym: r.sym,
        deliveryQty: r.deliveryQty,
        deliveryPct: r.deliveryPct,
        totalTradedQty: r.totalTradedQty,
        tradedValueLakhs: r.tradedValue,
        close: r.close,
        date: r.date,
      }));

    return { ok: true, data, source: 'NSE Bhav Copy (delivery)', total: data.length };
  }
}

module.exports = NSEDataService;
