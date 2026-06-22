/**
 * Background Worker — runs scanner + news refresh independently
 * Start with: node src/worker.js
 */
require('dotenv').config();
const { createClient } = require('redis');
const ScannerService         = require('./services/scanner');
const NSEDataService         = require('./services/nseData');
const NewsIntelligenceService = require('./services/newsIntelligence');

const redis = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
  socket: { reconnectStrategy: (r) => Math.min(r * 100, 5000) },
});
redis.on('error', (e) => console.warn('[Redis Worker]', e.message));

async function runWorker() {
  try {
    await redis.connect();
    console.log('[Worker] Redis connected');
  } catch (e) {
    console.warn('[Worker] Redis unavailable — continuing without cache');
  }

  const nseData = new NSEDataService(redis);
  const scanner = new ScannerService(redis, nseData);
  const news    = new NewsIntelligenceService(null, redis, nseData); // DB not needed in worker

  const SCAN_MS  = parseInt(process.env.SCAN_INTERVAL_MS  || '45000',  10);
  const NEWS_MS  = parseInt(process.env.NEWS_INTERVAL_MS  || '1200000', 10); // 20 min default

  async function scan() {
    try {
      console.log('[Worker] Running breakout scan...');
      const results = await scanner.runScan();
      console.log(`[Worker] Scan complete — ${results.length} signals found`);
    } catch (e) {
      console.error('[Worker] Scan error:', e.message);
    }
  }

  async function refreshNews() {
    try {
      console.log('[Worker] Starting news refresh...');
      await news.refresh();
    } catch (e) {
      console.error('[Worker] News refresh error:', e.message);
    }
  }

  // Scanner: runs immediately then every SCAN_MS (45s default)
  await scan();
  setInterval(scan, SCAN_MS);
  console.log(`[Worker] Scanner running every ${SCAN_MS / 1000}s`);

  // News: runs after 30s delay (let scanner settle) then every NEWS_MS (20 min default)
  setTimeout(async () => {
    await refreshNews();
    setInterval(refreshNews, NEWS_MS);
    console.log(`[Worker] News refresh running every ${NEWS_MS / 60000} min`);
  }, 30000);
}

runWorker().catch((e) => { console.error('[Worker Fatal]', e); process.exit(1); });
