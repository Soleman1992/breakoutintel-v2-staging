/**
 * WebSocket Server — Real-time market data streaming
 *
 * Architecture:
 *  Backend fetches data → Redis pub/sub → WebSocket server → All clients
 *
 * Channels:
 *  indices     — Nifty50, BankNifty, Midcap, Smallcap, VIX (every 15s)
 *  stocks      — Individual stock quotes (every 30s)
 *  scanner     — Breakout scanner results (every 45s)
 *  alerts      — Breakout/volume/gap alerts (on event)
 *  news        — News intelligence (every 2 min)
 */

const WebSocket = require('ws');
const { createClient } = require('redis');
const MarketDataService = require('./marketData');
const ScannerService = require('./scanner');

class WebSocketServer {
  constructor(server, redisClient) {
    this.wss = new WebSocket.Server({ server, path: '/ws' });
    this.redis = redisClient;
    this.market = new MarketDataService(redisClient);
    this.scanner = new ScannerService(redisClient);
    this.clients = new Map(); // clientId → ws
    this.intervals = [];

    this._setupHandlers();
    this._startBroadcasting();
  }

  _setupHandlers() {
    this.wss.on('connection', (ws, req) => {
      const clientId = `${Date.now()}_${Math.random().toString(36).substr(2,9)}`;
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

      this.clients.set(clientId, ws);
      console.log(`[WS] Client connected: ${clientId} from ${ip} (total: ${this.clients.size})`);

      // Send cached data immediately on connect (no waiting for next cycle)
      this._sendInitialData(ws);

      // Handle client messages (subscribe to specific symbols)
      ws.on('message', (msg) => {
        try {
          const data = JSON.parse(msg);
          if (data.type === 'subscribe' && data.symbols) {
            ws.subscribedSymbols = data.symbols;
          }
          if (data.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
          }
        } catch (e) {}
      });

      ws.on('close', () => {
        this.clients.delete(clientId);
        console.log(`[WS] Client disconnected: ${clientId} (remaining: ${this.clients.size})`);
      });

      ws.on('error', (err) => {
        console.error(`[WS] Error on ${clientId}:`, err.message);
        this.clients.delete(clientId);
      });
    });
  }

  async _sendInitialData(ws) {
    try {
      // Try to send cached snapshot immediately
      const snapshot = await this.redis.get('cache:dashboard_snapshot');
      if (snapshot) {
        this._send(ws, { type: 'snapshot', data: JSON.parse(snapshot) });
      }
    } catch (e) {}
  }

  _send(ws, data) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  broadcast(type, data) {
    const msg = JSON.stringify({ type, data, ts: Date.now() });
    let sent = 0;
    this.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
        sent++;
      }
    });
    return sent;
  }

  _startBroadcasting() {
    // ── Indices every 15 seconds ─────────────────────────────────────────
    const idxInterval = setInterval(async () => {
      try {
        const indices = await this.market.getIndices();
        const advDec = await this.market.getAdvanceDecline();
        const marketStatus = await this.market.getNSEMarketStatus();
        const payload = { indices, advDec, marketStatus };

        // Cache for new connections
        await this.redis.setEx('cache:indices', 30, JSON.stringify(payload));

        const count = this.broadcast('indices', payload);
        if (count > 0) console.log(`[WS] Broadcast indices → ${count} clients`);
      } catch (e) {
        console.error('[WS] Indices broadcast error:', e.message);
      }
    }, 15000);

    // ── Sector performance every 30 seconds ──────────────────────────────
    const sectorInterval = setInterval(async () => {
      try {
        const sectors = await this.market.getSectorPerformance();
        this.broadcast('sectors', { sectors });
      } catch (e) {}
    }, 30000);

    // ── Scanner results every 45 seconds ─────────────────────────────────
    const scanInterval = setInterval(async () => {
      try {
        const scanResults = await this.scanner.runScan();
        this.broadcast('scanner', { stocks: scanResults });
        await this.redis.setEx('cache:scanner', 60, JSON.stringify(scanResults));
      } catch (e) {
        console.error('[WS] Scanner error:', e.message);
      }
    }, parseInt(process.env.SCAN_INTERVAL_MS || '45000'));

    // ── Full snapshot every 2 minutes ─────────────────────────────────────
    const snapshotInterval = setInterval(async () => {
      try {
        const snapshot = await this.market.getDashboardSnapshot();
        await this.redis.setEx('cache:dashboard_snapshot', 150, JSON.stringify(snapshot));
        this.broadcast('snapshot', snapshot);
      } catch (e) {}
    }, 120000);

    // ── Heartbeat to keep connections alive ───────────────────────────────
    const heartbeat = setInterval(() => {
      this.broadcast('heartbeat', { clients: this.clients.size, ts: Date.now() });
    }, 30000);

    this.intervals = [idxInterval, sectorInterval, scanInterval, snapshotInterval, heartbeat];
  }

  close() {
    this.intervals.forEach(clearInterval);
    this.wss.close();
  }
}

module.exports = WebSocketServer;
