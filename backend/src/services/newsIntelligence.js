/**
 * newsIntelligence.js — News Intelligence Center
 *
 * Ingestion sources:
 *   Tier 1 — NSE Corporate Announcements (already proven, zero ingestion risk)
 *   Tier 2 — Verified public RSS feeds (headline+snippet+link only, never full text)
 *             Moneycontrol, Economic Times Markets, LiveMint Markets
 *
 * AI scoring:
 *   Real Claude API call per qualifying item (via @anthropic-ai/sdk)
 *   Skips 'General' category — saves ~60-80% API cost
 *   All suggested stocks validated against UNIVERSE before storage
 *
 * Dedup: SHA-256 content_hash (source + normalised title) — DB UNIQUE constraint
 * Cache: Redis news:* namespace, isolated from scanner's keys
 */

'use strict';

const crypto    = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { XMLParser } = require('fast-xml-parser');
const { UNIVERSE, SECTORS } = require('./universe');

// ── Constants ─────────────────────────────────────────────────────────────────

// Pre-built lookup sets for O(1) validation
const UNIVERSE_SYMBOLS = new Set(UNIVERSE.map(s => s.sym.replace(/\.NS$/, '').toUpperCase()));
const UNIVERSE_NAMES   = new Map(UNIVERSE.map(s => [s.sym.replace(/\.NS$/, '').toUpperCase(), s.name]));
const SECTOR_SET       = new Set(SECTORS.map(s => s.toUpperCase()));

// Categories that are worth scoring (skip 'General' to control API cost)
const SCOREABLE_CATEGORIES = new Set([
  'Earnings', 'Bulk Deal', 'Block Deal', 'Insider Buying', 'Insider Selling',
  'Corporate Action', 'Shareholding Change', 'Credit Rating',
]);

// RSS feeds — headline + snippet + link only (syndication-intended public feeds)
const RSS_FEEDS = [
  {
    name:  'RSS:moneycontrol',
    url:   'https://www.moneycontrol.com/rss/latestnews.xml',
    label: 'Moneycontrol Markets',
  },
  {
    name:  'RSS:economictimes',
    url:   'https://economictimes.indiatimes.com/markets/rss.cms',
    label: 'Economic Times Markets',
  },
  {
    name:  'RSS:livemint',
    url:   'https://www.livemint.com/rss/markets',
    label: 'LiveMint Markets',
  },
  {
    name:  'RSS:businessline',
    url:   'https://www.thehindubusinessline.com/markets/feeder/default.rss',
    label: 'BusinessLine Markets',
  },
  {
    name:  'RSS:financialexpress',
    url:   'https://www.financialexpress.com/market/feed/',
    label: 'Financial Express Markets',
  },
  {
    name:  'RSS:ndtvprofit',
    url:   'https://www.ndtvprofit.com/feeds/market',
    label: 'NDTV Profit Markets',
  },
];

// Redis cache TTLs (seconds)
const TTL = {
  NEWS_LIST:     300,   // 5 min  — /news
  BREAKING:      60,    // 1 min  — /news/breaking
  HIGH_IMPACT:   180,   // 3 min  — /news/high-impact
  STOCK:         300,   // 5 min  — /news/stock/:symbol
  SECTOR:        300,   // 5 min  — /news/sector/:sector
  WATCHLIST:     120,   // 2 min  — /news/watchlist
  TRENDING:      600,   // 10 min — /news/trending
  STATS:         900,   // 15 min — /news/stats
};

// ── Service ───────────────────────────────────────────────────────────────────

class NewsIntelligenceService {
  constructor(db, redis, nseDataService) {
    this.db     = db;            // pg Pool
    this.redis  = redis;         // redis client
    this.nse    = nseDataService; // existing NseDataService instance
    this.claude = process.env.ANTHROPIC_API_KEY
      ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      : null;
    this.xmlParser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
    });
    this._running       = false; // prevent concurrent refresh runs
    this._lastRefreshAt = 0;     // epoch ms — 0 = never refreshed
  }

  // ── Lazy refresh (request-triggered, non-blocking) ─────────────────────────
  // Called at the top of each public query method.
  // On Render free tier there is no background worker, so this ensures the
  // server refreshes news whenever a stale threshold is crossed — without
  // adding any latency to the current request (fire-and-forget).
  triggerRefreshIfStale(maxAgeMs = 10 * 60 * 1000) {
    if (this._running) return;                              // already in progress
    if (Date.now() - this._lastRefreshAt < maxAgeMs) return; // still fresh
    this.refresh().catch(e =>                               // non-blocking
      console.warn('[News] Background refresh error:', e.message));
  }

  // ── Redis helpers ──────────────────────────────────────────────────────────

  async _get(key) {
    try { return await this.redis.get(`news:${key}`); } catch { return null; }
  }
  async _set(key, ttl, value) {
    try { await this.redis.setEx(`news:${key}`, ttl, value); } catch { /* non-fatal */ }
  }
  async _del(key) {
    try { await this.redis.del(`news:${key}`); } catch { /* non-fatal */ }
  }

  // ── Content hash ──────────────────────────────────────────────────────────

  _hash(source, title) {
    const normalized = `${source}:${(title || '').toLowerCase().trim().replace(/\s+/g, ' ')}`;
    return crypto.createHash('sha256').update(normalized).digest('hex');
  }

  // ── RSS fetch + parse ──────────────────────────────────────────────────────

  async _fetchRssFeed(feed) {
    const items = [];
    try {
      const axios   = require('axios');
      const resp    = await axios.get(feed.url, {
        timeout: 10000,
        headers: { 'User-Agent': 'BreakoutIntel/2.0 RSS Reader' },
        validateStatus: s => s === 200,
      });
      const parsed  = this.xmlParser.parse(resp.data);
      const channel = parsed?.rss?.channel || parsed?.feed;
      if (!channel) return items;

      const rawItems = channel.item || channel.entry || [];
      const list     = Array.isArray(rawItems) ? rawItems : [rawItems];

      list.forEach(item => {
        const title   = this._text(item.title);
        const link    = this._text(item.link || item.id);
        const summary = this._text(item.description || item.summary || item['media:description'] || '');
        const pubDate = item.pubDate || item.published || item.updated || '';
        if (!title) return;

        items.push({
          source:       feed.name,
          source_url:   feed.url,
          content_hash: this._hash(feed.name, title),
          title,
          // Snippet only — never full text; strip HTML tags
          summary:      this._stripHtml(summary).slice(0, 500) || null,
          link:         link || null,
          symbol:       null,        // RSS items don't have NSE symbol
          company_name: null,
          category:     this._inferCategory(title),
          published_at: pubDate ? new Date(pubDate).toISOString() : null,
        });
      });
    } catch (e) {
      console.warn(`[News] RSS fetch failed (${feed.name}): ${e.message}`);
    }
    return items;
  }

  _text(v) {
    if (!v) return '';
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'object') return String(v['#text'] || v['_'] || '').trim();
    return String(v).trim();
  }

  _stripHtml(html) {
    return (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  _inferCategory(title) {
    const t = (title || '').toLowerCase();
    if (/result|earnings|quarterly|profit|revenue/.test(t)) return 'Earnings';
    if (/bulk deal/.test(t)) return 'Bulk Deal';
    if (/block deal/.test(t)) return 'Block Deal';
    if (/insider.*buy|insider.*acqui/.test(t)) return 'Insider Buying';
    if (/insider.*sell|insider.*disp/.test(t)) return 'Insider Selling';
    if (/dividend|bonus|split|buyback/.test(t)) return 'Corporate Action';
    if (/shareholding/.test(t)) return 'Shareholding Change';
    if (/credit rating|downgrad|upgrad/.test(t)) return 'Credit Rating';
    return 'General';
  }

  // ── NSE fetch ─────────────────────────────────────────────────────────────

  async _fetchNseItems() {
    const items = [];
    try {
      const result = await this.nse.getCorporateAnnouncements(100);
      if (!result.ok || !Array.isArray(result.data)) return items;

      result.data.forEach(r => {
        const title  = r.subject || '';
        if (!title) return;

        // Normalise NSE symbol — strip .NS suffix if present, uppercase
        const rawSym = (r.sym || '').replace(/\.NS$/, '').toUpperCase();

        items.push({
          source:       'NSE',
          source_url:   'https://nseindia.com',
          content_hash: this._hash('NSE', title + rawSym),
          title,
          summary:      r.details ? this._stripHtml(r.details).slice(0, 500) : null,
          link:         r.attachment || null,
          symbol:       rawSym || null,
          company_name: r.name || null,
          category:     r.category || 'General',
          published_at: r.timestamp ? new Date(r.timestamp).toISOString() : null,
        });
      });
    } catch (e) {
      console.warn(`[News] NSE fetch error: ${e.message}`);
    }
    return items;
  }

  // ── Upsert items into DB ──────────────────────────────────────────────────

  async _upsertItems(items) {
    if (!this.db || !items.length) return 0;
    let inserted = 0;
    for (const item of items) {
      try {
        const { rows } = await this.db.query(`
          INSERT INTO news_items
            (source, source_url, content_hash, title, summary, link,
             symbol, company_name, category, published_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (content_hash) DO NOTHING
          RETURNING id
        `, [
          item.source, item.source_url, item.content_hash,
          item.title, item.summary, item.link,
          item.symbol, item.company_name, item.category,
          item.published_at,
        ]);

        if (rows.length) {
          inserted++;
          // Seed stock mapping for items with a primary symbol
          if (item.symbol && UNIVERSE_SYMBOLS.has(item.symbol)) {
            await this.db.query(`
              INSERT INTO news_stock_mapping (news_id, symbol, relevance)
              VALUES ($1, $2, 'primary')
              ON CONFLICT (news_id, symbol) DO NOTHING
            `, [rows[0].id, item.symbol]);
          }
        }
      } catch (e) {
        console.warn(`[News] Upsert error (${item.content_hash?.slice(0,8)}): ${e.message}`);
      }
    }
    return inserted;
  }

  // ── Claude AI scoring ─────────────────────────────────────────────────────

  async _scoreItem(item) {
    if (!this.claude) return null;
    if (!SCOREABLE_CATEGORIES.has(item.category)) return null; // cost gate

    const prompt = `You are a senior Indian equity market analyst. Analyse the following market news item and return ONLY a valid JSON object — no preamble, no explanation, no markdown.

NEWS ITEM:
Source: ${item.source}
Category: ${item.category}
Title: ${item.title}
Summary: ${item.summary || '(none)'}
Company/Symbol: ${item.company_name || item.symbol || '(unknown)'}

Return this exact JSON shape (all fields required):
{
  "impact_score": <integer 0-100; 0=irrelevant, 100=market-moving>,
  "confidence": <integer 0-100; how confident you are in this assessment>,
  "trading_relevance": <integer 0-100; 0=not tradeable, 100=high-conviction setup>,
  "sentiment": "<Bullish|Bearish|Neutral>",
  "urgency": "<Immediate|Short-Term|Long-Term|Background>",
  "why_it_matters": "<1-2 sentences for an Indian equity swing trader>",
  "trading_implication": "<1-2 sentences: what action or watch this implies>",
  "affected_sectors": [<sector names from this list only: ${SECTORS.join(', ')}>],
  "affected_stocks": [<NSE symbols WITHOUT .NS suffix, from this exact universe only: ${Array.from(UNIVERSE_SYMBOLS).slice(0, 100).join(', ')} ... (346 total). Return ONLY symbols you are certain are relevant. If unsure, return [].>]
}`;

    try {
      const response = await this.claude.messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens: 600,
        messages:   [{ role: 'user', content: prompt }],
      });
      const text = response.content?.[0]?.text || '';
      const clean = text.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean);

      // Validate + sanitise all fields
      return {
        impact_score:        Math.min(100, Math.max(0, parseInt(parsed.impact_score) || 0)),
        confidence:          Math.min(100, Math.max(0, parseInt(parsed.confidence) || 0)),
        trading_relevance:   Math.min(100, Math.max(0, parseInt(parsed.trading_relevance) || 0)),
        sentiment:           ['Bullish','Bearish','Neutral'].includes(parsed.sentiment) ? parsed.sentiment : 'Neutral',
        urgency:             ['Immediate','Short-Term','Long-Term','Background'].includes(parsed.urgency) ? parsed.urgency : 'Background',
        why_it_matters:      (parsed.why_it_matters || '').slice(0, 500),
        trading_implication: (parsed.trading_implication || '').slice(0, 500),
        // Validate sectors against our known list
        affected_sectors:    (Array.isArray(parsed.affected_sectors) ? parsed.affected_sectors : [])
                               .filter(s => SECTOR_SET.has(s.toUpperCase())),
        // Validate stocks against UNIVERSE — prevents hallucinated symbols
        affected_stocks:     (Array.isArray(parsed.affected_stocks) ? parsed.affected_stocks : [])
                               .map(s => s.toUpperCase().replace(/\.NS$/, ''))
                               .filter(s => UNIVERSE_SYMBOLS.has(s)),
        ai_model:            'claude-sonnet-4-6',
      };
    } catch (e) {
      console.warn(`[News] Claude scoring error: ${e.message}`);
      return null;
    }
  }

  async _scoreUnscored(limit = 20) {
    if (!this.db || !this.claude) return 0;
    let scored = 0;
    try {
      const { rows } = await this.db.query(`
        SELECT id, source, title, summary, company_name, symbol, category
        FROM   news_items
        WHERE  ai_scored_at IS NULL
        AND    category != 'General'
        ORDER  BY fetched_at DESC
        LIMIT  $1
      `, [limit]);

      for (const row of rows) {
        const scores = await this._scoreItem(row);
        if (!scores) continue;

        await this.db.query(`
          UPDATE news_items SET
            impact_score        = $1,
            confidence          = $2,
            trading_relevance   = $3,
            sentiment           = $4,
            urgency             = $5,
            why_it_matters      = $6,
            trading_implication = $7,
            affected_sectors    = $8,
            affected_stocks     = $9,
            ai_scored_at        = NOW(),
            ai_model            = $10
          WHERE id = $11
        `, [
          scores.impact_score, scores.confidence, scores.trading_relevance,
          scores.sentiment, scores.urgency, scores.why_it_matters,
          scores.trading_implication, scores.affected_sectors,
          scores.affected_stocks, scores.ai_model, row.id,
        ]);

        // Update stock mapping with all affected stocks
        const allSymbols = [...new Set([
          ...(row.symbol ? [row.symbol] : []),
          ...scores.affected_stocks,
        ])];
        for (const sym of allSymbols) {
          if (!UNIVERSE_SYMBOLS.has(sym)) continue;
          const rel = sym === row.symbol ? 'primary' : 'mentioned';
          await this.db.query(`
            INSERT INTO news_stock_mapping (news_id, symbol, relevance)
            VALUES ($1, $2, $3)
            ON CONFLICT (news_id, symbol) DO UPDATE SET relevance = EXCLUDED.relevance
          `, [row.id, sym, rel]);
        }
        scored++;
      }
    } catch (e) {
      console.warn(`[News] Scoring run error: ${e.message}`);
    }
    return scored;
  }

  // ── Full refresh cycle (called by worker) ─────────────────────────────────

  async refresh() {
    if (this._running) {
      console.log('[News] Refresh already in progress — skipping');
      return;
    }
    this._running       = true;
    this._lastRefreshAt = Date.now(); // gate immediately; prevents double-fire during long runs
    try {
      console.log('[News] Starting refresh cycle...');

      // 1. Ingest NSE
      const nseItems = await this._fetchNseItems();
      const nseNew   = await this._upsertItems(nseItems);
      console.log(`[News] NSE: ${nseItems.length} fetched, ${nseNew} new`);

      // 2. Ingest RSS feeds
      for (const feed of RSS_FEEDS) {
        const rssItems = await this._fetchRssFeed(feed);
        const rssNew   = await this._upsertItems(rssItems);
        console.log(`[News] ${feed.name}: ${rssItems.length} fetched, ${rssNew} new`);
      }

      // 3. Score unscored qualifying items — 10 per cycle on free tier to control API cost
      const scoredCount = await this._scoreUnscored(10);
      console.log(`[News] Scored ${scoredCount} items`);

      // 4. Bust cached query results so next request gets fresh data
      const cacheKeys = ['list', 'breaking', 'high_impact', 'stats', 'trending'];
      for (const k of cacheKeys) await this._del(k);

      console.log('[News] Refresh complete');
    } catch (e) {
      console.error('[News] Refresh error:', e.message);
    } finally {
      this._running = false;
    }
  }

  // ── Query methods (used by API routes) ────────────────────────────────────

  async getNews({ limit = 100, offset = 0, category, sentiment } = {}) {
    this.triggerRefreshIfStale();
    const cacheKey = `list:${limit}:${offset}:${category||''}:${sentiment||''}`;
    const cached = await this._get(cacheKey);
    if (cached) return JSON.parse(cached);

    if (!this.db) return { ok: true, data: [], total: 0 };
    try {
      const conditions = ['1=1'];
      const params = [];
      if (category)  { params.push(category);  conditions.push(`category = $${params.length}`); }
      if (sentiment) { params.push(sentiment);  conditions.push(`sentiment = $${params.length}`); }

      params.push(limit, offset);
      const where = conditions.join(' AND ');
      const { rows } = await this.db.query(`
        SELECT * FROM news_items
        WHERE ${where}
        ORDER BY COALESCE(published_at, fetched_at) DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `, params);

      const { rows: [ct] } = await this.db.query(
        `SELECT COUNT(*) AS total FROM news_items WHERE ${where}`,
        params.slice(0, -2)
      );
      const result = { ok: true, data: rows, total: parseInt(ct.total) };
      await this._set(cacheKey, TTL.NEWS_LIST, JSON.stringify(result));
      return result;
    } catch (e) {
      return { ok: false, error: e.message, data: [] };
    }
  }

  async getBreaking() {
    this.triggerRefreshIfStale();
    const cached = await this._get('breaking');
    if (cached) return JSON.parse(cached);
    if (!this.db) return { ok: true, data: [] };
    try {
      const { rows } = await this.db.query(`
        SELECT * FROM news_items
        WHERE  impact_score >= 80
        AND    COALESCE(published_at, fetched_at) >= NOW() - INTERVAL '6 hours'
        ORDER  BY impact_score DESC, COALESCE(published_at, fetched_at) DESC
        LIMIT  10
      `);
      const result = { ok: true, data: rows };
      await this._set('breaking', TTL.BREAKING, JSON.stringify(result));
      return result;
    } catch (e) { return { ok: false, error: e.message, data: [] }; }
  }

  async getHighImpact({ limit = 20 } = {}) {
    this.triggerRefreshIfStale();
    const cached = await this._get('high_impact');
    if (cached) return JSON.parse(cached);
    if (!this.db) return { ok: true, data: [] };
    try {
      const { rows } = await this.db.query(`
        SELECT * FROM news_items
        WHERE  impact_score >= 60
        AND    COALESCE(published_at, fetched_at) >= NOW() - INTERVAL '24 hours'
        ORDER  BY impact_score DESC, COALESCE(published_at, fetched_at) DESC
        LIMIT  $1
      `, [limit]);
      const result = { ok: true, data: rows };
      await this._set('high_impact', TTL.HIGH_IMPACT, JSON.stringify(result));
      return result;
    } catch (e) { return { ok: false, error: e.message, data: [] }; }
  }

  async getByStock(symbol) {
    this.triggerRefreshIfStale();
    const sym     = (symbol || '').toUpperCase().replace(/\.NS$/, '');
    const cacheKey = `stock:${sym}`;
    const cached   = await this._get(cacheKey);
    if (cached) return JSON.parse(cached);
    if (!this.db) return { ok: true, data: [] };
    try {
      const { rows } = await this.db.query(`
        SELECT n.* FROM news_items n
        JOIN   news_stock_mapping m ON m.news_id = n.id
        WHERE  m.symbol = $1
        ORDER  BY COALESCE(n.published_at, n.fetched_at) DESC
        LIMIT  30
      `, [sym]);
      const result = { ok: true, data: rows, symbol: sym };
      await this._set(cacheKey, TTL.STOCK, JSON.stringify(result));
      return result;
    } catch (e) { return { ok: false, error: e.message, data: [] }; }
  }

  async getBySector(sector) {
    this.triggerRefreshIfStale();
    const cacheKey = `sector:${sector}`;
    const cached   = await this._get(cacheKey);
    if (cached) return JSON.parse(cached);
    if (!this.db) return { ok: true, data: [] };
    try {
      // Get symbols in this sector from UNIVERSE (JS-side — no SQL complexity needed)
      const sectorSymbols = UNIVERSE
        .filter(s => s.sector === sector)
        .map(s => s.sym.replace(/\.NS$/, ''));

      // Query 1: items where affected_sectors includes this sector
      // Query 2: items where primary symbol is in this sector
      // Merge and deduplicate by id in JS
      const [bySector, bySymbol] = await Promise.all([
        this.db.query(`
          SELECT * FROM news_items
          WHERE  $1 = ANY(affected_sectors)
          ORDER  BY COALESCE(published_at, fetched_at) DESC
          LIMIT  30
        `, [sector]),
        sectorSymbols.length ? this.db.query(`
          SELECT * FROM news_items
          WHERE  symbol = ANY($1::text[])
          ORDER  BY COALESCE(published_at, fetched_at) DESC
          LIMIT  30
        `, [sectorSymbols]) : Promise.resolve({ rows: [] }),
      ]);

      // Deduplicate by id, sort by date
      const seen = new Set();
      const rows = [...bySector.rows, ...bySymbol.rows]
        .filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return true; })
        .sort((a, b) =>
          new Date(b.published_at || b.fetched_at) - new Date(a.published_at || a.fetched_at))
        .slice(0, 30);

      const result = { ok: true, data: rows, sector };
      await this._set(cacheKey, TTL.SECTOR, JSON.stringify(result));
      return result;
    } catch (e) { return { ok: false, error: e.message, data: [] }; }
  }

  async getWatchlistNews(symbols = []) {
    this.triggerRefreshIfStale();
    if (!symbols.length) return { ok: true, data: [] };
    const normalised = symbols.map(s => s.toUpperCase().replace(/\.NS$/, ''));
    const cacheKey   = `watchlist:${normalised.sort().join(',')}`;
    const cached     = await this._get(cacheKey);
    if (cached) return JSON.parse(cached);
    if (!this.db) return { ok: true, data: [] };
    try {
      const placeholders = normalised.map((_, i) => `$${i + 1}`).join(',');
      const { rows } = await this.db.query(`
        SELECT DISTINCT n.* FROM news_items n
        JOIN   news_stock_mapping m ON m.news_id = n.id
        WHERE  m.symbol IN (${placeholders})
        ORDER  BY COALESCE(n.published_at, n.fetched_at) DESC
        LIMIT  40
      `, normalised);
      const result = { ok: true, data: rows };
      await this._set(cacheKey, TTL.WATCHLIST, JSON.stringify(result));
      return result;
    } catch (e) { return { ok: false, error: e.message, data: [] }; }
  }

  async getTrending() {
    this.triggerRefreshIfStale();
    const cached = await this._get('trending');
    if (cached) return JSON.parse(cached);
    if (!this.db) return { ok: true, data: [] };
    try {
      // Simple aggregation — name enrichment done in JS from UNIVERSE_NAMES (no complex SQL join)
      const { rows } = await this.db.query(`
        SELECT m.symbol,
               COUNT(*)                                        AS mention_count,
               MAX(n.impact_score)                             AS max_impact,
               MODE() WITHIN GROUP (ORDER BY n.sentiment)     AS dominant_sentiment
        FROM   news_stock_mapping m
        JOIN   news_items n ON n.id = m.news_id
        WHERE  COALESCE(n.published_at, n.fetched_at) >= NOW() - INTERVAL '24 hours'
        GROUP  BY m.symbol
        ORDER  BY mention_count DESC, max_impact DESC NULLS LAST
        LIMIT  10
      `);
      const enriched = rows.map(r => ({
        symbol:             r.symbol,
        name:               UNIVERSE_NAMES.get(r.symbol) || r.symbol,
        mention_count:      parseInt(r.mention_count),
        max_impact:         r.max_impact != null ? parseInt(r.max_impact) : null,
        dominant_sentiment: r.dominant_sentiment || null,
      }));
      const result = { ok: true, data: enriched };
      await this._set('trending', TTL.TRENDING, JSON.stringify(result));
      return result;
    } catch (e) { return { ok: false, error: e.message, data: [] }; }
  }

  async getStats() {
    const cached = await this._get('stats');
    if (cached) return JSON.parse(cached);
    if (!this.db) return { ok: true, data: null };
    try {
      const { rows: [row] } = await this.db.query(`
        SELECT
          COUNT(*)                                                       AS total_items,
          COUNT(*) FILTER (WHERE ai_scored_at IS NOT NULL)               AS scored_items,
          COUNT(*) FILTER (WHERE impact_score >= 80)                     AS high_impact_count,
          COUNT(*) FILTER (WHERE sentiment = 'Bullish')                  AS bullish_count,
          COUNT(*) FILTER (WHERE sentiment = 'Bearish')                  AS bearish_count,
          COUNT(*) FILTER (WHERE sentiment = 'Neutral')                  AS neutral_count,
          COUNT(*) FILTER (WHERE fetched_at >= NOW() - INTERVAL '24h')   AS last_24h,
          COUNT(*) FILTER (WHERE fetched_at >= NOW() - INTERVAL '1h')    AS last_1h,
          AVG(impact_score) FILTER (WHERE impact_score IS NOT NULL)      AS avg_impact
        FROM news_items
      `);
      const result = { ok: true, data: {
        total:      parseInt(row.total_items),
        scored:     parseInt(row.scored_items),
        highImpact: parseInt(row.high_impact_count),
        sentiment:  {
          bullish: parseInt(row.bullish_count),
          bearish: parseInt(row.bearish_count),
          neutral: parseInt(row.neutral_count),
        },
        last24h: parseInt(row.last_24h),
        last1h:  parseInt(row.last_1h),
        avgImpact: row.avg_impact ? parseFloat(parseFloat(row.avg_impact).toFixed(1)) : null,
      }};
      await this._set('stats', TTL.STATS, JSON.stringify(result));
      return result;
    } catch (e) { return { ok: false, error: e.message, data: null }; }
  }

  async search({ q, limit = 20 } = {}) {
    if (!q || !this.db) return { ok: true, data: [] };
    try {
      const term = `%${q.toLowerCase()}%`;
      const { rows } = await this.db.query(`
        SELECT * FROM news_items
        WHERE  LOWER(title) LIKE $1
        OR     LOWER(company_name) LIKE $1
        OR     LOWER(symbol) LIKE $1
        ORDER  BY COALESCE(published_at, fetched_at) DESC
        LIMIT  $2
      `, [term, limit]);
      return { ok: true, data: rows, query: q };
    } catch (e) { return { ok: false, error: e.message, data: [] }; }
  }

  async getTimeline({ symbol, days = 30 } = {}) {
    if (!this.db) return { ok: true, data: [] };
    try {
      const params = [days];
      let filter = '';
      if (symbol) {
        const sym = symbol.toUpperCase().replace(/\.NS$/, '');
        params.push(sym);
        filter = `AND (n.symbol = $2 OR EXISTS (
          SELECT 1 FROM news_stock_mapping WHERE news_id = n.id AND symbol = $2
        ))`;
      }
      const { rows } = await this.db.query(`
        SELECT
          DATE(COALESCE(published_at, fetched_at)) AS date,
          COUNT(*)                                  AS item_count,
          AVG(impact_score)                         AS avg_impact,
          MODE() WITHIN GROUP (ORDER BY sentiment)  AS dominant_sentiment,
          COUNT(*) FILTER (WHERE sentiment = 'Bullish') AS bullish,
          COUNT(*) FILTER (WHERE sentiment = 'Bearish') AS bearish
        FROM news_items n
        WHERE COALESCE(published_at, fetched_at) >= NOW() - ($1 || ' days')::interval
        ${filter}
        GROUP  BY DATE(COALESCE(published_at, fetched_at))
        ORDER  BY date DESC
      `, params);
      return { ok: true, data: rows };
    } catch (e) { return { ok: false, error: e.message, data: [] }; }
  }
}

module.exports = NewsIntelligenceService;
