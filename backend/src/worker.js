/**
 * Background Worker — runs scanner + news fetch independently
 * Start with: node src/worker.js
 */
require('dotenv').config();
const { createClient } = require('redis');
const ScannerService = require('./services/scanner');

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

  const scanner = new ScannerService(redis);
  const SCAN_MS = parseInt(process.env.SCAN_INTERVAL_MS || '45000', 10);

  async function scan() {
    try {
      console.log('[Worker] Running breakout scan...');
      const results = await scanner.runScan();
      console.log(`[Worker] Scan complete — ${results.length} signals found`);
    } catch (e) {
      console.error('[Worker] Scan error:', e.message);
    }
  }

  await scan();
  setInterval(scan, SCAN_MS);
  console.log(`[Worker] Scanner running every ${SCAN_MS / 1000}s`);
}

runWorker().catch((e) => { console.error('[Worker Fatal]', e); process.exit(1); });
