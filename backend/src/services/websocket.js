/**
 * WebSocket Server — real-time market data streaming
 * Pushes indices, sectors, scanner results to all connected clients
 */
const WebSocket = require('ws');
const MarketDataService = require('./marketData');
const ScannerService = require('./scanner');

class WebSocketServer {
  constructor(server, redisClient) {
    this.wss = new WebSocket.Server({ server, path: '/ws' });
    this.redis = redisClient;
    this.market = new MarketDataService(redisClient);
    this.scanner = new ScannerService(redisClient);
    this.clients = new Map();
    this.intervals = [];
    this._setup();
    this._startBroadcasting();
  }

  _safeRedis(op, ...args) {
    try {
      if (!this.redis || !this.redis.isReady) return Promise.resolve(null);
      return this.redis[op](...args);
    } catch (e) { return Promise.resolve(null); }
  }

  _setup() {
    this.wss.on('connection', (ws, req) => {
      const id = `${Date.now()}_${Math.random().toString(36).substr(2,6)}`;
      this.clients.set(id, ws);
      console.log(`[WS] Client connected: ${id} (total: ${this.clients.size})`);

      // Send cached snapshot immediately on connect
      this._safeRedis('get', 'cache:dashboard_snapshot').then(cached => {
        if (cached && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'snapshot', data: JSON.parse(cached) }));
        }
      });

      ws.on('message', (msg) => {
        try {
          const d = JSON.parse(msg);
          if (d.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        } catch (e) {}
      });

      ws.on('close', () => { this.clients.delete(id); });
      ws.on('error', () => { this.clients.delete(id); });
    });
  }

  broadcast(type, data) {
    const msg = JSON.stringify({ type, data, ts: Date.now() });
    this.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    });
  }

  _startBroadcasting() {
    // Indices every 15s
    const idxInt = setInterval(async () => {
      try {
        const [indices, advDec, marketStatus] = await Promise.all([
          this.market.getIndices(),
          this.market.getAdvanceDecline(),
          this.market.getNSEMarketStatus(),
        ]);
        const payload = { indices, advDec, marketStatus };
        await this._safeRedis('setEx', 'cache:indices', 30, JSON.stringify(payload));
        if (this.clients.size > 0) this.broadcast('indices', payload);
      } catch (e) { console.warn('[WS] Indices error:', e.message); }
    }, 15000);

    // Sectors every 30s
    const secInt = setInterval(async () => {
      try {
        const sectors = await this.market.getSectorPerformance();
        if (this.clients.size > 0) this.broadcast('sectors', { sectors });
      } catch (e) {}
    }, 30000);

    // Scanner every 45s
    const scanInt = setInterval(async () => {
      try {
        const stocks = await this.scanner.runScan();
        await this._safeRedis('setEx', 'cache:scanner', 60, JSON.stringify(stocks));
        if (this.clients.size > 0) this.broadcast('scanner', { stocks });
      } catch (e) { console.warn('[WS] Scanner error:', e.message); }
    }, parseInt(process.env.SCAN_INTERVAL_MS || '45000'));

    // Heartbeat every 30s
    const hbInt = setInterval(() => {
      if (this.clients.size > 0) this.broadcast('heartbeat', { clients: this.clients.size });
    }, 30000);

    this.intervals = [idxInt, secInt, scanInt, hbInt];
  }

  close() {
    this.intervals.forEach(clearInterval);
    this.wss.close();
  }
}

module.exports = WebSocketServer;
