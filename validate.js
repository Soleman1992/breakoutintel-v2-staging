/**
 * BreakoutIntel V2 — Backend Validation Script
 * Tests all Phase 1–5 endpoints against the live Render deployment.
 * Run: node validate.js [BASE_URL]
 * Default URL: https://breakoutintel-v2.onrender.com
 */

const https = require('https');
const http  = require('http');

const BASE = (process.argv[2] || 'https://breakoutintel-v2.onrender.com').replace(/\/$/, '');
const TEST_USER = 'validate-' + Date.now(); // unique user ID per run

// ── HTTP helper ───────────────────────────────────────────────────────────────
function req(method, path, body, headers = {}) {
  return new Promise((resolve) => {
    const url  = new URL(BASE + path);
    const lib  = url.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;

    const opts = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method,
      headers: {
        'Content-Type':  'application/json',
        'x-user-id':     TEST_USER,
        'Content-Length': data ? Buffer.byteLength(data) : 0,
        ...headers,
      },
      timeout: 30000,
    };

    const r = lib.request(opts, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let json;
        try { json = JSON.parse(raw); } catch { json = { _raw: raw }; }
        resolve({ status: res.statusCode, body: json });
      });
    });

    r.on('error',   e => resolve({ status: 0, body: { error: e.message } }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: { error: 'timeout' } }); });

    if (data) r.write(data);
    r.end();
  });
}

// ── Test runner ───────────────────────────────────────────────────────────────
const results = [];
let passed = 0, failed = 0;

function check(name, condition, detail = '') {
  const ok = !!condition;
  results.push({ name, ok, detail });
  if (ok) passed++; else failed++;
  const icon = ok ? '✅' : '❌';
  console.log(`  ${icon} ${name}${detail ? ' — ' + detail : ''}`);
}

function section(title) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(60));
}

// ── State shared across tests ─────────────────────────────────────────────────
let positionIds = [];   // created via POST /portfolio/positions
let buyPositionId = ''; // created via POST /portfolio/buy

// ═════════════════════════════════════════════════════════════════════════════
async function run() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   BreakoutIntel V2 — Backend Validation                  ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  Base URL  : ${BASE}`);
  console.log(`  Test User : ${TEST_USER}`);
  console.log(`  Started   : ${new Date().toISOString()}`);

  // ── 0. Health Check ─────────────────────────────────────────────────────────
  section('0. Health Check');
  const health = await req('GET', '/health');
  check('GET /health returns 200',          health.status === 200);
  check('ok status field present',          health.body.status === 'ok');
  check('service = breakoutintel-v2',       health.body.service === 'breakoutintel-v2');
  check('database = connected',             health.body.database === 'connected',
        `database: ${health.body.database}`);
  check('market field present',             !!health.body.market,
        `market: ${health.body.market}`);

  if (health.body.database !== 'connected') {
    console.log('\n  ⚠️  DATABASE NOT CONNECTED — skipping DB-dependent tests');
    printSummary();
    return;
  }

  // ── 1. Stock Search ─────────────────────────────────────────────────────────
  section('1. Phase 2 — Stock Search');
  const search1 = await req('GET', '/portfolio/search?q=RELIANCE');
  check('GET /portfolio/search?q=RELIANCE returns 200', search1.status === 200);
  check('ok: true',                         search1.body.ok === true);
  check('returns array',                    Array.isArray(search1.body.data));
  check('RELIANCE found',                   (search1.body.data || []).some(s => s.sym?.includes('RELIANCE') || s.nseSymbol?.includes('RELIANCE')));

  const search2 = await req('GET', '/portfolio/search');
  check('GET /portfolio/search (no q) → 400', search2.status === 400);

  const search3 = await req('GET', '/portfolio/search?q=INFY');
  check('INFY search returns results',      (search3.body.data || []).length > 0);

  // ── 2. Phase 1 — CRUD: Create Positions ────────────────────────────────────
  section('2. Phase 1 — CRUD: Create Positions');

  const positions_to_create = [
    { symbol: 'RELIANCE', exchange: 'NSE', quantity: 10, average_buy_price: 2800, buy_date: '2025-10-01', stop_loss: 2600, target: 3200, company_name: 'Reliance Industries Ltd', sector: 'Energy', industry: 'Oil & Gas', cap_category: 'Large' },
    { symbol: 'INFY',     exchange: 'NSE', quantity: 20, average_buy_price: 1500, buy_date: '2025-11-15', stop_loss: 1380, target: 1800, company_name: 'Infosys Ltd',             sector: 'IT',     industry: 'IT Services', cap_category: 'Large' },
    { symbol: 'HDFCBANK', exchange: 'NSE', quantity: 15, average_buy_price: 1650, buy_date: '2025-09-20', stop_loss: 1520, target: 1950, company_name: 'HDFC Bank Ltd',           sector: 'Financial Services', industry: 'Banking', cap_category: 'Large' },
    { symbol: 'TATAMOTORS', exchange: 'NSE', quantity: 50, average_buy_price: 780, buy_date: '2025-12-01', stop_loss: 720, target: 950, company_name: 'Tata Motors Ltd',         sector: 'Auto',   industry: 'Automobiles', cap_category: 'Large' },
    { symbol: 'WIPRO',    exchange: 'NSE', quantity: 30, average_buy_price: 480,  buy_date: '2026-01-10', stop_loss: 440, target: 580, company_name: 'Wipro Ltd',               sector: 'IT',     industry: 'IT Services', cap_category: 'Large' },
  ];

  for (const pos of positions_to_create) {
    const r = await req('POST', '/portfolio/positions', pos);
    const ok = r.status === 201 && r.body.ok === true && r.body.data?.id;
    check(`POST /portfolio/positions (${pos.symbol})`, ok, `status=${r.status}`);
    if (ok) positionIds.push(r.body.data.id);
  }

  check('5 positions created', positionIds.length === 5, `created: ${positionIds.length}`);

  // ── 3. Phase 1 — CRUD: Read Positions ──────────────────────────────────────
  section('3. Phase 1 — CRUD: Read Positions');
  const getPos = await req('GET', '/portfolio/positions');
  check('GET /portfolio/positions returns 200',  getPos.status === 200);
  check('ok: true',                              getPos.body.ok === true);
  check('returns array',                         Array.isArray(getPos.body.data));
  check('at least 5 positions returned',         (getPos.body.data || []).length >= 5,
        `count: ${(getPos.body.data || []).length}`);

  // Check required fields on first position
  const firstPos = (getPos.body.data || [])[0];
  if (firstPos) {
    check('position has id',                     !!firstPos.id);
    check('position has symbol',                 !!firstPos.symbol);
    check('position has exchange',               !!firstPos.exchange);
    check('position has quantity',               firstPos.quantity != null);
    check('position has average_buy_price',      firstPos.average_buy_price != null);
    check('position has status',                 !!firstPos.status);
    check('position has buy_date',               !!firstPos.buy_date);
  }

  // ── 4. Phase 1 — CRUD: Update Position ─────────────────────────────────────
  section('4. Phase 1 — CRUD: Update Position');
  if (positionIds.length > 0) {
    const updateId = positionIds[0];
    const upd = await req('PUT', `/portfolio/positions/${updateId}`, { stop_loss: 2650, target: 3300, notes: 'Updated by validation script' });
    check('PUT /portfolio/positions/:id returns 200', upd.status === 200);
    check('ok: true',                                 upd.body.ok === true);
    check('stop_loss updated',                        Number(upd.body.data?.stop_loss) === 2650,
          `stop_loss: ${upd.body.data?.stop_loss}`);
    check('target updated',                           Number(upd.body.data?.target) === 3300,
          `target: ${upd.body.data?.target}`);
  }

  // ── 5. Phase 1 — CRUD: Missing header ──────────────────────────────────────
  section('5. Phase 1 — CRUD: Error Handling');
  const noHeader = await req('GET', '/portfolio/positions', null, { 'x-user-id': '' });
  // Override x-user-id to empty
  const noHeaderReq = await new Promise((resolve) => {
    const url = new URL(BASE + '/portfolio/positions');
    const lib = url.protocol === 'https:' ? https : http;
    const opts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    };
    const r = lib.request(opts, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: { _raw: raw } }); }
      });
    });
    r.on('error', e => resolve({ status: 0, body: { error: e.message } }));
    r.end();
  });
  check('Missing x-user-id → 400',          noHeaderReq.status === 400,
        `status: ${noHeaderReq.status}`);
  check('ok: false on missing header',       noHeaderReq.body.ok === false);

  // ── 6. Phase 2 — Live Positions ─────────────────────────────────────────────
  section('6. Phase 2 — Live Positions');
  const livePosResp = await req('GET', '/portfolio/positions?live=true');
  check('GET /portfolio/positions?live=true returns 200', livePosResp.status === 200);
  check('ok: true',                          livePosResp.body.ok === true);
  check('positions array present',           Array.isArray(livePosResp.body.positions || livePosResp.body.data));
  const livePositions = livePosResp.body.positions || livePosResp.body.data || [];
  check('partialPrices field present',       livePosResp.body.partialPrices !== undefined,
        `partialPrices: ${livePosResp.body.partialPrices}`);
  if (livePositions.length > 0) {
    const lp = livePositions[0];
    check('priceOk field on position',       lp.priceOk !== undefined);
    check('investedValue field present',     lp.investedValue != null);
    check('daysHeld field present',          lp.daysHeld != null);
  }

  // ── 7. Phase 2 — Portfolio Summary ──────────────────────────────────────────
  section('7. Phase 2 — Portfolio Summary');
  const summary = await req('GET', '/portfolio/summary');
  check('GET /portfolio/summary returns 200', summary.status === 200);
  check('ok: true',                           summary.body.ok === true);
  check('positionCount present',              summary.body.data?.positionCount != null,
        `positionCount: ${summary.body.data?.positionCount}`);
  check('totalInvested present',              summary.body.data?.totalInvested != null,
        `totalInvested: ${summary.body.data?.totalInvested}`);
  check('partialPrices field present',        summary.body.data?.partialPrices !== undefined);

  // ── 8. Phase 3 — BUY Transaction ────────────────────────────────────────────
  section('8. Phase 3 — BUY Transaction');
  const buyResp = await req('POST', '/portfolio/buy', {
    symbol: 'TATASTEEL', exchange: 'NSE',
    company_name: 'Tata Steel Ltd', sector: 'Metals', industry: 'Steel',
    quantity: 25, price: 140, buy_date: '2026-02-01',
    stop_loss: 125, target: 175,
  });
  check('POST /portfolio/buy returns 201',   buyResp.status === 201,
        `status: ${buyResp.status}`);
  check('ok: true',                          buyResp.body.ok === true);
  check('position returned',                 !!buyResp.body.data?.position?.id);
  check('trade record returned',             !!buyResp.body.data?.trade?.id);
  check('transaction_type = BUY',            buyResp.body.data?.trade?.transaction_type === 'BUY');
  if (buyResp.body.data?.position?.id) {
    buyPositionId = buyResp.body.data.position.id;
    positionIds.push(buyPositionId);
  }

  // BUY again into same position (averaging)
  const buyResp2 = await req('POST', '/portfolio/buy', {
    symbol: 'TATASTEEL', exchange: 'NSE',
    company_name: 'Tata Steel Ltd', sector: 'Metals', industry: 'Steel',
    quantity: 25, price: 130, buy_date: '2026-02-15',
  });
  check('POST /portfolio/buy (add-on) returns 201', buyResp2.status === 201,
        `status: ${buyResp2.status}`);
  check('position still open after add-on',  buyResp2.body.data?.position?.status === 'open');
  // Verify averaging: (25*140 + 25*130) / 50 = 135
  const newAvg = Number(buyResp2.body.data?.position?.average_buy_price);
  check('average cost correctly calculated', Math.abs(newAvg - 135) < 0.01,
        `avg: ${newAvg} (expected 135)`);
  check('quantity updated to 50',            Number(buyResp2.body.data?.position?.quantity) === 50,
        `qty: ${buyResp2.body.data?.position?.quantity}`);

  // ── 9. Phase 3 — SELL Transaction (Partial) ─────────────────────────────────
  section('9. Phase 3 — SELL Transaction (Partial)');
  if (buyPositionId) {
    const sellResp = await req('POST', '/portfolio/sell', {
      position_id: buyPositionId,
      quantity: 20, price: 155,
      notes: 'Partial exit — validation test',
    });
    check('POST /portfolio/sell returns 200',  sellResp.status === 200,
          `status: ${sellResp.status}`);
    check('ok: true',                          sellResp.body.ok === true);
    check('position status = partial',         sellResp.body.data?.position?.status === 'partial',
          `status: ${sellResp.body.data?.position?.status}`);
    check('quantity reduced to 30',            Number(sellResp.body.data?.position?.quantity) === 30,
          `qty: ${sellResp.body.data?.position?.quantity}`);
    // realized_pnl = (155 - 135) * 20 = 400
    const expectedPnl = (155 - 135) * 20;
    const actualPnl   = Number(sellResp.body.data?.position?.realized_pnl);
    check('realized_pnl correct (400)',        Math.abs(actualPnl - expectedPnl) < 0.01,
          `pnl: ${actualPnl} (expected ${expectedPnl})`);
    check('transaction_type = PARTIAL_SELL',   sellResp.body.data?.trade?.transaction_type === 'PARTIAL_SELL');
    check('holding_days present',              sellResp.body.data?.trade?.holding_days != null,
          `holding_days: ${sellResp.body.data?.trade?.holding_days}`);
  }

  // ── 10. Phase 3 — SELL Transaction (Full Exit) ──────────────────────────────
  section('10. Phase 3 — SELL Transaction (Full Exit)');
  // Create a fresh position and fully exit it
  const buyForExit = await req('POST', '/portfolio/buy', {
    symbol: 'SUNPHARMA', exchange: 'NSE',
    company_name: 'Sun Pharmaceutical Industries Ltd', sector: 'Pharma', industry: 'Pharmaceuticals',
    quantity: 10, price: 1200, buy_date: '2026-03-01',
    stop_loss: 1100, target: 1400,
  });
  if (buyForExit.body.data?.position?.id) {
    const exitId = buyForExit.body.data.position.id;
    positionIds.push(exitId);
    const fullSell = await req('POST', '/portfolio/sell', {
      position_id: exitId,
      quantity: 10, price: 1350,
    });
    check('Full exit returns 200',             fullSell.status === 200,
          `status: ${fullSell.status}`);
    check('position status = closed',          fullSell.body.data?.position?.status === 'closed',
          `status: ${fullSell.body.data?.position?.status}`);
    check('quantity = 0',                      Number(fullSell.body.data?.position?.quantity) === 0,
          `qty: ${fullSell.body.data?.position?.quantity}`);
    // realized_pnl = (1350 - 1200) * 10 = 1500
    const expectedPnl = (1350 - 1200) * 10;
    const actualPnl   = Number(fullSell.body.data?.position?.realized_pnl);
    check('realized_pnl correct (1500)',       Math.abs(actualPnl - expectedPnl) < 0.01,
          `pnl: ${actualPnl} (expected ${expectedPnl})`);
    check('transaction_type = SELL',           fullSell.body.data?.trade?.transaction_type === 'SELL');
    check('exit_price set',                    fullSell.body.data?.position?.exit_price != null,
          `exit_price: ${fullSell.body.data?.position?.exit_price}`);
    check('closed_at set',                     !!fullSell.body.data?.position?.closed_at);
  } else {
    check('SUNPHARMA buy for exit test', false, 'buy failed — skipping full exit test');
  }

  // ── 11. Phase 3 — Sell Validation Errors ────────────────────────────────────
  section('11. Phase 3 — Transaction Error Handling');
  const badSell = await req('POST', '/portfolio/sell', {
    position_id: buyPositionId || positionIds[0],
    quantity: 99999, price: 100,
  });
  check('Oversell returns 400',              badSell.status === 400,
        `status: ${badSell.status}`);
  check('ok: false on oversell',             badSell.body.ok === false);

  const badBuy = await req('POST', '/portfolio/buy', { symbol: 'TEST', quantity: -5, price: 100 });
  check('Negative quantity returns 400',     badBuy.status === 400,
        `status: ${badBuy.status}`);

  // ── 12. Phase 3 — Trade History ──────────────────────────────────────────────
  section('12. Phase 3 — Trade History');
  const history = await req('GET', '/portfolio/history');
  check('GET /portfolio/history returns 200', history.status === 200);
  check('ok: true',                           history.body.ok === true);
  check('returns array',                      Array.isArray(history.body.data));
  check('at least 3 trade records',           (history.body.data || []).length >= 3,
        `count: ${(history.body.data || []).length}`);
  const firstTrade = (history.body.data || [])[0];
  if (firstTrade) {
    check('trade has id',                     !!firstTrade.id);
    check('trade has symbol',                 !!firstTrade.symbol);
    check('trade has transaction_type',       !!firstTrade.transaction_type);
    check('trade has quantity',               firstTrade.quantity != null);
    check('trade has price',                  firstTrade.price != null);
    check('trade has total_value',            firstTrade.total_value != null);
    check('trade has executed_at',            !!firstTrade.executed_at);
  }

  // ── 13. Phase 3 — Performance ────────────────────────────────────────────────
  section('13. Phase 3 — Performance Metrics');
  const perf = await req('GET', '/portfolio/performance');
  check('GET /portfolio/performance returns 200', perf.status === 200);
  check('ok: true',                               perf.body.ok === true);
  check('closedTrades present',                   perf.body.data?.closedTrades != null,
        `closedTrades: ${perf.body.data?.closedTrades}`);
  check('at least 1 closed trade',                (perf.body.data?.closedTrades || 0) >= 1);
  check('winRate present',                        perf.body.data?.winRate != null || perf.body.data?.closedTrades === 0);
  check('profitFactor present',                   perf.body.data?.profitFactor != null || perf.body.data?.closedTrades === 0);
  check('totalRealizedPnL present',               perf.body.data?.totalRealizedPnL != null,
        `totalRealizedPnL: ${perf.body.data?.totalRealizedPnL}`);

  // ── 14. Phase 4 — Analytics: Allocation ─────────────────────────────────────
  section('14. Phase 4 — Analytics: Allocation');
  const alloc = await req('GET', '/portfolio/analytics/allocation');
  check('GET /portfolio/analytics/allocation returns 200', alloc.status === 200);
  check('ok: true',                              alloc.body.ok === true);
  check('totalInvested present',                 alloc.body.data?.totalInvested != null,
        `totalInvested: ${alloc.body.data?.totalInvested}`);
  check('sectorAllocation array present',        Array.isArray(alloc.body.data?.sectorAllocation));
  check('industryAllocation array present',      Array.isArray(alloc.body.data?.industryAllocation));
  check('capAllocation array present',           Array.isArray(alloc.body.data?.capAllocation));
  check('top10Holdings array present',           Array.isArray(alloc.body.data?.top10Holdings));
  check('sectorPerformance array present',       Array.isArray(alloc.body.data?.sectorPerformance));
  if ((alloc.body.data?.sectorAllocation || []).length > 0) {
    const sec = alloc.body.data.sectorAllocation[0];
    check('sector has pct field',                sec.pct != null);
    check('sector has invested field',           sec.invested != null);
  }

  // ── 15. Phase 4 — Analytics: Risk ───────────────────────────────────────────
  section('15. Phase 4 — Analytics: Risk');
  const risk = await req('GET', '/portfolio/analytics/risk');
  check('GET /portfolio/analytics/risk returns 200', risk.status === 200);
  check('ok: true',                              risk.body.ok === true);
  check('hhiScore present',                      risk.body.data?.hhiScore != null,
        `hhiScore: ${risk.body.data?.hhiScore}`);
  check('hhiLabel present',                      !!risk.body.data?.hhiLabel,
        `hhiLabel: ${risk.body.data?.hhiLabel}`);
  check('largestPositionPct present',            risk.body.data?.largestPositionPct != null,
        `largestPositionPct: ${risk.body.data?.largestPositionPct}`);
  check('stockConcentrationRisk present',        !!risk.body.data?.stockConcentrationRisk);
  check('sectorConcentrationRisk present',       !!risk.body.data?.sectorConcentrationRisk);
  check('exposurePct present',                   risk.body.data?.exposurePct != null,
        `exposurePct: ${risk.body.data?.exposurePct}`);
  check('capitalDeployed present',               risk.body.data?.capitalDeployed != null);

  // ── 16. Phase 4 — Analytics: Performance ────────────────────────────────────
  section('16. Phase 4 — Analytics: Performance');
  const aperf = await req('GET', '/portfolio/analytics/performance');
  check('GET /portfolio/analytics/performance returns 200', aperf.status === 200);
  check('ok: true',                              aperf.body.ok === true);
  check('closedTradeCount present',              aperf.body.data?.closedTradeCount != null,
        `closedTradeCount: ${aperf.body.data?.closedTradeCount}`);
  check('openTradeCount present',                aperf.body.data?.openTradeCount != null);
  check('totalRealizedPnL present',              aperf.body.data?.totalRealizedPnL != null);
  check('openVsClosed present',                  !!aperf.body.data?.openVsClosed);

  // ── 17. Phase 4 — Analytics: Timeline ───────────────────────────────────────
  section('17. Phase 4 — Analytics: Timeline');
  const timeline = await req('GET', '/portfolio/analytics/timeline');
  check('GET /portfolio/analytics/timeline returns 200', timeline.status === 200);
  check('ok: true',                              timeline.body.ok === true);
  check('monthly array present',                 Array.isArray(timeline.body.data?.monthly));
  check('weekly array present',                  Array.isArray(timeline.body.data?.weekly));
  check('holdingPeriod object present',          !!timeline.body.data?.holdingPeriod);

  // ── 18. Phase 4 — Analytics: Health ─────────────────────────────────────────
  section('18. Phase 4 — Analytics: Health');
  const ahealth = await req('GET', '/portfolio/analytics/health');
  check('GET /portfolio/analytics/health returns 200', ahealth.status === 200);
  check('ok: true',                              ahealth.body.ok === true);
  check('capitalDeployed present',               ahealth.body.data?.capitalDeployed != null,
        `capitalDeployed: ${ahealth.body.data?.capitalDeployed}`);
  check('closedTrades present',                  ahealth.body.data?.closedTrades != null);
  check('winRate present',                       ahealth.body.data?.winRate != null || ahealth.body.data?.closedTrades === 0);
  check('profitFactor present',                  ahealth.body.data?.profitFactor != null || ahealth.body.data?.closedTrades === 0);
  check('trend object present',                  !!ahealth.body.data?.trend);

  // ── 19. Phase 5 — Intelligence: Service Guard ────────────────────────────────
  section('19. Phase 5 — Intelligence: Service Guard');
  // Test without x-user-id
  const noUserIntel = await new Promise((resolve) => {
    const url = new URL(BASE + '/portfolio/intelligence/positions');
    const lib = url.protocol === 'https:' ? https : http;
    const r = lib.request({ hostname: url.hostname, port: url.port || 443, path: url.pathname, method: 'GET', headers: { 'Content-Type': 'application/json' }, timeout: 15000 }, (res) => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); } catch { resolve({ status: res.statusCode, body: {} }); } });
    });
    r.on('error', e => resolve({ status: 0, body: { error: e.message } }));
    r.end();
  });
  check('Missing x-user-id on intelligence → 400', noUserIntel.status === 400,
        `status: ${noUserIntel.status}`);

  // ── 20. Phase 5 — Intelligence: Positions ───────────────────────────────────
  section('20. Phase 5 — Intelligence: Positions');
  const intPos = await req('GET', '/portfolio/intelligence/positions');
  check('GET /portfolio/intelligence/positions returns 200', intPos.status === 200);
  check('ok: true',                              intPos.body.ok === true);
  check('positions array present',               Array.isArray(intPos.body.data?.positions));
  check('summary object present',                !!intPos.body.data?.summary);
  check('portfolioHealthScore in summary',       intPos.body.data?.summary?.portfolioHealthScore !== undefined,
        `healthScore: ${intPos.body.data?.summary?.portfolioHealthScore}`);
  check('generatedAt present',                   !!intPos.body.data?.generatedAt);
  check('partialPrices present',                 intPos.body.data?.partialPrices !== undefined);
  if ((intPos.body.data?.positions || []).length > 0) {
    const p = intPos.body.data.positions[0];
    check('position has score',                  p.score != null, `score: ${p.score}`);
    check('position has label',                  !!p.label, `label: ${p.label}`);
    check('position has scoreBreakdown',         !!p.scoreBreakdown);
    check('position has positionId',             !!p.positionId);
    check('position has scorePartial',           p.scorePartial !== undefined);
    check('position has daysHeld',               p.daysHeld != null);
    check('position has allocationPct',          p.allocationPct != null);
    check('scoreBreakdown has 6 fields',         Object.keys(p.scoreBreakdown || {}).length === 6,
          `fields: ${Object.keys(p.scoreBreakdown || {}).join(',')}`);
  }

  // ── 21. Phase 5 — Intelligence: Exit (no live) ──────────────────────────────
  section('21. Phase 5 — Intelligence: Exit (no live)');
  const intExit = await req('GET', '/portfolio/intelligence/exit');
  check('GET /portfolio/intelligence/exit returns 200', intExit.status === 200);
  check('ok: true',                              intExit.body.ok === true);
  check('signals array present',                 Array.isArray(intExit.body.data?.signals));
  check('signals empty when live=false',         (intExit.body.data?.signals || []).length === 0);
  check('message present (live=false)',          !!intExit.body.data?.message);
  check('criticalCount present',                 intExit.body.data?.criticalCount !== undefined);
  check('warningCount present',                  intExit.body.data?.warningCount !== undefined);
  check('infoCount present',                     intExit.body.data?.infoCount !== undefined);

  // ── 22. Phase 5 — Intelligence: Portfolio ───────────────────────────────────
  section('22. Phase 5 — Intelligence: Portfolio');
  const intPort = await req('GET', '/portfolio/intelligence/portfolio');
  check('GET /portfolio/intelligence/portfolio returns 200', intPort.status === 200);
  check('ok: true',                              intPort.body.ok === true);
  check('warnings array present',                Array.isArray(intPort.body.data?.warnings));
  check('riskLevel present',                     !!intPort.body.data?.riskLevel,
        `riskLevel: ${intPort.body.data?.riskLevel}`);
  check('hhiScore present',                      intPort.body.data?.hhiScore != null,
        `hhiScore: ${intPort.body.data?.hhiScore}`);
  check('hhiLabel present',                      !!intPort.body.data?.hhiLabel);
  check('exposurePct present',                   intPort.body.data?.exposurePct != null);
  check('warningCount present',                  intPort.body.data?.warningCount !== undefined);
  check('generatedAt present',                   !!intPort.body.data?.generatedAt);
  check('riskLevel is valid value',              ['LOW','MEDIUM','HIGH'].includes(intPort.body.data?.riskLevel));

  // ── 23. Phase 5 — Intelligence: Trade Quality ───────────────────────────────
  section('23. Phase 5 — Intelligence: Trade Quality');
  const intTQ = await req('GET', '/portfolio/intelligence/trade-quality');
  check('GET /portfolio/intelligence/trade-quality returns 200', intTQ.status === 200);
  check('ok: true',                              intTQ.body.ok === true);
  check('sectorPerformance object present',      !!intTQ.body.data?.sectorPerformance);
  check('tradePatterns object present',          !!intTQ.body.data?.tradePatterns);
  check('tradePatterns.all is array',            Array.isArray(intTQ.body.data?.tradePatterns?.all));
  check('all 5 buckets present',                 (intTQ.body.data?.tradePatterns?.all || []).length === 5,
        `buckets: ${(intTQ.body.data?.tradePatterns?.all || []).length}`);
  check('profitFactorLabel present',             !!intTQ.body.data?.profitFactorLabel,
        `label: ${intTQ.body.data?.profitFactorLabel}`);
  check('holdingPeriod object present',          !!intTQ.body.data?.holdingPeriod);
  check('holdingPeriod.insight present',         !!intTQ.body.data?.holdingPeriod?.insight);
  check('closedTrades present',                  intTQ.body.data?.closedTrades != null,
        `closedTrades: ${intTQ.body.data?.closedTrades}`);
  check('generatedAt present',                   !!intTQ.body.data?.generatedAt);

  // ── 24. Phase 5 — Intelligence: Market ──────────────────────────────────────
  section('24. Phase 5 — Intelligence: Market');
  const intMkt = await req('GET', '/portfolio/intelligence/market');
  check('GET /portfolio/intelligence/market returns 200', intMkt.status === 200);
  check('ok: true',                              intMkt.body.ok === true);
  check('signals array present',                 Array.isArray(intMkt.body.data?.signals));
  check('rsLeaders array present',               Array.isArray(intMkt.body.data?.rsLeaders));
  check('rsWeakness array present',              Array.isArray(intMkt.body.data?.rsWeakness));
  check('rsSignalCoverage = scanner_only',       intMkt.body.data?.rsSignalCoverage === 'scanner_only',
        `rsSignalCoverage: ${intMkt.body.data?.rsSignalCoverage}`);
  check('positionsChecked present',              intMkt.body.data?.positionsChecked != null,
        `positionsChecked: ${intMkt.body.data?.positionsChecked}`);
  check('signalCount present',                   intMkt.body.data?.signalCount != null);
  check('generatedAt present',                   !!intMkt.body.data?.generatedAt);

  // ── 25. Phase 5 — Intelligence: Alerts ──────────────────────────────────────
  section('25. Phase 5 — Intelligence: Alerts');
  const intAlerts = await req('GET', '/portfolio/intelligence/alerts');
  check('GET /portfolio/intelligence/alerts returns 200', intAlerts.status === 200);
  check('ok: true',                              intAlerts.body.ok === true);
  check('alerts array present',                  Array.isArray(intAlerts.body.data?.alerts));
  check('totalAlerts present',                   intAlerts.body.data?.totalAlerts !== undefined,
        `totalAlerts: ${intAlerts.body.data?.totalAlerts}`);
  check('criticalAlerts present',                intAlerts.body.data?.criticalAlerts !== undefined);
  check('warningAlerts present',                 intAlerts.body.data?.warningAlerts !== undefined);
  check('infoAlerts present',                    intAlerts.body.data?.infoAlerts !== undefined);
  check('generatedAt present',                   !!intAlerts.body.data?.generatedAt);

  // Test severity filter
  const critAlerts = await req('GET', '/portfolio/intelligence/alerts?severity=CRITICAL');
  check('?severity=CRITICAL filter works',       critAlerts.status === 200 && critAlerts.body.ok === true);
  const allCritSeverity = (critAlerts.body.data?.alerts || []).every(a => a.severity === 'CRITICAL');
  check('All filtered alerts are CRITICAL',      allCritSeverity || (critAlerts.body.data?.alerts || []).length === 0,
        `alerts: ${(critAlerts.body.data?.alerts || []).length}`);

  // ── 26. Phase 5 — Intelligence: Aggregated ──────────────────────────────────
  section('26. Phase 5 — Intelligence: Aggregated Endpoint');
  const intAgg = await req('GET', '/portfolio/intelligence');
  check('GET /portfolio/intelligence returns 200', intAgg.status === 200);
  check('ok: true',                              intAgg.body.ok === true);
  check('data.positions present',                !!intAgg.body.data?.positions);
  check('data.exit present',                     !!intAgg.body.data?.exit);
  check('data.portfolio present',                !!intAgg.body.data?.portfolio);
  check('data.tradeQuality present',             !!intAgg.body.data?.tradeQuality);
  check('data.market present',                   !!intAgg.body.data?.market);
  check('data.alerts present',                   !!intAgg.body.data?.alerts);
  check('data.generatedAt present',              !!intAgg.body.data?.generatedAt);
  check('data.partialPrices present',            intAgg.body.data?.partialPrices !== undefined);

  // ── 27. Phase 1 — CRUD: Delete ──────────────────────────────────────────────
  section('27. Phase 1 — CRUD: Delete Position');
  if (positionIds.length > 0) {
    const delId = positionIds[positionIds.length - 1];
    const del = await req('DELETE', `/portfolio/positions/${delId}`);
    check('DELETE /portfolio/positions/:id returns 200', del.status === 200,
          `status: ${del.status}`);
    check('ok: true',                            del.body.ok === true);
    check('deleted: true',                       del.body.data?.deleted === true);

    // Verify it's gone
    const getAfterDel = await req('GET', '/portfolio/positions');
    const stillExists = (getAfterDel.body.data || []).some(p => p.id === delId);
    check('Position no longer in list',          !stillExists);
  }

  // ── 28. Market Routes ────────────────────────────────────────────────────────
  section('28. Market Routes (Phase 2)');
  const indices = await req('GET', '/market/indices');
  check('GET /market/indices returns 200',       indices.status === 200);
  check('ok: true',                              indices.body.ok === true);

  const sectors = await req('GET', '/market/sectors');
  check('GET /market/sectors returns 200',       sectors.status === 200);
  check('ok: true',                              sectors.body.ok === true);

  // ── Final Summary ────────────────────────────────────────────────────────────
  printSummary();
}

function printSummary() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   VALIDATION SUMMARY                                     ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  Total:  ${passed + failed}`);
  console.log(`  Passed: ${passed} ✅`);
  console.log(`  Failed: ${failed} ❌`);
  console.log(`  Score:  ${Math.round(passed / (passed + failed) * 100)}%`);

  if (failed > 0) {
    console.log('\n  FAILED CHECKS:');
    results.filter(r => !r.ok).forEach(r => {
      console.log(`    ❌ ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
    });
  }

  console.log(`\n  Completed: ${new Date().toISOString()}`);
  console.log('');
}

run().catch(e => {
  console.error('\n[FATAL]', e.message);
  printSummary();
});
