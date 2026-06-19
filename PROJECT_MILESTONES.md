# BreakoutIntel V2 — Project Milestones

> Branch: `development`
> Stack: Node.js · Express · PostgreSQL · Redis · Yahoo Finance · Render · GitHub

---

## ✅ Phase 1 — Portfolio CRUD
**Commit:** `7021641`

### What was built
- `portfolioService.js` — CRUD operations against the `positions` table
- Migration `001_add_exchange_to_positions.sql` — adds `exchange VARCHAR(10)` to `positions`
- 4 REST routes registered in `index.js`

### Routes
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/portfolio/positions` | List all positions |
| POST | `/portfolio/positions` | Add a position |
| PUT | `/portfolio/positions/:id` | Update a position |
| DELETE | `/portfolio/positions/:id` | Delete a position |

### Fields stored
`symbol` · `exchange` · `quantity` · `average_buy_price` · `buy_date` · `stop_loss` · `target` · `notes`

### Notes
- User identity via `x-user-id` header (placeholder — auth in a later phase)
- All routes return `503` gracefully when DB is not configured

---

## ✅ Phase 2 — Live Portfolio Engine
**Commit:** `e0379da`

### What was built
- `portfolioService.js` extended with:
  - `searchStocks(query)` — in-memory search of 346-stock UNIVERSE, zero network calls
  - `validateAndResolveSymbol(symbol, exchange)` — validates via UNIVERSE + Yahoo probe
  - `getEnrichedPositions(userId)` — live prices via `MarketDataService.fetchYahooQuote()`
  - `getPortfolioSummary(userId)` — portfolio-level P&L summary
- Migration `002_add_metadata_to_positions.sql` — adds `company_name`, `sector`, `industry`
- `index.js` updated: `market` injected into `portfolioService` after startup

### Routes
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/portfolio/search?q=<term>` | Stock search/autocomplete (in-memory) |
| GET | `/portfolio/positions` | Plain DB (Phase 1 behaviour) |
| GET | `/portfolio/positions?live=true` | Enriched with live CMP + P&L |
| GET | `/portfolio/summary` | Portfolio-level totals |

### Per-position fields (live=true)
`cmp` · `investedValue` · `currentValue` · `pnl` · `pnlPct` · `allocationPct` · `daysHeld` · `stopLossDistance` · `targetDistance` · `priceOk` · `fiftyTwoWeekHigh` · `fiftyTwoWeekLow` · `changePct`

### Failure handling
- `Promise.allSettled` — one failed symbol never blocks the portfolio
- `partialPrices: true` + `missingPrices: []` returned when any symbol fails
- Calculations use available prices only

### Metadata stored at creation
`company_name` · `sector` · `industry` — sourced from UNIVERSE at creation time, not looked up later

---

## ✅ Phase 3 — Transactions Engine
**Commit:** `72cc56d`

### What was built
- `transactionService.js` — BUY and SELL logic using **Average Cost Method**
- `portfolioService.js` extended with `getTradeHistory()` and `getPerformance()`
- Migration `003_transactions_engine.sql`:
  - `positions`: adds `realized_pnl`, `closed_at`, `exit_price`
  - `trade_history`: adds `position_id`, `exchange`, `company_name`, `transaction_type`, `total_value`, `notes`
  - 3 new indexes

### Routes
| Method | Route | Description |
|--------|-------|-------------|
| POST | `/portfolio/buy` | New position or average into existing |
| POST | `/portfolio/sell` | Partial or full exit |
| GET | `/portfolio/history` | All BUY/SELL/PARTIAL_SELL records |
| GET | `/portfolio/performance` | Realized performance metrics |

### Average Cost Method
- **BUY into existing:** `new_avg = ((old_qty × old_avg) + (new_qty × new_price)) / (old_qty + new_qty)`
- **SELL:** `realized_pnl = (sell_price − avg_buy_price) × qty_sold` — avg cost unchanged for remaining shares
- **Full exit:** `status = 'closed'`, `closed_at = NOW()`, `exit_price = weighted avg of all sells`
- **Partial exit:** `status = 'partial'`, quantity reduced, `realized_pnl` accumulated

### Position states
`open` → `partial` (after partial sell) → `closed` (after full exit)
A new BUY on a partial position re-opens it to `open` and re-averages the cost.

### Performance metrics (live-calculated, no aggregate table)
`closedTrades` · `openTrades` · `winningTrades` · `losingTrades` · `winRate` · `lossRate` · `totalRealizedPnL` · `grossProfit` · `grossLoss` · `avgWinner` · `avgLoser` · `profitFactor` · `avgHoldingDaysWinners` · `avgHoldingDaysLosers`

### Data integrity
All BUY/SELL writes run inside a PostgreSQL `BEGIN / COMMIT / ROLLBACK` transaction — no partial writes possible.

---

## 🔲 Phase 4 — Portfolio Analytics *(planned)*

Planned capabilities:
- Sector-level P&L breakdown
- Monthly / quarterly performance charts
- Drawdown analysis
- Best/worst trades
- Holding period distribution

Data available from Phase 3: `trade_history.holding_days`, `trade_history.pnl`, `positions.sector`, `positions.industry`, `positions.closed_at`

---

## 🔲 Phase 5 — Trade Intelligence *(planned)*

Planned capabilities:
- AI-driven exit recommendations
- Rule-based stop-loss alerts
- Position-sizing suggestions
- Win-rate by sector / strategy

Data available from Phase 3: `positions.stop_loss`, `positions.target`, `positions.realized_pnl`, `portfolio_performance` metrics

---

## 🔲 Phase 6 — Portfolio Frontend *(planned)*

Planned capabilities:
- Portfolio dashboard UI
- Holdings table with live prices
- Add/edit/sell position modals
- Trade history table
- Performance scorecard

APIs ready: All Phase 1–3 endpoints

---

## 🔲 Phase 7 — Premium Dashboard *(planned)*

Planned capabilities:
- Multi-portfolio support
- Benchmark comparison (vs Nifty 50)
- Export to CSV / PDF
- Advanced charting

---

## API Reference — All Portfolio Endpoints

| Method | Route | Phase | Description |
|--------|-------|-------|-------------|
| GET | `/portfolio/search?q=` | 2 | Stock search/autocomplete |
| GET | `/portfolio/positions` | 1 | Plain DB positions |
| GET | `/portfolio/positions?live=true` | 2 | Live-enriched positions |
| POST | `/portfolio/positions` | 1 | Add position (manual) |
| PUT | `/portfolio/positions/:id` | 1 | Update position |
| DELETE | `/portfolio/positions/:id` | 1 | Delete position |
| GET | `/portfolio/summary` | 2 | Portfolio P&L summary |
| POST | `/portfolio/buy` | 3 | Buy (new or add-on) |
| POST | `/portfolio/sell` | 3 | Sell (partial or full) |
| GET | `/portfolio/history` | 3 | Trade history |
| GET | `/portfolio/performance` | 3 | Realized performance metrics |

---

## Database Migrations Applied

| File | Phase | Description |
|------|-------|-------------|
| `001_add_exchange_to_positions.sql` | 1 | `exchange` column on `positions` |
| `002_add_metadata_to_positions.sql` | 2 | `company_name`, `sector`, `industry` on `positions` |
| `003_transactions_engine.sql` | 3 | `realized_pnl`, `closed_at`, `exit_price` on `positions`; enriched `trade_history`; indexes |
