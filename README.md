# Arb Paper Trader — Dashboard

A real Next.js dashboard for the Kalshi vs Polymarket cross-venue arbitrage
**paper trader** (fake money, 2-week run). It shows the live portfolio, every
paper trade, the best signal, top signals, the watchlist, and a portfolio
value chart.

**Read-only.** This app never places trades, never sends money, and has no
login or password. It only fetches (GET) the public read-only dashboard API.

## What it shows

- Portfolio total value + P&L vs the $10,000 starting bankroll, with cash /
  open-positions value per venue (Kalshi / Polymarket) and open position
  counts.
- Portfolio-value-over-time chart (plain SVG, no external chart CDN — the
  chart code is bundled).
- Best signal card + top 20 signals by net edge.
- Trades table, newest first: label, legs, cost, contracts, outlay, fees,
  net edge, locked-in profit, status. A banner flags when all trades are
  still open/unsettled.
- Watchlist grouped by Chess / NBA / NFL.
- Auto-refresh every 60s + a manual Refresh button, a "last updated"
  timestamp, a loading spinner while fetching, and a clear error banner (with
  the actual error) if the API can't be reached — the last good data stays on
  screen instead of going blank.

## Data source

The app fetches the dashboard API **client-side, in the browser**:

```
https://idox5intcqigk2awm73y43ynly0ndvmv.lambda-url.us-east-1.on.aws/
```

That is an AWS Lambda Function URL (public, no auth) backed by the
`arb-sim-dashboard-readonly` Lambda. The API is slow (~8–13s per call)
because it re-derives the slate on every call; the app waits up to 45s per
fetch before timing out.

Override the URL with an env var (see `.env.example`):

```
NEXT_PUBLIC_ARB_API_URL=https://idox5intcqigk2awm73y43ynly0ndvmv.lambda-url.us-east-1.on.aws/
```

If the variable is unset, the app defaults to the URL above.

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000.

## Build

```bash
npm run build
npm run start
```

## Deploy on Vercel

1. Push this folder to a GitHub repo (e.g. `arb-dashboard`).
2. In Vercel: **Add New → Project → Import** the repo.
3. Framework is auto-detected as **Next.js**. No build settings need changing
   — the defaults (`npm install`, `npm run build`) work.
4. Optional: in **Settings → Environment Variables**, set
   `NEXT_PUBLIC_ARB_API_URL` to the Function URL above. If you skip this, the
   app uses the default URL baked into the code.
5. Deploy. The site is a static-ish single page; every visitor's browser
   fetches the API directly.

## Files

- `app/page.tsx` — the whole dashboard (client component: fetch, refresh,
  tables, watchlist).
- `app/layout.tsx` — page metadata + shell.
- `app/globals.css` — all styling (no CSS framework, no external fonts).
- `components/PortfolioChart.tsx` — bundled SVG line chart (total + per-venue).
- `lib/api.ts` — API types, fetch with timeout, formatting helpers.
