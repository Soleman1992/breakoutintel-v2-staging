/**
 * WebSocket Server — real-time market data streaming
 *
 * Broadcasts:
 *   indices          every 15s  — NIFTY50, BANKNIFTY, MIDCAP, VIX, SENSEX + A/D
 *   sectors          every 30s  — 7 sector performance
 *   scanner          every 45s  — breakout signals (full universe)
 *   breakout_alerts  every 45s  — high-confidence breakout alerts (AlertsEngine)
 *   volume_alerts    every 45s  — volume spike alerts (AlertsEngine)
 *   news_alerts      every 5min — market-moving news (AlertsEngine)
 *   heartbeat        every 30s  — connection keepalive
 */
const WebSocket = require('ws');
const MarketDataService = require('./marketData');
const ScannerService = require('./scanner');

class WebSocketServer {
  constructor(server, redisClient, services = {}) {
    this.wss     = new WebSocket.Server({ server, path: '/ws' });
    this.redis   = redisClient;
    this.clients = new Map();
    this.intervals = [];

    // Reuse injected service instances if provided (avoids duplicate scans)
    this.market  = services.market  || new MarketDataService(redisClient);
    this.scanner = services.scanner || new ScannerService(redisClient);
    this.alerts  = services.alerts  || null;  // AlertsEngine — injected after init

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

      // Send cached alerts immediately on connect if available
      this._sendCachedAlertsToClient(ws);

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

  // Send cached alerts immediately to a newly connected client
  async _sendCachedAlertsToClient(ws) {
    if (!this.alerts || ws.readyState !== WebSocket.OPEN) return;
    try {
      const [ba, va, na] = await Promise.all([
        this._safeRedis('get', 'alerts:ws:breakout'),
        this._safeRedis('get', 'alerts:ws:volume'),
        this._safeRedis('get', 'alerts:ws:news'),
      ]);
      if (ba && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'breakout_alerts', data: JSON.parse(ba), ts: Date.now() }));
      if (va && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'volume_alerts',  data: JSON.parse(va), ts: Date.now() }));
      if (na && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'news_alerts',    data: JSON.parse(na), ts: Date.now() }));
    } catch {}
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

    // Scanner + Breakout/Volume alerts every SCAN_INTERVAL_MS (default 45s)
    const scanInterval = parseInt(process.env.SCAN_INTERVAL_MS || '45000');
    const scanInt = setInterval(async () => {
      try {
        const stocks = await this.scanner.runScan();
        await this._safeRedis('setEx', 'cache:scanner', 60, JSON.stringify(stocks));
        if (this.clients.size > 0) this.broadcast('scanner', { stocks });

        // Generate and broadcast breakout + volume alerts if AlertsEngine is ready
        if (this.alerts && stocks.length) {
          const [breakoutAlerts, volumeAlerts] = await Promise.all([
            this.alerts.generateBreakoutAlerts(stocks),
            this.alerts.generateVolumeAlerts(stocks),
          ]);

          // Cache for new clients
          await this._safeRedis('setEx', 'alerts:ws:breakout', 120, JSON.stringify(breakoutAlerts));
          await this._safeRedis('setEx', 'alerts:ws:volume',   120, JSON.stringify(volumeAlerts));

          if (this.clients.size > 0) {
            this.broadcast('breakout_alerts', { alerts: breakoutAlerts, count: breakoutAlerts.length });
            this.broadcast('volume_alerts',   { alerts: volumeAlerts,   count: volumeAlerts.length });
          }
        }
      } catch (e) { console.warn('[WS] Scanner error:', e.message); }
    }, scanInterval);

    // News alerts every 5 minutes (news refreshes slowly, Redis-cached internally)
    const newsInt = setInterval(async () => {
      if (!this.alerts || this.clients.size === 0) return;
      try {
        const newsAlerts = await this.alerts.generateNewsAlerts();
        await this._safeRedis('setEx', 'alerts:ws:news', 360, JSON.stringify(newsAlerts));
        this.broadcast('news_alerts', { alerts: newsAlerts, count: newsAlerts.length });
      } catch (e) { console.warn('[WS] News alerts error:', e.message); }
    }, 5 * 60 * 1000);

    // Heartbeat every 30s
    const hbInt = setInterval(() => {
      if (this.clients.size > 0) this.broadcast('heartbeat', { clients: this.clients.size });
    }, 30000);

    this.intervals = [idxInt, secInt, scanInt, newsInt, hbInt];
  }

  close() {
    this.intervals.forEach(clearInterval);
    this.wss.close();
  }
}

module.exports = WebSocketServer;
