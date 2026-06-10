```js
require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const { createClient } = require('redis');

const WebSocketServer = require('./services/websocket');
const MarketDataService = require('./services/marketData');
const ScannerService = require('./services/scanner');

const app = express();
const server = http.createServer(app);

// PostgreSQL
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// Redis
const redis = createClient({
  url: process.env.REDIS_URL,
});

redis.on('error', (err) => {
  console.error('[Redis Error]', err);
});

// Middleware
app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);

app.use(compression());

app.use(
  cors({
    origin: '*',
    credentials: true,
  })
);

app.use(express.json({ limit: '1mb' }));

app.use(
  rateLimit({
    windowMs: 60000,
    max: 100,
  })
);

let market;
let scanner;
let wss;

// Health Check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'breakoutintel-api',
    timestamp: Date.now(),
  });
});

// Dashboard Snapshot
app.get('/market/snapshot', async (req, res) => {
  try {
    const data = await market.getDashboardSnapshot();

    res.json({
      ok: true,
      data,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message,
    });
  }
});

// Scanner Results
app.get('/scanner/results', async (req, res) => {
  try {
    const data = await scanner.runScan();

    res.json({
      ok: true,
      data,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message,
    });
  }
});

// Quote
// Quote
app.get('/market/quote/:symbol', async (req, res) => {
  try {

    let symbol = req.params.symbol;

    if (!symbol.endsWith('.NS')) {
      symbol = symbol + '.NS';
    }

    const data = await market.fetchYahooQuote(symbol);

    res.json({
      ok: true,
      data,
    });

  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message,
    });
  }
});
// Portfolio
app.get('/portfolio/:userId', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM positions WHERE user_id = $1',
      [req.params.userId]
    );

    res.json({
      ok: true,
      data: rows,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message,
    });
  }
});

// Start Server
async function start() {
  try {
    await redis.connect();
    console.log('[Redis] Connected');

    await db.connect();
    console.log('[PostgreSQL] Connected');

    market = new MarketDataService(redis);
    scanner = new ScannerService(redis);
    wss = new WebSocketServer(server, redis);

    const PORT = process.env.PORT || 4000;

    server.listen(PORT, () => {
      console.log(`BreakoutIntel Backend running on ${PORT}`);
      console.log(`Health: /health`);
    });
  } catch (err) {
    console.error('[Startup Error]', err);
    process.exit(1);
  }
}

start();
```
