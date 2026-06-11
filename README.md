# BreakoutIntel V2 — Institutional NSE/BSE Trading Intelligence Platform

![BreakoutIntel V2](https://img.shields.io/badge/BreakoutIntel-V2-2563EB?style=for-the-badge)
![NSE BSE](https://img.shields.io/badge/NSE%2FBSE-Live%20Data-22C55E?style=for-the-badge)
![Free Data](https://img.shields.io/badge/Data-100%25%20Free-F59E0B?style=for-the-badge)

## Live Dashboard
**[breakoutintel-v2 →](https://Soleman1992.github.io/breakoutintel-v2)**

A Bloomberg-style dark-theme trading intelligence platform for Indian retail traders.

---

## Features

| Module | Description |
|--------|-------------|
| **Market Ribbon** | Live NIFTY50, BANKNIFTY, MIDCAP100, SMALLCAP100, INDIA VIX, A/D |
| **KPI Cards** | Breakout Candidates, Positions, Portfolio Return, Risk, Win Rate, Market Health |
| **Sector Performance** | 7 sectors with bars + donut chart, auto-refresh 15s |
| **Alerts Center** | Real-time breakout, volume surge, gap-up, FII buying alerts |
| **Breakout Scanner** | 20 NSE stocks — VCP, Darvas, Cup&Handle, RS Leader, Vol Surge, Tight Base |
| **Market Overview** | Tabbed intraday chart — NIFTY/BANKNIFTY/MIDCAP/SMALLCAP |
| **Market Internals** | Advance/Decline, New Highs/Lows, Volume, FII/DII net |
| **Stock Detail Modal** | Click any scanner row for full setup + AI analysis tip |

---

## Free Data Sources (No API Keys Needed)

| Source | Data | Latency |
|--------|------|---------|
| Yahoo Finance | ^NSEI, ^INDIAVIX, RELIANCE.NS | ~15 seconds |
| NSE India website | 52W Highs, Advance/Decline | Real-time |

---

## Quick Deploy — Render.com (Free)

```bash
# 1. Fork this repo on GitHub

# 2. Go to render.com → New → Web Service → Connect repo

# 3. Settings:
#    Root Directory: backend
#    Build Command:  npm install
#    Start Command:  npm start

# 4. Add environment variables:
#    ANTHROPIC_API_KEY = your-key (optional)
#    REDIS_URL = from upstash.com (free)
#    DATABASE_URL = from supabase.com (free)
```

---

## Local Development

```bash
# Clone
git clone https://github.com/Soleman1992/breakoutintel-v2.git
cd breakoutintel-v2

# Backend
cd backend
npm install
cp ../.env.example .env
# Edit .env with your values
npm run dev

# Open dashboard
# http://localhost:4000
```

---

## Tech Stack

- **Frontend:** Pure HTML/CSS/JS — zero build step, instant deploy
- **Backend:** Node.js + Express + WebSocket
- **Database:** PostgreSQL (Supabase free tier)
- **Cache:** Redis (Upstash free tier)
- **AI:** Claude API (Anthropic)
- **Data:** Yahoo Finance + NSE India (both free)

---

## Strategies Covered

1. VCP (Volatility Contraction Pattern) — Minervini
2. Darvas Box Breakout — Nicolas Darvas
3. Cup & Handle — William O'Neil
4. Stage 2 Breakout — Stan Weinstein
5. Relative Strength Leader — IBD
6. Volume Surge Breakout
7. Tight Consolidation Base

---

*© 2025 BreakoutIntel AI. Market data provided by Yahoo Finance & NSE India.*
