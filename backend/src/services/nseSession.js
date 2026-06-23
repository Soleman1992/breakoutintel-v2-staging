/**
 * NseSessionManager — Shared NSE session + UA rotation
 *
 * PROBLEM SOLVED:
 *   Before this module, MarketDataService and NSEDataService each managed
 *   their own independent NSE session cookie. Both fired an nseindia.com GET
 *   in their constructor — two bursts from the same Render IP within
 *   milliseconds of each other. Cloudflare bot-detection saw the pattern
 *   and returned 403, leaving both services with no session cookie.
 *
 * WHAT THIS MODULE DOES:
 *   1. Single session  — one nseindia.com cookie shared across all services.
 *   2. UA rotation     — random User-Agent per attempt (defeats static fingerprinting).
 *   3. Backoff on 403  — retries at 0s → 5s → 15s → 45s with different UA each time.
 *   4. Redis cache     — stores last-good cookie; avoids NSE hit on hot restarts.
 *   5. 40-min interval — was 25-30 min; fewer hits = less bot-detection exposure.
 *   6. Singleton       — require('./nseSession') always returns the same instance.
 *
 * USAGE:
 *   const nseSession = require('./nseSession');
 *   nseSession.init(redisClient);               // once from index.js
 *   const headers = nseSession.headers();       // in any service
 *   const result  = await nseSession.get(url);  // built-in retry + UA rotation
 */

const axios = require('axios');

const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.130 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
];

function randomUA() {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

const BASE_HEADERS = {
  'Accept':          '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer':         'https://www.nseindia.com/',
  'Connection':      'keep-alive',
};

const REDIS_SESSION_KEY  = 'nse:session:cookie';
const REFRESH_INTERVAL   = 40 * 60 * 1000;
const COOKIE_MAX_AGE     = 35 * 60 * 1000;

class NseSessionManager {
  constructor() {
    this.redis       = null;
    this.cookie      = null;
    this.cookieAt    = 0;
    this._timer      = null;
    this._refreshing = false;
  }

  init(redisClient) {
    this.redis = redisClient;
    this._scheduleRefresh(0);
  }

  headers(ua) {
    return {
      ...BASE_HEADERS,
      'User-Agent': ua || randomUA(),
      'Cookie':     this.cookie || '',
    };
  }

  async get(url, timeoutMs) {
    timeoutMs = timeoutMs || 12000;
    if (!this.cookie || Date.now() - this.cookieAt > COOKIE_MAX_AGE) {
      await this._refresh();
    }
    try {
      const resp = await axios.get(url, { headers: this.headers(), timeout: timeoutMs });
      return { ok: true, data: resp.data };
    } catch (e) {
      const status = e.response && e.response.status;
      if (status === 401 || status === 403) {
        await this._refresh();
        try {
          const resp2 = await axios.get(url, { headers: this.headers(), timeout: timeoutMs });
          return { ok: true, data: resp2.data };
        } catch (e2) {
          const s2 = e2.response && e2.response.status;
          return { ok: false, error: 'NSE blocked (' + (s2 || e2.message) + ')' };
        }
      }
      return { ok: false, error: e.message };
    }
  }

  _scheduleRefresh(delayMs) {
    if (this._timer) clearTimeout(this._timer);
    var self = this;
    this._timer = setTimeout(function() {
      self._refresh().then(function() {
        self._scheduleRefresh(REFRESH_INTERVAL);
      });
    }, delayMs == null ? REFRESH_INTERVAL : delayMs);
  }

  async _refresh() {
    if (this._refreshing) return;
    this._refreshing = true;

    if (this.redis && this.redis.isReady) {
      try {
        var cached = await this.redis.get(REDIS_SESSION_KEY);
        if (cached) {
          var parsed = JSON.parse(cached);
          var age = Date.now() - (parsed.at || 0);
          if (age < COOKIE_MAX_AGE) {
            this.cookie   = parsed.cookie;
            this.cookieAt = parsed.at;
            this._refreshing = false;
            console.log('[NSESession] Using cached session cookie ✓');
            return;
          }
        }
      } catch (_) {}
    }

    var DELAYS = [0, 5000, 15000, 45000];
    for (var i = 0; i < DELAYS.length; i++) {
      if (DELAYS[i] > 0) {
        await new Promise(function(r) { setTimeout(r, DELAYS[i]); });
      }
      var ua = randomUA();
      try {
        var resp = await axios.get('https://www.nseindia.com/', {
          headers: { ...BASE_HEADERS, 'User-Agent': ua },
          timeout: 12000,
        });
        var cookies = resp.headers['set-cookie'];
        if (cookies && cookies.length) {
          this.cookie   = cookies.map(function(c) { return c.split(';')[0]; }).join('; ');
          this.cookieAt = Date.now();
          if (this.redis && this.redis.isReady) {
            var payload = JSON.stringify({ cookie: this.cookie, at: this.cookieAt });
            await this.redis.setEx(REDIS_SESSION_KEY, 35 * 60, payload).catch(function() {});
          }
          console.log('[NSESession] Session refreshed ✓ (attempt ' + (i + 1) + ')');
          this._refreshing = false;
          return;
        }
      } catch (e) {
        var status = e.response && e.response.status;
        if (i < DELAYS.length - 1) {
          if (status !== 403 && status !== 429) {
            console.warn('[NSESession] Attempt ' + (i + 1) + ' failed: ' + e.message);
          }
        } else {
          console.warn('[NSESession] All attempts failed (' + e.message + '). Retry in 40min.');
        }
      }
    }
    this._refreshing = false;
  }
}

module.exports = new NseSessionManager();
