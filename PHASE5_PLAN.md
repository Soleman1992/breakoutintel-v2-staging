# Portfolio Phase 5 — Trade Intelligence
## Complete Implementation Plan (Revised)

> **Status:** Awaiting approval — do not write code until approved.
> **Branch:** development
> **Constraint:** No new DB tables. No AI. No paid APIs. No forecasting.
> **Revision:** RC1, RC3, RC5, RC6, RC7, RC8, RC9, RC11, RC12 applied.

---

## Changelog (vs. original plan)

| Change | Description |
|---|---|
| RC1 | `NEAR_52W_HIGH` moved from scanner-based to live-price-based signal |
| RC3 | `EXCESSIVE_DRAWDOWN` naming inconsistency resolved — two distinct constants |
| RC5 | `positionId`, `exchange`, `company_name`, `cap_category` added to position intelligence response |
| RC6 | `company_name` added to exit intelligence signal response |
| RC7 | `portfolioHealthScore` added to position intelligence summary |
| RC8 | `getAlerts()` price-fetch deduplication explicitly specified |
| RC9 | `TARGET_REACHED` elevated from INFO to WARNING |
| RC11 | Zero-position handling explicitly specified |
| RC12 | `scoredAt` renamed to `generatedAt` across all module responses |

---

## Table of Contents

1. [Intelligence Architecture](#1-intelligence-architecture)
2. [Files to Create](#2-files-to-create)
3. [Files to Modify](#3-files-to-modify)
4. [API Endpoints](#4-api-endpoints)
5. [Intelligence Calculations](#5-intelligence-calculations)
6. [Alert Framework](#6-alert-framework)
7. [Database Impact](#7-database-impact)
8. [Performance Considerations](#8-performance-considerations)
9. [Future Compatibility](#9-future-compatibility)

---

## 1. Intelligence Architecture

### Overview

Phase 5 is a **pure computation layer** that sits on top of the existing Phase 1–4 data stack. It reads from `positions`, `trade_history`, and the in-memory scanner/market services. It writes nothing to the database. Every result is calculated on demand and optionally cached in Redis.

```
┌─────────────────────────────────────────────────────────────────┐
│                    Phase 5 — Intelligence Layer                  │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              IntelligenceService (new)                    │   │
│  │                                                           │   │
│  │  getPositionIntelligence()    ← positions + live prices  │   │
│  │  getExitIntelligence()        ← stop_loss + target + CMP │   │
│  │  getPortfolioIntelligence()   ← analyticsService Phase4  │   │
│  │  getTradeQualityIntelligence() ← trade_history           │   │
│  │  getMarketContextIntelligence() ← scanner + live prices  │   │
│  │  getAlerts()                  ← aggregates all above     │   │
│  │                                                           │   │
│  │  _fetchLivePrices(positions)  ← shared price map         │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  Reads from:                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  positions   │  │ trade_history│  │  analyticsService    │  │
│  │  (DB)        │  │  (DB)        │  │  (Phase 4 — reused)  │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
│  ┌──────────────┐  ┌──────────────┐                             │
│  │  scanner     │  │ marketData   │                             │
│  │  .lastResults│  │ .fetchYahoo  │                             │
│  └──────────────┘  └──────────────┘                             │
└─────────────────────────────────────────────────────────────────┘
```

### Design Principles

- **No new tables.** All intelligence is calculated from existing `positions` and `trade_history` rows.
- **No AI, no LLM, no paid APIs.** Every signal is a deterministic rule applied to objective data.
- **Graceful degradation.** If live prices are unavailable, position scores and exit signals fall back to DB-only data. The response always returns something useful.
- **Scanner reuse.** Market context intelligence cross-references `scanner.lastResults` (already in memory / Redis) against the user's open positions. No new scan is triggered.
- **Phase 4 reuse.** `analyticsService.getRisk()`, `getAllocation()`, `getHealth()`, and `getTimeline()` are called directly inside `IntelligenceService`. No logic is duplicated.
- **Price fetch deduplication.** `_fetchLivePrices(positions)` is called once per request and the resulting price map is passed to all sub-methods that need live prices. No symbol is fetched more than once per request.
- **Zero-position safety.** All intelligence methods return explicit zero-state objects when the user has no open positions. No null reference errors.

### RS Signal Coverage Note

`RS_LEADER` and `RS_WEAKNESS` signals are sourced from `scanner.lastResults`. This set only contains stocks that matched at least one technical pattern AND passed the confidence threshold during the last scan. Portfolio stocks that are not in the scanner result set will not receive RS signals. This is a documented limitation, not a silent omission. The response includes `"rsSignalCoverage": "scanner_only"` to make this explicit to the frontend.

---

## 2. Files to Create

### `backend/src/services/intelligenceService.js`

The single new service class. Contains all six intelligence methods, the shared price-fetch helper, and the alert aggregator. Receives `db`, `market`, `analytics`, and `scanner` as constructor arguments (all already instantiated in `index.js`).

**Approximate size:** ~650–750 lines.

**Methods:**

| Method | Signature | Returns |
|---|---|---|
| `getPositionIntelligence` | `(userId, live=false)` | Score + label for every open position + portfolio health score |
| `getExitIntelligence` | `(userId, live=false)` | Exit signals per position |
| `getPortfolioIntelligence` | `(userId)` | Concentration, sector, exposure warnings |
| `getTradeQualityIntelligence` | `(userId)` | Sector ranking, patterns, avg winner/loser, profit factor, holding period |
| `getMarketContextIntelligence` | `(userId, live=false)` | Scanner cross-reference + live 52wk signals |
| `getAlerts` | `(userId, live=false)` | Aggregated alert objects with severity |
| `_fetchLivePrices` | `(positions)` | `Map<symbol, quote>` — shared across sub-methods |

**Zero-state returns:**

When the user has no open positions:
- `getPositionIntelligence()` → `{ positions: [], summary: { strongHold: 0, hold: 0, reduce: 0, watchClosely: 0, highRisk: 0, portfolioHealthScore: null }, generatedAt, partialPrices: false }`
- `getExitIntelligence()` → `{ signals: [], criticalCount: 0, warningCount: 0, infoCount: 0, partialPrices: false }`
- `getMarketContextIntelligence()` → `{ signals: [], rsLeaders: [], rsWeakness: [], scannerAge: null, positionsChecked: 0, signalCount: 0, rsSignalCoverage: 'scanner_only' }`
- `getPortfolioIntelligence()`, `getTradeQualityIntelligence()`, `getAlerts()` return their respective zero-state objects with all numeric fields set to `0` or `null`.

---

### `backend/src/routes/intelligence.js`

Express router module. Registers all six `/portfolio/intelligence/*` endpoints plus the aggregated root. Imported and mounted in `index.js`.

**Approximate size:** ~130 lines.

---

## 3. Files to Modify

### `backend/src/index.js`

**Changes required (minimal — 4 additions, ~12 lines total):**

1. Declare `let intelligence = null;` alongside the other service variables (line ~25).

2. After `analytics` is instantiated (step 3 of `start()`), instantiate `IntelligenceService`:
   ```js
   const IntelligenceService = require('./services/intelligenceService');
   intelligence = new IntelligenceService(db, null, analytics, null);
   console.log('[Intelligence] Service ready ✓');
   ```

3. After market and scanner are ready (step 4), inject them:
   ```js
   if (intelligence) {
     intelligence.market  = market;
     intelligence.scanner = scanner;
     console.log('[Intelligence] Market + Scanner injected ✓');
   }
   ```

4. Mount the intelligence router (before the catch-all `app.get('*', ...)` route):
   ```js
   const intelligenceRouter = require('./routes/intelligence');
   app.use('/portfolio/intelligence', intelligenceRouter(intelligence));
   ```

**No other files need modification.**

---

## 4. API Endpoints

All endpoints require the `x-user-id` header (same pattern as all Phase 1–4 routes).

---

### `GET /portfolio/intelligence`

**Aggregated full intelligence snapshot.**

Returns all six intelligence modules in a single response. Useful for a dashboard overview panel. Fetches live prices once and shares the price map across all sub-modules.

Query params:
- `?live=true` — fetch live prices for position scoring, exit signals, and 52wk-low/high market signals (default: `false`)

Response shape:
```json
{
  "ok": true,
  "data": {
    "positions":    { "...see /intelligence/positions..." },
    "exit":         { "...see /intelligence/exit..." },
    "portfolio":    { "...see /intelligence/portfolio..." },
    "tradeQuality": { "...see /intelligence/trade-quality..." },
    "market":       { "...see /intelligence/market..." },
    "alerts":       { "...see /intelligence/alerts..." },
    "generatedAt":  "2026-06-19T17:52:00.000Z",
    "partialPrices": false
  }
}
```

---

### `GET /portfolio/intelligence/positions`

**Position-level intelligence.** Score and label for every open/partial position. Includes portfolio health score.

Query params:
- `?live=true` — required for full scoring; without it, score is DB-only (partial)

Response shape:
```json
{
  "ok": true,
  "data": {
    "positions": [
      {
        "positionId":    "uuid",
        "symbol":        "RELIANCE",
        "exchange":      "NSE",
        "company_name":  "Reliance Industries Ltd",
        "sector":        "Energy",
        "cap_category":  "Large",
        "score":         72,
        "label":         "Strong Hold",
        "scorePartial":  false,
        "scoreBreakdown": {
          "pnlScore":            20,
          "stopDistanceScore":   15,
          "targetDistanceScore": 12,
          "holdingPeriodScore":  10,
          "allocationScore":     10,
          "drawdownScore":        5
        },
        "cmp":              2450.50,
        "pnlPct":           8.2,
        "stopLossDistance": 6.4,
        "targetDistance":   12.1,
        "daysHeld":         34,
        "allocationPct":    8.5,
        "priceOk":          true
      }
    ],
    "summary": {
      "strongHold":         3,
      "hold":               4,
      "reduce":             1,
      "watchClosely":       2,
      "highRisk":           0,
      "portfolioHealthScore": 64
    },
    "partialPrices": false,
    "generatedAt": "2026-06-19T17:52:00.000Z"
  }
}
```

**`portfolioHealthScore`** is the allocation-weighted average of all position scores:
```
portfolioHealthScore = sum(score_i × allocationPct_i) / 100
```
Returns `null` when there are no open positions or when all prices are unavailable.

---

### `GET /portfolio/intelligence/exit`

**Exit signal intelligence.** Detects stop loss breaches, target hits, drawdown, and large unrealized moves.

Query params:
- `?live=true` — required for CMP-based signals; without it, returns `{ signals: [], message: "live=true required" }`

Response shape:
```json
{
  "ok": true,
  "data": {
    "signals": [
      {
        "positionId":   "uuid",
        "symbol":       "TATASTEEL",
        "exchange":     "NSE",
        "company_name": "Tata Steel Ltd",
        "signalType":   "STOP_LOSS_BREACHED",
        "severity":     "CRITICAL",
        "message":      "CMP ₹118.50 is below stop loss ₹120.00",
        "cmp":          118.50,
        "stopLoss":     120.00,
        "target":       null,
        "pnlPct":       -6.8
      }
    ],
    "criticalCount": 1,
    "warningCount":  2,
    "infoCount":     1,
    "partialPrices": false,
    "generatedAt":   "2026-06-19T17:52:00.000Z"
  }
}
```

---

### `GET /portfolio/intelligence/portfolio`

**Portfolio-level intelligence.** Concentration, sector, and exposure warnings. Reuses Phase 4 analytics. DB-only — no live prices needed.

`analyticsService.getAllocation(userId, false)` is called (invested value, not current value). This is correct for concentration risk — it measures capital committed, not floating value.

Response shape:
```json
{
  "ok": true,
  "data": {
    "warnings": [
      {
        "type":      "OVERWEIGHT_POSITION",
        "severity":  "WARNING",
        "symbol":    "HDFC",
        "value":     22.4,
        "threshold": 20,
        "message":   "HDFC is 22.4% of portfolio — exceeds 20% single-stock limit"
      },
      {
        "type":      "OVERWEIGHT_SECTOR",
        "severity":  "WARNING",
        "sector":    "Financial Services",
        "value":     38.5,
        "threshold": 35,
        "message":   "Financial Services sector is 38.5% of portfolio"
      }
    ],
    "riskLevel":    "MEDIUM",
    "hhiScore":     1820,
    "hhiLabel":     "Moderate",
    "exposurePct":  78.4,
    "warningCount": 2,
    "generatedAt":  "2026-06-19T17:52:00.000Z"
  }
}
```

---

### `GET /portfolio/intelligence/trade-quality`

**Trade quality intelligence.** Sector performance ranking, trade patterns, avg winner/loser, profit factor, holding period analysis. All from `trade_history` and `positions`. No live prices needed.

Response shape:
```json
{
  "ok": true,
  "data": {
    "sectorPerformance": {
      "best":  {
        "sector":    "IT",
        "totalPnL":  45200,
        "winRate":   75,
        "tradeCount": 8
      },
      "worst": {
        "sector":    "Metals",
        "totalPnL":  -8400,
        "winRate":   33,
        "tradeCount": 3
      },
      "all": [ "...full sectorPerformance array from analyticsService..." ]
    },
    "tradePatterns": {
      "best":  { "pattern": "Position (61–180d)", "avgPnLPct": 18.4, "winRate": 72, "count": 6 },
      "worst": { "pattern": "Short Hold (4–14d)", "avgPnLPct": -3.2, "winRate": 38, "count": 8 },
      "all": [
        { "pattern": "Scalp (≤3d)",        "avgPnLPct": 1.2,  "winRate": 55, "count": 4 },
        { "pattern": "Short Hold (4–14d)", "avgPnLPct": -3.2, "winRate": 38, "count": 8 },
        { "pattern": "Swing (15–60d)",     "avgPnLPct": 9.1,  "winRate": 62, "count": 13 },
        { "pattern": "Position (61–180d)", "avgPnLPct": 18.4, "winRate": 72, "count": 6 },
        { "pattern": "Long Hold (>180d)",  "avgPnLPct": 11.2, "winRate": 67, "count": 3 }
      ]
    },
    "avgWinner":         8420,
    "avgLoser":          3210,
    "profitFactor":      2.62,
    "profitFactorLabel": "Strong",
    "holdingPeriod": {
      "avgDays":        38,
      "avgDaysWinners": 52,
      "avgDaysLosers":  18,
      "insight":        "Winners held 2.9x longer than losers"
    },
    "winRate":      64.2,
    "closedTrades": 28,
    "generatedAt":  "2026-06-19T17:52:00.000Z"
  }
}
```

---

### `GET /portfolio/intelligence/market`

**Market context intelligence.** Cross-references open positions against scanner results and live prices.

Query params:
- `?live=true` — enables `NEAR_52W_HIGH` and `NEAR_52W_LOW` signals (requires live price fetch)

Response shape:
```json
{
  "ok": true,
  "data": {
    "signals": [
      {
        "positionId":  "uuid",
        "symbol":      "INFY",
        "exchange":    "NSE",
        "company_name": "Infosys Ltd",
        "signalType":  "IN_BREAKOUT",
        "stratName":   "VCP Scanner",
        "category":    "active",
        "rs":          84,
        "conf":        7,
        "cmp":         1820.50,
        "message":     "INFY is in an active VCP breakout (conf: 7/10)"
      },
      {
        "positionId":  "uuid",
        "symbol":      "TATAMOTORS",
        "exchange":    "NSE",
        "company_name": "Tata Motors Ltd",
        "signalType":  "VOLUME_SURGE",
        "volRatio":    3.2,
        "cmp":         920.00,
        "message":     "TATAMOTORS has a 3.2x volume surge today"
      },
      {
        "positionId":  "uuid",
        "symbol":      "WIPRO",
        "exchange":    "NSE",
        "company_name": "Wipro Ltd",
        "signalType":  "NEAR_52W_HIGH",
        "proximity52w": 98.4,
        "cmp":         560.00,
        "message":     "WIPRO is within 1.6% of its 52-week high"
      }
    ],
    "rsLeaders":          ["INFY", "TCS"],
    "rsWeakness":         ["TATASTEEL"],
    "rsSignalCoverage":   "scanner_only",
    "scannerAge":         "4m 32s",
    "positionsChecked":   10,
    "signalCount":        3,
    "partialPrices":      false,
    "generatedAt":        "2026-06-19T17:52:00.000Z"
  }
}
```

---

### `GET /portfolio/intelligence/alerts`

**Alert engine.** Returns all active alerts across all intelligence modules, sorted by severity (CRITICAL first, then WARNING, then INFO). Fetches live prices once internally via `_fetchLivePrices()`.

Query params:
- `?live=true` — enables CMP-based alerts (stop loss, target, drawdown, 52wk signals)
- `?severity=CRITICAL` — filter by severity (CRITICAL / WARNING / INFO)

Response shape:
```json
{
  "ok": true,
  "data": {
    "alerts": [
      {
        "id":          "exit_TATASTEEL_STOP_LOSS_BREACHED",
        "type":        "STOP_LOSS_BREACHED",
        "severity":    "CRITICAL",
        "symbol":      "TATASTEEL",
        "company_name": "Tata Steel Ltd",
        "message":     "CMP ₹118.50 is below stop loss ₹120.00",
        "module":      "exit",
        "data":        { "cmp": 118.50, "stopLoss": 120.00, "pnlPct": -6.8 },
        "generatedAt": "2026-06-19T17:52:00.000Z"
      }
    ],
    "totalAlerts":    8,
    "criticalAlerts": 1,
    "warningAlerts":  4,
    "infoAlerts":     3,
    "generatedAt":    "2026-06-19T17:52:00.000Z"
  }
}
```

**`getAlerts()` price-fetch deduplication:** `getAlerts(userId, live)` calls `_fetchLivePrices(positions)` once and passes the resulting price map to `getExitIntelligence()`, `getPositionIntelligence()`, and `getMarketContextIntelligence()` as a parameter. No symbol is fetched more than once per `getAlerts()` call.

---

## 5. Intelligence Calculations

### 5.1 Position Score (0–100)

Each open/partial position receives a numeric score from 0 to 100 built from six independent sub-scores. The score is deterministic and reproducible from the same inputs.

#### Sub-scores and weights

| Sub-score | Max Points | Data Source | Requires Live Price |
|---|---|---|---|
| P&L Score | 25 | CMP vs avg_buy_price | Yes |
| Stop Distance Score | 20 | CMP vs stop_loss | Yes |
| Target Distance Score | 20 | CMP vs target | Yes |
| Holding Period Score | 15 | buy_date (DB) | No |
| Allocation Score | 10 | position weight in portfolio | No |
| Drawdown Score | 10 | CMP vs 52wk high (Yahoo quote) | Yes |

**Total: 100 points**

#### P&L Score (0–25)

```
pnlPct = (CMP - avg_buy_price) / avg_buy_price * 100

pnlScore:
  pnlPct >= +20%  → 25
  pnlPct >= +10%  → 20
  pnlPct >= +5%   → 15
  pnlPct >= 0%    → 10
  pnlPct >= -5%   → 6
  pnlPct >= -10%  → 3
  pnlPct < -10%   → 0
```

#### Stop Distance Score (0–20)

Measures how far CMP is above the stop loss. A position sitting just above its stop loss is riskier.

```
stopDistancePct = (CMP - stop_loss) / CMP * 100

stopDistanceScore:
  No stop_loss set          → 8   (neutral — not penalised, not rewarded)
  stopDistancePct >= 15%    → 20
  stopDistancePct >= 10%    → 16
  stopDistancePct >= 7%     → 12
  stopDistancePct >= 4%     → 8
  stopDistancePct >= 2%     → 4
  stopDistancePct < 2%      → 0   (near stop — high risk)
  CMP < stop_loss           → 0   (stop breached)
```

#### Target Distance Score (0–20)

Measures remaining upside to target. A position near its target has less reward remaining.

```
targetDistancePct = (target - CMP) / CMP * 100

targetDistanceScore:
  No target set             → 10  (neutral)
  targetDistancePct >= 20%  → 20
  targetDistancePct >= 10%  → 16
  targetDistancePct >= 5%   → 12
  targetDistancePct >= 2%   → 8
  targetDistancePct >= 0%   → 4
  CMP >= target             → 2   (target reached — consider exit)
```

#### Holding Period Score (0–15)

Rewards positions held long enough to develop. Penalises very long holds that may indicate a stale position.

```
daysHeld = today - buy_date

holdingScore:
  daysHeld 15–90 days    → 15  (sweet spot)
  daysHeld 91–180 days   → 12
  daysHeld 0–14 days     → 8   (too new to judge)
  daysHeld 181–365 days  → 6   (long hold — monitor)
  daysHeld > 365 days    → 3   (very long — review needed)
```

#### Allocation Score (0–10)

Rewards appropriately sized positions. Penalises overweight positions.

```
allocationPct = position_invested / total_portfolio_invested * 100

allocationScore:
  allocationPct <= 10%  → 10  (well-sized)
  allocationPct <= 15%  → 7
  allocationPct <= 20%  → 4
  allocationPct > 20%   → 1   (overweight — risk flag)
```

#### Drawdown Score (0–10)

Measures how far CMP is from the 52-week high (from Yahoo quote `fiftyTwoWeekHigh`). A large drawdown from the 52wk high signals weakness.

```
drawdownFromHigh = (fiftyTwoWeekHigh - CMP) / fiftyTwoWeekHigh * 100

drawdownScore:
  No 52wk high available    → 5   (neutral)
  drawdownFromHigh <= 5%    → 10  (near highs — strong)
  drawdownFromHigh <= 15%   → 8
  drawdownFromHigh <= 25%   → 5
  drawdownFromHigh <= 40%   → 2
  drawdownFromHigh > 40%    → 0   (deep drawdown)
```

#### Score → Label mapping

```
score >= 75  → "Strong Hold"
score >= 55  → "Hold"
score >= 40  → "Reduce"
score >= 25  → "Watch Closely"
score < 25   → "High Risk"
```

#### Portfolio Health Score

```
portfolioHealthScore = sum(score_i × allocationPct_i) / 100
```

Weighted average of all position scores, weighted by each position's allocation percentage. Returns `null` when there are no open positions or when all prices are unavailable (`scorePartial: true` on all positions).

#### DB-only fallback (no live price)

When `live=false` or a specific position's price fetch fails, neutral values are used for live-price-dependent sub-scores:

| Sub-score | Fallback value | Reason |
|---|---|---|
| P&L Score | 10 | Neutral — no CMP available |
| Stop Distance Score | 8 | Neutral — no CMP available |
| Target Distance Score | 10 | Neutral — no CMP available |
| Drawdown Score | 5 | Neutral — no 52wk high available |
| Holding Period Score | Full calculation | DB-only, always available |
| Allocation Score | Full calculation | DB-only, always available |

The response includes `"priceOk": false` and `"scorePartial": true` on each affected position.

---

### 5.2 Exit Intelligence

Signals are generated per open/partial position. Each signal has a `signalType` and `severity`. All signals require `live=true` (CMP must be available). When `live=false`, the endpoint returns `{ signals: [], message: "live=true required for exit signals" }`.

#### Signal types, severity, and detection rules

| Signal Type | Severity | Rule |
|---|---|---|
| `STOP_LOSS_BREACHED` | CRITICAL | `CMP < stop_loss` |
| `STOP_LOSS_NEAR` | WARNING | `(CMP - stop_loss) / CMP * 100 < 3%` AND `CMP >= stop_loss` |
| `TARGET_REACHED` | WARNING | `CMP >= target` |
| `TARGET_NEAR` | INFO | `(target - CMP) / CMP * 100 <= 5%` AND `CMP < target` |
| `EXCESSIVE_DRAWDOWN` | WARNING | `pnlPct <= -15%` AND `pnlPct > -25%` |
| `CRITICAL_DRAWDOWN` | CRITICAL | `pnlPct <= -25%` |
| `LARGE_UNREALIZED_GAIN` | INFO | `pnlPct >= +25%` |
| `LARGE_UNREALIZED_LOSS` | WARNING | `pnlPct <= -10%` AND `pnlPct > -15%` |

**Signal precedence rules:**
- `CRITICAL_DRAWDOWN` and `EXCESSIVE_DRAWDOWN` are mutually exclusive. Only the more severe fires.
- `LARGE_UNREALIZED_LOSS` only fires when `pnlPct` is in the range (-15%, -10%]. It does not fire when `EXCESSIVE_DRAWDOWN` or `CRITICAL_DRAWDOWN` is already active.
- A position can generate multiple signals simultaneously (e.g., `STOP_LOSS_NEAR` + `LARGE_UNREALIZED_LOSS`).
- Signals are only generated when `priceOk = true` (live price available for that position).
- If no `stop_loss` is set on a position, `STOP_LOSS_BREACHED` and `STOP_LOSS_NEAR` are never generated.
- If no `target` is set on a position, `TARGET_REACHED` and `TARGET_NEAR` are never generated.

---

### 5.3 Portfolio Intelligence

Reuses `analyticsService.getRisk(userId)` and `analyticsService.getAllocation(userId, false)` directly. No new DB queries. `getAllocation()` is called with `live=false` — concentration warnings are based on invested capital, not floating current value. This is the correct basis for risk assessment.

#### Warning types and thresholds

| Warning Type | Severity | Threshold | Source |
|---|---|---|---|
| `OVERWEIGHT_POSITION` | WARNING | Single position > 20% of portfolio | `getRisk().largestPositionPct` |
| `OVERWEIGHT_POSITION` | CRITICAL | Single position > 30% of portfolio | `getRisk().largestPositionPct` |
| `OVERWEIGHT_SECTOR` | WARNING | Single sector > 35% of portfolio | `getAllocation().sectorAllocation` |
| `OVERWEIGHT_SECTOR` | CRITICAL | Single sector > 50% of portfolio | `getAllocation().sectorAllocation` |
| `CONCENTRATION_WARNING` | WARNING | HHI > 1500 (Moderate) | `getRisk().hhiScore` |
| `CONCENTRATION_WARNING` | CRITICAL | HHI > 2500 (Concentrated) | `getRisk().hhiScore` |
| `EXPOSURE_WARNING` | WARNING | Capital deployed > 85% of total capital | `getRisk().exposurePct` |
| `EXPOSURE_WARNING` | CRITICAL | Capital deployed > 95% of total capital | `getRisk().exposurePct` |
| `RISK_ESCALATION` | WARNING | `stockConcentrationRisk = HIGH` AND `sectorConcentrationRisk = HIGH` | `getRisk()` |

**Overall `riskLevel`:**
```
Any CRITICAL warning present → "HIGH"
Any WARNING present          → "MEDIUM"
No warnings                  → "LOW"
```

---

### 5.4 Trade Quality Intelligence

All calculations from `trade_history` and `positions`. No live prices needed.

#### Best/Worst Performing Sector

From `analyticsService.getAllocation(userId, false)` → `sectorPerformance` array (Phase 4). Ranked by `totalPnL` (realized P&L for closed positions; unrealized excluded since `live=false`). The response includes `tradeCount` per sector to provide context for the absolute P&L figure.

- **Best sector:** highest `totalPnL` in `sectorPerformance` (minimum 1 closed trade)
- **Worst sector:** lowest `totalPnL` in `sectorPerformance` (minimum 1 closed trade)

#### Best/Worst Trade Pattern (Holding Period Buckets)

Group closed trades from `trade_history` by holding period bucket using a SQL `CASE` expression on the existing `holding_days` column:

```sql
SELECT
  CASE
    WHEN holding_days <= 3   THEN 'Scalp (≤3d)'
    WHEN holding_days <= 14  THEN 'Short Hold (4–14d)'
    WHEN holding_days <= 60  THEN 'Swing (15–60d)'
    WHEN holding_days <= 180 THEN 'Position (61–180d)'
    ELSE                          'Long Hold (>180d)'
  END AS pattern,
  COUNT(*)                                              AS trade_count,
  ROUND(AVG(pnl_pct), 2)                               AS avg_pnl_pct,
  ROUND(AVG(pnl_pct) FILTER (WHERE pnl > 0), 2)        AS avg_winner_pct,
  COUNT(*) FILTER (WHERE pnl > 0)                       AS wins,
  ROUND(
    COUNT(*) FILTER (WHERE pnl > 0)::numeric / COUNT(*) * 100, 1
  )                                                     AS win_rate
FROM trade_history
WHERE user_id = $1
  AND transaction_type IN ('SELL', 'PARTIAL_SELL')
  AND holding_days IS NOT NULL
GROUP BY 1
ORDER BY avg_pnl_pct DESC
```

- **Best pattern:** bucket with highest `avg_pnl_pct` (minimum 3 trades to qualify)
- **Worst pattern:** bucket with lowest `avg_pnl_pct` (minimum 3 trades to qualify)
- All five buckets are returned in the `all` array regardless of trade count

#### Average Winner / Average Loser

Directly from `analyticsService.getHealth(userId)`:
- `avgWinner` = `grossProfit / winningTrades`
- `avgLoser` = `grossLoss / losingTrades`

#### Profit Factor Analysis

From `analyticsService.getHealth(userId)`:
- `profitFactor` = `grossProfit / grossLoss`

Label mapping:
```
profitFactor >= 3.0  → "Excellent"
profitFactor >= 2.0  → "Strong"
profitFactor >= 1.5  → "Good"
profitFactor >= 1.0  → "Breakeven"
profitFactor < 1.0   → "Losing"
profitFactor = null  → "Insufficient data"  (no losing trades yet)
```

#### Holding Period Analysis

From `analyticsService.getTimeline(userId)` → `holdingPeriod`:
- `avgDays`, `avgDaysWinners`, `avgDaysLosers`
- Derived insight string: `"Winners held {ratio}x longer than losers"` where `ratio = round(avgDaysWinners / avgDaysLosers, 1)`
- If `avgDaysLosers = 0` or `null`: insight = `"Insufficient data for holding period comparison"`

---

### 5.5 Market Context Intelligence

Cross-references the user's open positions against `scanner.lastResults` (in-memory) and optionally live Yahoo quotes. **No new scan is triggered.**

#### Signal detection rules

| Signal Type | Severity | Rule | Source | Requires live=true |
|---|---|---|---|---|
| `IN_BREAKOUT` | INFO | Position symbol in `scanner.lastResults` with `cat === 'active'` | `scanner.lastResults` | No |
| `VOLUME_SURGE` | INFO | Position symbol in `scanner.lastResults` with `vol >= 2.5` | `scanner.lastResults` | No |
| `NEAR_52W_HIGH` | INFO | `(fiftyTwoWeekHigh - CMP) / fiftyTwoWeekHigh * 100 <= 5%` | `market.fetchYahooQuote()` | **Yes** |
| `NEAR_52W_LOW` | WARNING | `(CMP - fiftyTwoWeekLow) / fiftyTwoWeekLow * 100 <= 5%` | `market.fetchYahooQuote()` | **Yes** |
| `RS_LEADER` | INFO | Position symbol in `scanner.lastResults` with `rs >= 80` | `scanner.lastResults` | No |
| `RS_WEAKNESS` | WARNING | Position symbol in `scanner.lastResults` with `rs < 40` | `scanner.lastResults` | No |

**Coverage note for RS and scanner-based signals:**
`IN_BREAKOUT`, `VOLUME_SURGE`, `RS_LEADER`, and `RS_WEAKNESS` are only generated for portfolio stocks that appear in `scanner.lastResults`. Stocks not in the scanner result set (did not match a pattern or did not pass confidence threshold) will not receive these signals. The response field `"rsSignalCoverage": "scanner_only"` documents this limitation explicitly.

**`NEAR_52W_HIGH` and `NEAR_52W_LOW`** use the `fiftyTwoWeekHigh` and `fiftyTwoWeekLow` fields from `market.fetchYahooQuote()`. These are available for any portfolio stock regardless of whether it appears in scanner results. These signals are only generated when `live=true`.

**`scannerAge`** is computed as a human-readable string from `scanner.lastMeta.lastScanAt`. If the scanner has not run yet, `scannerAge` is `null`.

---

## 6. Alert Framework

### Alert Object Structure

Every alert generated by the intelligence engine conforms to this structure:

```js
{
  id:           string,   // deterministic: `${module}_${symbol}_${type}`
  type:         string,   // alert type constant (see below)
  severity:     string,   // "CRITICAL" | "WARNING" | "INFO"
  symbol:       string,   // stock symbol (null for portfolio-level alerts)
  company_name: string,   // company display name (null for portfolio-level alerts)
  message:      string,   // human-readable description
  module:       string,   // "exit" | "portfolio" | "market" | "position"
  data:         object,   // supporting numbers (cmp, stopLoss, pnlPct, etc.)
  generatedAt:  string,   // ISO timestamp
}
```

### Alert Type Constants

#### Exit Module Alerts

| Type | Severity | Trigger |
|---|---|---|
| `STOP_LOSS_BREACHED` | CRITICAL | CMP < stop_loss |
| `STOP_LOSS_NEAR` | WARNING | CMP within 3% above stop_loss |
| `TARGET_REACHED` | WARNING | CMP >= target |
| `TARGET_NEAR` | INFO | CMP within 5% below target |
| `CRITICAL_DRAWDOWN` | CRITICAL | pnlPct <= -25% |
| `EXCESSIVE_DRAWDOWN` | WARNING | pnlPct in (-25%, -15%] |
| `LARGE_UNREALIZED_GAIN` | INFO | pnlPct >= +25% |
| `LARGE_UNREALIZED_LOSS` | WARNING | pnlPct in (-15%, -10%] |

#### Portfolio Module Alerts

| Type | Severity | Trigger |
|---|---|---|
| `OVERWEIGHT_POSITION` | WARNING | Position > 20% of portfolio |
| `OVERWEIGHT_POSITION` | CRITICAL | Position > 30% of portfolio |
| `OVERWEIGHT_SECTOR` | WARNING | Sector > 35% of portfolio |
| `OVERWEIGHT_SECTOR` | CRITICAL | Sector > 50% of portfolio |
| `CONCENTRATION_WARNING` | WARNING | HHI > 1500 |
| `CONCENTRATION_WARNING` | CRITICAL | HHI > 2500 |
| `EXPOSURE_WARNING` | WARNING | Capital deployed > 85% |
| `EXPOSURE_WARNING` | CRITICAL | Capital deployed > 95% |
| `RISK_ESCALATION` | WARNING | Both stock and sector concentration = HIGH |

#### Market Module Alerts

| Type | Severity | Trigger |
|---|---|---|
| `PORTFOLIO_STOCK_BREAKOUT` | INFO | Open position in active scanner breakout |
| `PORTFOLIO_STOCK_VOLUME_SURGE` | INFO | Open position with vol >= 2.5x |
| `PORTFOLIO_STOCK_NEAR_52W_HIGH` | INFO | Open position within 5% of 52wk high (live) |
| `PORTFOLIO_STOCK_NEAR_52W_LOW` | WARNING | Open position within 5% of 52wk low (live) |
| `RS_LEADER_IN_PORTFOLIO` | INFO | Open position with rs >= 80 in scanner results |
| `RS_WEAKNESS_IN_PORTFOLIO` | WARNING | Open position with rs < 40 in scanner results |

### Severity System

```
CRITICAL  — Requires immediate attention. Stop loss breached, critical drawdown,
            extreme concentration. Displayed prominently in red.

WARNING   — Requires monitoring. Near stop, target reached, sector overweight,
            RS weakness, near 52wk low. Displayed in amber/orange.

INFO      — Positive or neutral context. Target near, breakout, RS leader,
            near 52wk high, volume surge. Displayed in blue/green.
```

### Alert Deduplication

The `id` field is a deterministic string: `${module}_${symbol}_${type}`. The same condition always produces the same alert ID. The frontend can use this for deduplication and "dismiss" tracking without any server-side state.

### Alert Sort Order

Alerts are returned sorted by severity priority: CRITICAL first, then WARNING, then INFO. Within each severity group, alerts are sorted by module: `exit` → `portfolio` → `market`.

### Price Fetch Deduplication in `getAlerts()`

`getAlerts(userId, live)` calls `_fetchLivePrices(positions)` once and passes the resulting `Map<symbol, quote>` to:
- `getExitIntelligence(userId, live, priceMap)`
- `getPositionIntelligence(userId, live, priceMap)` (for position-score-based alerts)
- `getMarketContextIntelligence(userId, live, priceMap)` (for 52wk signals)

No symbol is fetched more than once per `getAlerts()` call. The same deduplication applies to the aggregated `GET /portfolio/intelligence?live=true` endpoint.

---

## 7. Database Impact

### New Tables Required

**None.**

### New Migrations Required

**None.**

### Explanation

Every Phase 5 calculation is derived entirely from existing data:

| Intelligence Module | Data Source | New DB Query? |
|---|---|---|
| Position Score | `positions` (DB) + Yahoo quote | No (same query pattern as Phase 2) |
| Exit Intelligence | `positions.stop_loss`, `positions.target` + CMP | No (same query pattern as Phase 2) |
| Portfolio Intelligence | `analyticsService.getRisk()` + `getAllocation(false)` | No (delegates to Phase 4) |
| Trade Quality | `trade_history` + `analyticsService.getHealth()` + `getTimeline()` | Yes — one new SQL query (holding-period buckets on existing table) |
| Market Context | `scanner.lastResults` (in-memory) + Yahoo quote | No new DB query |
| Alerts | Aggregated from all above | No additional queries |

The only new SQL in Phase 5 is the holding-period bucket `CASE` query in `getTradeQualityIntelligence()`. It queries the existing `trade_history` table. The existing `idx_trade_history_user_executed` index on `(user_id, executed_at DESC)` serves this query. No schema changes are needed.

### Why No New Tables

- Position scores are point-in-time calculations. Storing them would require a background job to keep them fresh and would consume storage on the free-tier PostgreSQL instance.
- Alert history (if needed in Phase 6/7) can be added as a single lightweight table at that time, but Phase 5 does not require it.
- All intelligence is cheap to recalculate on demand (< 200ms for a 20-position portfolio with live prices).

---

## 8. Performance Considerations

### Response Time Budget

| Endpoint | Expected Latency | Notes |
|---|---|---|
| `GET /intelligence/portfolio` | < 50ms | DB-only, delegates to Phase 4 |
| `GET /intelligence/trade-quality` | < 80ms | Phase 4 delegates + one new SQL query |
| `GET /intelligence/market` (no live) | < 10ms | In-memory scanner cross-reference only |
| `GET /intelligence/positions?live=true` | 200–800ms | N parallel Yahoo fetches |
| `GET /intelligence/exit?live=true` | 200–800ms | Same Yahoo fetches as positions |
| `GET /intelligence/market?live=true` | 200–800ms | Yahoo fetches for 52wk signals |
| `GET /intelligence/alerts?live=true` | 200–800ms | All modules, prices fetched once |
| `GET /intelligence?live=true` | 200–800ms | All modules, prices fetched once |

### Price Fetch Deduplication

`_fetchLivePrices(positions)` is a private method that:
1. Calls `market.fetchYahooQuote()` for each open position in parallel via `Promise.allSettled()`.
2. Returns a `Map<symbol, quote>` where `quote` is the full Yahoo response object.
3. Is called once per request in both `getAlerts()` and the aggregated `GET /intelligence` handler.
4. All sub-methods that need live prices accept an optional `priceMap` parameter. When provided, they use it directly. When not provided (standalone endpoint calls), they call `_fetchLivePrices()` themselves.

### Redis Caching

Intelligence results are **not cached by default** because they depend on live prices that change every 15 seconds. However:

- Yahoo quotes are cached in Redis with a 15-second TTL by `MarketDataService.fetchYahooQuote()`. Repeated calls within 15 seconds cost zero additional network requests.
- Scanner results are cached in Redis with a 5-minute TTL by the background worker. Market context signals are served from this cache.
- Therefore, repeated calls to `/intelligence?live=true` within 15 seconds are served entirely from Redis at the quote level.

### Concurrency

All live price fetches use `Promise.allSettled()`. A single failed Yahoo fetch never blocks the rest of the portfolio. Positions with failed price fetches receive `priceOk: false` and `scorePartial: true`.

### Free-Tier PostgreSQL

- No new tables, no new indexes required.
- The holding-period bucket query uses the existing `idx_trade_history_user_executed` index.
- All queries are bounded by `user_id` — no full-table scans.
- Phase 5 adds at most 2 new DB queries per request (positions fetch + holding-period bucket query). All other data comes from Phase 4 method calls or in-memory scanner results.

---

## 9. Future Compatibility

### Phase 6 — Portfolio Frontend

Phase 5 is designed as a clean API layer that the Phase 6 frontend can consume directly.

- **Position cards** display the score badge (0–100), label ("Strong Hold", "Watch Closely"), and `cap_category` badge from `/intelligence/positions`.
- **Portfolio header** displays `portfolioHealthScore` (0–100) as a single portfolio health indicator.
- **Alert banner** at the top of the portfolio page is populated from `/intelligence/alerts?live=true&severity=CRITICAL`.
- **Exit signal panel** is a dedicated section fed by `/intelligence/exit?live=true`.
- **Market context panel** (scanner cross-reference) is a sidebar fed by `/intelligence/market`.
- **Trade quality panel** is a "Report Card" section fed by `/intelligence/trade-quality`.
- The aggregated `GET /intelligence?live=true` endpoint allows the frontend to make a single API call to populate the entire intelligence dashboard.
- All response fields include `exchange` and `positionId`, enabling the frontend to construct Yahoo symbols and deep-link to position detail views.

### Phase 7 — Premium Dashboard

Phase 5 lays the groundwork for a premium tier:

- **Trade Quality Intelligence** (`/intelligence/trade-quality`) provides the data for a "Trading Report Card" — a premium feature showing profit factor, best/worst patterns, and holding period insights.
- **Alert Engine** can be extended in Phase 7 to support persistent alert history (one new table: `intelligence_alerts`) and push notifications (WebSocket already exists in `websocket.js`).
- **Portfolio Health Score** (`portfolioHealthScore` in the positions summary) is a premium dashboard widget that requires no additional computation — it is already calculated in Phase 5.
- The `IntelligenceService` constructor accepts `scanner` and `market` as injectable dependencies, making it straightforward to add new data sources (e.g., options data, FII/DII flows) in Phase 7 without restructuring the service.
- All endpoints follow the existing `{ ok, data }` response envelope and `x-user-id` auth pattern, so the Phase 7 frontend can consume them without any API contract changes.
- The deterministic alert `id` format (`${module}_${symbol}_${type}`) enables Phase 7 to add a persistent `dismissed_alerts` table keyed on these IDs without any changes to the Phase 5 alert generation logic.

---

## Summary of Deliverables

| Item | Description |
|---|---|
| **1 new file** | `backend/src/services/intelligenceService.js` (~700 lines) |
| **1 new file** | `backend/src/routes/intelligence.js` (~130 lines) |
| **1 modified file** | `backend/src/index.js` (4 additions, ~12 lines total) |
| **0 new DB tables** | All intelligence calculated from existing data |
| **0 new migrations** | No schema changes required |
| **7 new API endpoints** | Root + 6 modules under `/portfolio/intelligence/*` |
| **No AI, no paid APIs** | All rules are deterministic and objective |

---

## Applied Changes Summary

| Change | Section Updated | Description |
|---|---|---|
| RC1 | §5.5, §6 Alert Types | `NEAR_52W_HIGH` moved to live-price-based signal using `fiftyTwoWeekHigh` from Yahoo quote |
| RC3 | §5.2, §6 Alert Types | `EXCESSIVE_DRAWDOWN` (WARNING, -15% to -25%) and `CRITICAL_DRAWDOWN` (CRITICAL, <= -25%) — two distinct constants, mutually exclusive |
| RC5 | §4 Response Shapes | `positionId`, `exchange`, `company_name`, `cap_category` added to position intelligence response |
| RC6 | §4 Response Shapes | `company_name` and `exchange` added to exit intelligence signal response |
| RC7 | §4, §5.1 | `portfolioHealthScore` added to position intelligence summary; formula documented |
| RC8 | §2, §6 | `getAlerts()` price-fetch deduplication explicitly specified; `priceMap` parameter pattern documented |
| RC9 | §5.2, §6 Alert Types | `TARGET_REACHED` elevated from INFO to WARNING |
| RC11 | §2 Files to Create | Zero-position handling explicitly specified for all six methods |
| RC12 | §4 Response Shapes | `scoredAt` renamed to `generatedAt` across all module responses |

---

*Plan revised. Awaiting approval before writing code.*
