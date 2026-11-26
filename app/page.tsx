"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import PortfolioChart from "../components/PortfolioChart";
import {
  FETCH_TIMEOUT_MS,
  fetchDashboard,
  fmtCents,
  fmtSignedUsd,
  fmtTime,
  fmtUsd,
  getApiUrl,
  isLegSettled,
  legRealisedPnl,
  positionLabel,
  timeAgo,
  tradeIsSettled,
  tradeRealisedPnl,
  uniqueArbTrades,
  venueLabel,
  type DashboardData,
  type Leg,
  type Portfolio,
  type Trade,
  type WatchlistItem,
} from "../lib/api";

const REFRESH_MS = 60_000;
const STARTING_DEFAULT = 10_000;

function legsSummary(legs: Leg[] | undefined): string {
  if (!legs || legs.length === 0) return "";
  return legs
    .map((l) => {
      const venue = l.venue === "kalshi" ? "Kalshi" : "Poly";
      const price =
        l.entry_price_cents ?? l.ask_cents ?? l.bid_cents ?? undefined;
      const prop = l.proposition ?? l.title ?? "";
      const side = (l.side ?? "").toUpperCase();
      const priceTxt = price !== undefined ? ` ${price}¢` : "";
      const n =
        l.contracts !== undefined ? ` ×${Math.round(l.contracts)}` : "";
      return `${venue} ${prop} ${side}${priceTxt}${n}`;
    })
    .join("  ·  ");
}

function categoryOf(item: WatchlistItem): string {
  const prefix = item.key.split("-")[0].toLowerCase();
  if (prefix === "chess") return "Chess";
  if (prefix === "nba") return "NBA";
  if (prefix === "nfl") return "NFL";
  return "Other";
}

type PosTab = "open" | "won" | "lost";

/** Outcome badge for one leg. Settlement comes from isLegSettled only. */
function legOutcome(leg: Leg): { label: string; cls: string } {
  if (!isLegSettled(leg)) return { label: "OPEN", cls: "badge-open" };
  return (leg.payout_usd ?? 0) > 0
    ? { label: "WON", cls: "badge-won" }
    : { label: "LOST", cls: "badge-lost" };
}

/**
 * One row per leg. Payout is shown explicitly as $0.00 for a settled leg
 * that paid nothing, never as "—", so a loss is unmistakable. The Trade
 * column shows the parent trade's label and, for settled legs, that
 * trade's overall realised P&L — a losing leg can belong to a trade
 * that still made money.
 */
function PositionLegTable({
  rows,
  settled,
  emptyText,
}: {
  rows: { leg: Leg; trade: Trade }[];
  settled: boolean;
  emptyText: string;
}) {
  if (rows.length === 0) return <p className="empty">{emptyText}</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Outcome</th>
            <th>Venue</th>
            <th>Market</th>
            <th>Position</th>
            <th className="num">Entry</th>
            <th className="num">Contracts</th>
            <th className="num">Outlay</th>
            <th className="num">Payout</th>
            <th className="num">Realised P&amp;L</th>
            <th>Trade</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ leg, trade }) => {
            const outcome = legOutcome(leg);
            const pnl = settled ? legRealisedPnl(leg) : null;
            return (
              <tr
                key={`${trade.trade_id ?? trade.signal_id ?? trade.timestamp}-${leg.venue}-${leg.market_id ?? leg.proposition}-${leg.side}`}
              >
                <td>
                  <span className={`badge ${outcome.cls}`}>
                    {outcome.label}
                  </span>
                </td>
                <td>{venueLabel(leg.venue)}</td>
                <td>{leg.title ?? leg.proposition ?? "—"}</td>
                <td className="nowrap">{positionLabel(leg)}</td>
                <td className="num">
                  {leg.entry_price_cents !== undefined
                    ? `${leg.entry_price_cents}¢`
                    : "—"}
                </td>
                <td className="num">
                  {leg.contracts !== undefined
                    ? Math.round(leg.contracts)
                    : "—"}
                </td>
                <td className="num">{fmtUsd(leg.outlay_usd)}</td>
                <td className="num">
                  {settled ? fmtUsd(leg.payout_usd ?? 0) : "—"}
                </td>
                <td
                  className={`num ${pnl === null ? "" : pnl >= 0 ? "txt-pos" : "txt-neg"}`}
                >
                  {pnl === null ? "—" : fmtSignedUsd(pnl)}
                </td>
                <td>
                  <div>{trade.label}</div>
                  {settled && (
                    <div className="legs">
                      trade realised {fmtSignedUsd(tradeRealisedPnl(trade))}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Positions for one run (arb or model trades), with its own Open/Won/Lost
 * tabs. Won = settled leg that paid out; lost = settled leg that paid $0
 * (a null payout counts as $0).
 */
function PositionsSection({ trades }: { trades: Trade[] }) {
  // Tab the user tapped; null = follow the default (Lost when everything
  // has settled and there are losers, otherwise Open).
  const [posTabOverride, setPosTabOverride] = useState<PosTab | null>(null);

  // Positions are derived from the trades' legs, not from the portfolio's
  // open_positions counts (those are integers, not position rows).
  const legsWithTrade = trades.flatMap((t) =>
    (t.legs ?? []).map((leg) => ({ leg, trade: t })),
  );
  const openLegs = legsWithTrade.filter(({ leg }) => !isLegSettled(leg));
  const settledLegs = legsWithTrade.filter(({ leg }) => isLegSettled(leg));
  const wonLegs = settledLegs.filter(({ leg }) => (leg.payout_usd ?? 0) > 0);
  const lostLegs = settledLegs.filter(
    ({ leg }) => (leg.payout_usd ?? 0) === 0,
  );
  const openOutlay = openLegs.reduce(
    (s, { leg }) => s + (leg.outlay_usd ?? 0),
    0,
  );
  const wonPayout = wonLegs.reduce(
    (s, { leg }) => s + (leg.payout_usd ?? 0),
    0,
  );
  const wonRealised = wonLegs.reduce(
    (s, { leg }) => s + legRealisedPnl(leg),
    0,
  );
  const lostOutlay = lostLegs.reduce(
    (s, { leg }) => s + (leg.outlay_usd ?? 0),
    0,
  );
  // Combined realised P&L of the trades the losing legs belong to —
  // deduped by trade, since one trade can hold more than one losing leg.
  const lostTradeIds = new Set(
    lostLegs.map(
      ({ trade }) => trade.trade_id ?? trade.signal_id ?? trade.timestamp,
    ),
  );
  const lostTradesRealised = trades
    .filter((t) =>
      lostTradeIds.has(t.trade_id ?? t.signal_id ?? t.timestamp),
    )
    .reduce((s, t) => s + tradeRealisedPnl(t), 0);
  const defaultPosTab: PosTab =
    lostLegs.length > 0 && openLegs.length === 0 ? "lost" : "open";
  const activePosTab = posTabOverride ?? defaultPosTab;

  return (
    <section className="card">
      <h2>
        Positions ({openLegs.length} open · {settledLegs.length} settled)
      </h2>
      <p className="section-note">
        One row per position (one leg of a trade) on each venue,
        Kalshi-style. Status comes from the position itself — the
        trade-level status in the log still says &ldquo;open&rdquo; even
        after a trade settles. There is no live mark-to-market price per
        position in the API, so no current-value column is shown.
      </p>

      <div
        className="tabs"
        role="tablist"
        aria-label="Positions by outcome"
      >
        {(
          [
            ["open", `Open (${openLegs.length})`],
            ["won", `Won (${wonLegs.length})`],
            ["lost", `Lost (${lostLegs.length})`],
          ] as const
        ).map(([tab, label]) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activePosTab === tab}
            className={`tab ${activePosTab === tab ? "tab-active" : ""}`}
            onClick={() => setPosTabOverride(tab)}
          >
            {label}
          </button>
        ))}
      </div>

      {activePosTab === "open" && (
        <>
          <p className="section-note">
            {openLegs.length} open leg{openLegs.length === 1 ? "" : "s"}{" "}
            · total outlay {fmtUsd(openOutlay)}.
          </p>
          <PositionLegTable
            rows={openLegs}
            settled={false}
            emptyText="No open positions — everything has settled."
          />
        </>
      )}

      {activePosTab === "won" && (
        <>
          <p className="section-note">
            {wonLegs.length} winning leg{wonLegs.length === 1 ? "" : "s"}{" "}
            · total payout {fmtUsd(wonPayout)} · total realised P&amp;L{" "}
            <span className={wonRealised >= 0 ? "txt-pos" : "txt-neg"}>
              {fmtSignedUsd(wonRealised)}
            </span>
            .
          </p>
          <PositionLegTable
            rows={wonLegs}
            settled
            emptyText="No winning legs yet."
          />
        </>
      )}

      {activePosTab === "lost" && (
        <>
          <p className="section-note">
            {lostLegs.length} losing leg{lostLegs.length === 1 ? "" : "s"}{" "}
            · total lost {fmtUsd(lostOutlay)} (outlay paid, payout $0.00)
            · the trades those legs belong to made{" "}
            <span
              className={
                lostTradesRealised >= 0 ? "txt-pos" : "txt-neg"
              }
            >
              {fmtSignedUsd(lostTradesRealised)}
            </span>{" "}
            combined.
          </p>
          <PositionLegTable
            rows={lostLegs}
            settled
            emptyText="No losing legs — every settled leg paid out."
          />
        </>
      )}
    </section>
  );
}

/**
 * Trades table for one run. Trade status is derived from its legs
 * (settled when every leg is settled), not from the log's status field.
 * The dedup note is arb-only: the pre-v4.2 double-trading bug logged
 * some arbs twice.
 */
function TradesTable({
  trades,
  showDedupNote,
  note,
}: {
  trades: Trade[];
  showDedupNote: boolean;
  note?: string;
}) {
  // Trade status is derived from the legs — the trade-level `status` field
  // keeps its entry-time value and still says "open" for settled trades.
  const openTrades = trades.filter((t) => !tradeIsSettled(t)).length;
  const settledTrades = trades.length - openTrades;
  const totalLocked = trades.reduce(
    (s, t) => s + (t.locked_in_profit_usd ?? 0),
    0,
  );
  const totalOutlay = trades.reduce((s, t) => s + (t.outlay_usd ?? 0), 0);
  const totalRealised = trades
    .filter(tradeIsSettled)
    .reduce((s, t) => s + tradeRealisedPnl(t), 0);

  // The 37 records are 20 unique arbs — 17 were logged twice before the
  // v4.2 dedup fix, so the totals above count the duplicates. Unique
  // totals are the honest per-arb figures.
  const uniqueTrades = uniqueArbTrades(trades);
  const uniqueLocked = uniqueTrades.reduce(
    (s, t) => s + (t.locked_in_profit_usd ?? 0),
    0,
  );
  const uniqueRealised = uniqueTrades
    .filter(tradeIsSettled)
    .reduce((s, t) => s + tradeRealisedPnl(t), 0);

  return (
    <section className="card">
      <h2>
        Trades ({trades.length})
        {openTrades > 0 && settledTrades === 0 && (
          <span className="h2-note">
            All open — none have settled yet
          </span>
        )}
      </h2>
      <p className="section-note">
        Total outlay {fmtUsd(totalOutlay)}
        {showDedupNote && (
          <>
            {" "}· locked-in profit if all settle as expected{" "}
            {fmtUsd(totalLocked)}
          </>
        )}{" "}
        · realised P&amp;L so far {fmtSignedUsd(totalRealised)}. Trade
        status is derived from its legs (settled when every leg is
        settled), not from the log&apos;s status field.
        {showDedupNote && (
          <>
            {" "}The {trades.length} records are {uniqueTrades.length}{" "}
            unique arbs — 17 were logged twice before the v4.2 dedup fix —
            so the totals count the duplicates; counted once each, locked
            profit is {fmtUsd(uniqueLocked)} and realised P&amp;L is{" "}
            {fmtSignedUsd(uniqueRealised)}.
          </>
        )}
        {note ? ` ${note}` : ""}
      </p>
      {trades.length === 0 ? (
        <p className="empty">No trades yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Trade</th>
                <th className="num">Cost</th>
                <th className="num">Contracts</th>
                <th className="num">Outlay</th>
                <th className="num">Fees</th>
                <th className="num">Net edge</th>
                <th className="num">Locked profit</th>
                <th className="num">Realised P&amp;L</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => {
                const settled = tradeIsSettled(t);
                return (
                  <tr key={t.trade_id ?? t.signal_id ?? t.timestamp}>
                    <td className="nowrap">{fmtTime(t.timestamp)}</td>
                    <td>
                      <div>{t.label}</div>
                      <div className="legs">{legsSummary(t.legs)}</div>
                    </td>
                    <td className="num">{fmtCents(t.cost_cents)}</td>
                    <td className="num">
                      {t.contracts !== undefined
                        ? Math.round(t.contracts)
                        : "—"}
                    </td>
                    <td className="num">{fmtUsd(t.outlay_usd)}</td>
                    <td className="num">{fmtUsd(t.fees_usd)}</td>
                    <td className="num">{fmtCents(t.net_edge_cents)}</td>
                    <td className="num">
                      {fmtSignedUsd(t.locked_in_profit_usd)}
                    </td>
                    <td
                      className={`num pnl ${settled && tradeRealisedPnl(t) >= 0 ? "pnl-pos" : settled ? "pnl-neg" : ""}`}
                    >
                      {settled ? fmtSignedUsd(tradeRealisedPnl(t)) : "—"}
                    </td>
                    <td>
                      <span
                        className={`badge ${
                          settled ? "badge-settled" : "badge-open"
                        }`}
                      >
                        {settled ? "settled" : "open"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * Portfolio cards. The pool is shared between the two runs — the values
 * are the same on both tabs; only the trade counts reflect this tab.
 */
function PortfolioCards({
  portfolio,
  trades,
}: {
  portfolio: Portfolio;
  trades: Trade[];
}) {
  const starting = portfolio.starting_value ?? STARTING_DEFAULT;
  const pnl = portfolio.pnl ?? portfolio.total_value - starting;
  const pnlPct = starting ? (pnl / starting) * 100 : 0;
  const openTrades = trades.filter((t) => !tradeIsSettled(t)).length;
  const settledTrades = trades.length - openTrades;
  return (
    <section className="cards">
      <div className="card card-total">
        <div className="card-label">Total portfolio value</div>
        <div className="card-big">{fmtUsd(portfolio.total_value)}</div>
        <div className={`pnl ${pnl >= 0 ? "pnl-pos" : "pnl-neg"}`}>
          P&amp;L vs {fmtUsd(starting)}: {fmtSignedUsd(pnl)} (
          {pnlPct >= 0 ? "+" : ""}
          {pnlPct.toFixed(2)}%)
        </div>
        <div className="card-sub">
          {trades.length} trades · {openTrades} open · {settledTrades}{" "}
          settled
          {portfolio.kill_switch_active ? " · KILL SWITCH ACTIVE" : ""}
        </div>
      </div>

      {(
        [
          ["Kalshi", portfolio.kalshi],
          ["Polymarket", portfolio.polymarket],
        ] as const
      ).map(([name, v]) => (
        <div className="card" key={name}>
          <div className="card-label">{name}</div>
          <div className="card-big">{fmtUsd(v.value)}</div>
          <dl className="venue-rows">
            <div>
              <dt>Cash</dt>
              <dd>{fmtUsd(v.cash)}</dd>
            </div>
            <div>
              <dt>Open positions</dt>
              <dd>{fmtUsd(v.positions_value)}</dd>
            </div>
            <div>
              <dt>Positions</dt>
              <dd>{v.open_positions}</dd>
            </div>
          </dl>
        </div>
      ))}
    </section>
  );
}

type TopTab = "arb" | "model";

export default function Home() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [nowTick, setNowTick] = useState(0);
  const [topTab, setTopTab] = useState<TopTab>("arb");
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (isInitial: boolean) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    if (isInitial) setLoading(true);
    else setRefreshing(true);

    const timer = setTimeout(() => {
      ctrl.abort(new Error("Timed out after 45s — the API is slow, try again"));
    }, FETCH_TIMEOUT_MS);

    try {
      const json = await fetchDashboard(ctrl.signal);
      setData(json);
      setError(null);
      setLastUpdated(new Date());
    } catch (e) {
      if ((e as Error)?.name === "AbortError") {
        setError(
          "Request timed out after 45s. The API re-derives the slate on every call and can be slow — your last good data is still shown below.",
        );
      } else {
        setError(
          `Could not reach the API: ${(e as Error)?.message ?? String(e)}`,
        );
      }
      // keep last good data on screen
    } finally {
      clearTimeout(timer);
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    setNowTick(Date.now());
    load(true);
    const id = setInterval(() => load(false), REFRESH_MS);
    const tick = setInterval(() => setNowTick(Date.now()), 15_000);
    return () => {
      clearInterval(id);
      clearInterval(tick);
      abortRef.current?.abort();
    };
  }, [load]);

  const trades: Trade[] = [...(data?.trades ?? [])].sort(
    (a, b) => +new Date(b.timestamp) - +new Date(a.timestamp),
  );
  const signals = [...(data?.signals ?? [])]
    .sort((a, b) => b.net_edge_cents - a.net_edge_cents)
    .slice(0, 20);
  // The two runs, split by the trade's `source` field. Pre-model trades
  // carry no source field and are arb trades.
  const arbTrades = trades.filter((t) => (t.source ?? "arb") === "arb");
  const modelTrades = trades.filter((t) => t.source === "model");

  // Model summary, from model trades only.
  const modelLegs = modelTrades.flatMap((t) => t.legs ?? []);
  const modelSettledLegs = modelLegs.filter(isLegSettled);
  const modelWonLegs = modelSettledLegs.filter(
    (leg) => (leg.payout_usd ?? 0) > 0,
  );
  const modelOpenLegs = modelLegs.filter((leg) => !isLegSettled(leg));
  const modelOutlay = modelTrades.reduce(
    (s, t) => s + (t.outlay_usd ?? 0),
    0,
  );
  const modelRealised = modelTrades
    .filter(tradeIsSettled)
    .reduce((s, t) => s + tradeRealisedPnl(t), 0);
  const modelWinRate =
    modelSettledLegs.length > 0
      ? (modelWonLegs.length / modelSettledLegs.length) * 100
      : null;

  const watchlist = data?.watchlist ?? [];
  const groups: Record<string, WatchlistItem[]> = { Chess: [], NBA: [], NFL: [], Other: [] };
  for (const item of watchlist) groups[categoryOf(item)].push(item);

  const portfolio = data?.portfolio;
  const seriesPoints = data?.series?.portfolio_value ?? [];
  const apiUrl = getApiUrl();

  // The counts on the portfolio cards reflect the active tab's trades.
  const activeTrades = topTab === "arb" ? arbTrades : modelTrades;

  return (
    <main className="page">
      <header className="header">
        <div>
          <h1>Paper Trader</h1>
          <p className="subtitle">
            Two paper runs, one cash pool — Kalshi vs Polymarket arbitrage,
            and a self-learning betting model. Fake money. Read-only.
          </p>
        </div>
        <div className="header-right">
          <span
            className={`status-pill ${error ? "status-error" : "status-ok"}`}
          >
            {error ? "● API unreachable" : "● Live"}
          </span>
          <button
            className="refresh-btn"
            onClick={() => load(false)}
            disabled={loading || refreshing}
          >
            {refreshing || loading ? "Refreshing…" : "Refresh now"}
          </button>
        </div>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <strong>Could not reach the API.</strong>
          <span>{error}</span>
          <span className="error-detail">
            API: {apiUrl} ·{" "}
            {data
              ? "Showing the last good data below — it may be stale."
              : "No data yet — press Refresh to retry."}
          </span>
        </div>
      )}

      {loading && !data ? (
        <div className="loading-block">
          <div className="spinner" aria-label="Loading" />
          <p>
            Loading the paper trader… the API takes ~10 seconds because it
            re-derives the slate on every call.
          </p>
        </div>
      ) : (
        <>
          <section className="meta-row">
            <span>
              Last updated:{" "}
              <strong>
                {lastUpdated ? lastUpdated.toLocaleString() : "—"}
              </strong>
              {lastUpdated ? ` (${timeAgo(lastUpdated.toISOString())})` : ""}
              {refreshing ? " · refreshing…" : ""}
            </span>
            <span>
              Auto-refresh every 60s
              {data?.meta?.events_scanned
                ? ` · ${data.meta.events_scanned} events scanned`
                : ""}
              {data?.meta?.generated_at
                ? ` · API generated ${fmtTime(data.meta.generated_at)}`
                : ""}
            </span>
          </section>

          <div className="top-tabs" role="tablist" aria-label="Run">
            {(
              [
                ["arb", `Arbitrage (${arbTrades.length})`],
                ["model", `Betting Model (${modelTrades.length})`],
              ] as const
            ).map(([tab, label]) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={topTab === tab}
                className={`top-tab ${topTab === tab ? "top-tab-active" : ""}`}
                onClick={() => setTopTab(tab)}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="section-note">
            One shared cash pool — the arbitrage bot and the betting model
            bet from the same $10,000. The portfolio cards below are the
            shared pool; the trade counts on them are for this tab.
          </p>

          {portfolio && <PortfolioCards portfolio={portfolio} trades={activeTrades} />}

          <section className="card chart-card">
            <h2>Portfolio value over time</h2>
            <PortfolioChart points={seriesPoints} startingValue={portfolio?.starting_value ?? STARTING_DEFAULT} />
          </section>

          {topTab === "arb" && (
            <>
              {data?.best_signal && (
                <section className="card best-signal">
                  <h2>Best signal right now</h2>
                  <div className="best-label">{data.best_signal.label}</div>
                  <div className="best-grid">
                    <div>
                      <span className="kv-label">Net edge</span>
                      <span className="kv-value">
                        {fmtCents(data.best_signal.net_edge_cents)}
                      </span>
                    </div>
                    <div>
                      <span className="kv-label">Cost</span>
                      <span className="kv-value">
                        {fmtCents(data.best_signal.cost_cents)}
                      </span>
                    </div>
                    <div>
                      <span className="kv-label">Min depth</span>
                      <span className="kv-value">
                        {data.best_signal.depth_min_usd !== undefined
                          ? fmtUsd(data.best_signal.depth_min_usd)
                          : "—"}
                      </span>
                    </div>
                    <div>
                      <span className="kv-label">Tradeable</span>
                      <span className="kv-value">
                        {data.best_signal.tradeable ? "Yes" : "No"}
                        {data.best_signal.reason
                          ? ` — ${data.best_signal.reason}`
                          : ""}
                      </span>
                    </div>
                  </div>
                  {data.best_signal.event_name && (
                    <div className="card-sub">{data.best_signal.event_name}</div>
                  )}
                </section>
              )}

              <PositionsSection trades={arbTrades} />

              <TradesTable trades={arbTrades} showDedupNote />

              <section className="card">
                <h2>Top signals by net edge</h2>
                {signals.length === 0 ? (
                  <p className="empty">No signals right now.</p>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Signal</th>
                          <th className="num">Net edge</th>
                          <th className="num">Cost</th>
                          <th className="num">Min depth</th>
                          <th>Tradeable</th>
                        </tr>
                      </thead>
                      <tbody>
                        {signals.map((s) => (
                          <tr key={s.id}>
                            <td>
                              <div>{s.label}</div>
                              <div className="legs">{legsSummary(s.legs)}</div>
                            </td>
                            <td className="num">{fmtCents(s.net_edge_cents)}</td>
                            <td className="num">{fmtCents(s.cost_cents)}</td>
                            <td className="num">
                              {s.depth_min_usd !== undefined
                                ? fmtUsd(s.depth_min_usd)
                                : "—"}
                            </td>
                            <td>
                              {s.tradeable ? (
                                <span className="badge badge-settled">yes</span>
                              ) : (
                                <span className="badge badge-open">
                                  no{s.reason ? ` — ${s.reason}` : ""}
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section className="card">
                <h2>Watchlist ({watchlist.length} events)</h2>
                <div className="watchlist">
                  {(["Chess", "NBA", "NFL", "Other"] as const).map((cat) => (
                    <div key={cat} className="watch-group">
                      <h3>
                        {cat} ({groups[cat].length})
                      </h3>
                      {groups[cat].length === 0 ? (
                        <p className="empty">None.</p>
                      ) : (
                        <ul>
                          {groups[cat].map((item) => (
                            <li key={item.key}>
                              <span>{item.name}</span>
                              {item.venues && (
                                <span className="legs">
                                  {" "}
                                  · {item.venues.join(" + ")}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}

          {topTab === "model" && (
            <>
              <section className="card">
                <h2>Betting Model</h2>
                <p className="section-note">
                  The self-learning model bets on Kalshi when its own
                  probability is well above the payout-implied probability
                  (edge ≥ 3¢ for singles, ≥ 5¢ for combos), sizes with
                  quarter-Kelly capped at 2% of bankroll, and records every
                  bet in its outcomes database — it learns from correct and
                  wrong outcomes. The kill switch stops it if realised model
                  P&amp;L falls below −2% of bankroll.
                </p>
                <p className="section-note">
                  Note: model bets are player props, which resolve in the
                  model&apos;s outcomes database — legs here show as settled
                  only once the API marks them settled.
                </p>
                {modelTrades.length === 0 ? (
                  <p className="empty">
                    No model bets yet — the model only bets when its edge is
                    ≥ 3¢ (singles) / ≥ 5¢ (combos). It is live and checking
                    every minute.
                  </p>
                ) : (
                  <div className="best-grid">
                    <div>
                      <span className="kv-label">Model bets placed</span>
                      <span className="kv-value">{modelTrades.length}</span>
                    </div>
                    <div>
                      <span className="kv-label">Total outlay</span>
                      <span className="kv-value">{fmtUsd(modelOutlay)}</span>
                    </div>
                    <div>
                      <span className="kv-label">Realised P&amp;L</span>
                      <span
                        className={`kv-value ${modelRealised >= 0 ? "txt-pos" : "txt-neg"}`}
                      >
                        {fmtSignedUsd(modelRealised)}
                      </span>
                    </div>
                    <div>
                      <span className="kv-label">Win rate (settled legs)</span>
                      <span className="kv-value">
                        {modelWinRate === null
                          ? "—"
                          : `${modelWonLegs.length}/${modelSettledLegs.length} (${modelWinRate.toFixed(0)}%)`}
                      </span>
                    </div>
                    <div>
                      <span className="kv-label">Open positions</span>
                      <span className="kv-value">{modelOpenLegs.length}</span>
                    </div>
                  </div>
                )}
              </section>

              {modelTrades.length > 0 && (
                <>
                  <PositionsSection trades={modelTrades} />
                  <TradesTable
                    trades={modelTrades}
                    showDedupNote={false}
                    note="A model bet wins when the event it bet on happens; a losing leg is the outlay on a leg that paid $0."
                  />
                </>
              )}
            </>
          )}

          <footer className="footer">
            <span>
              Read-only dashboard for the paper trader (fake money, 2-week
              run). It never places trades. Two runs share one cash pool:
              cross-venue arbitrage and the self-learning betting model.
            </span>
            <span>
              API: <code>{apiUrl}</code>
            </span>
            <span>
              Page rendered{" "}
              {nowTick ? new Date(nowTick).toLocaleTimeString() : "—"}
            </span>
          </footer>
        </>
      )}
    </main>
  );
}
