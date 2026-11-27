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
  type TimingLearning,
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
 * Portfolio cards. v4.5: each run has its OWN bankroll — the cards
 * show the active tab's pool (`label` names it), never a shared pool.
 */
function PortfolioCards({
  portfolio,
  trades,
  label,
}: {
  portfolio: Portfolio;
  trades: Trade[];
  label: string;
}) {
  const starting = portfolio.starting_value ?? STARTING_DEFAULT;
  const pnl = portfolio.pnl ?? portfolio.total_value - starting;
  const pnlPct = starting ? (pnl / starting) * 100 : 0;
  const openTrades = trades.filter((t) => !tradeIsSettled(t)).length;
  const settledTrades = trades.length - openTrades;
  return (
    <section className="cards">
      <div className="card card-total">
        <div className="card-label">{label}</div>
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

/**
 * Stats grid for one BTC run (trend or timing), computed from that
 * run's trades only. Shared by both BTC tabs.
 */
function RunStats({ trades }: { trades: Trade[] }) {
  const legs = trades.flatMap((t) => t.legs ?? []);
  const settledLegs = legs.filter(isLegSettled);
  const wonLegs = settledLegs.filter((leg) => (leg.payout_usd ?? 0) > 0);
  const openLegs = legs.filter((leg) => !isLegSettled(leg));
  const outlay = trades.reduce((s, t) => s + (t.outlay_usd ?? 0), 0);
  const realised = trades
    .filter(tradeIsSettled)
    .reduce((s, t) => s + tradeRealisedPnl(t), 0);
  const winRate =
    settledLegs.length > 0
      ? (wonLegs.length / settledLegs.length) * 100
      : null;
  return (
    <div className="best-grid">
      <div>
        <span className="kv-label">Bets placed</span>
        <span className="kv-value">{trades.length}</span>
      </div>
      <div>
        <span className="kv-label">Total outlay</span>
        <span className="kv-value">{fmtUsd(outlay)}</span>
      </div>
      <div>
        <span className="kv-label">Realised P&amp;L</span>
        <span
          className={`kv-value ${realised >= 0 ? "txt-pos" : "txt-neg"}`}
        >
          {fmtSignedUsd(realised)}
        </span>
      </div>
      <div>
        <span className="kv-label">Win rate (settled legs)</span>
        <span className="kv-value">
          {winRate === null
            ? "—"
            : `${wonLegs.length}/${settledLegs.length} (${winRate.toFixed(0)}%)`}
        </span>
      </div>
      <div>
        <span className="kv-label">Open positions</span>
        <span className="kv-value">{openLegs.length}</span>
      </div>
    </div>
  );
}

/**
 * "What I've learned" — the timing model's per-entry-minute record.
 * The best minute (highest predicted payout from the model's linear
 * regression) is highlighted. When nothing has been bet yet, the model
 * is still learning and there is nothing to show.
 */
function TimingLearningSection({
  learning,
}: {
  learning: TimingLearning | undefined;
}) {
  const minutes = [...(learning?.minutes ?? [])].sort(
    (a, b) => a.entry_minute - b.entry_minute,
  );
  const totalBets = minutes.reduce((s, m) => s + (m.bets ?? 0), 0);
  const bestMinute = learning?.best_minute ?? null;
  // Hours with at least one bet, in hour order. The `hours` array is
  // absent on dashboards that predate v4.7 — the table degrades to its
  // empty state instead of crashing.
  const hours = [...(learning?.hours ?? [])]
    .filter((h) => (h.bets ?? 0) > 0)
    .sort((a, b) => a.hour - b.hour);
  const bestHour = learning?.best_hour ?? null;

  return (
    <section className="card">
      <h2>What I&apos;ve learned</h2>
      <p className="section-note">
        The timing model tries different entry minutes in the 15-minute
        window and records what each one pays. It fits a linear regression
        over those records — expected payout as a function of entry minute
        — and bets mostly at the best minute so far, while still trying
        other minutes about 20% of the time so it keeps learning. It
        doesn&apos;t have to win every bet; it has to find the minute
        that pays best over time. It also records the hour of day (ET)
        each bet was placed in, so it can learn which hours pay best —
        and it sits out exploit bets in hours that have been losing
        money.
      </p>
      {totalBets === 0 ? (
        <p className="empty">
          No bets yet — the model is still learning.
        </p>
      ) : (
        <>
          {bestMinute !== null && (
            <p className="section-note">
              Best minute so far:{" "}
              <strong>minute {bestMinute}</strong> — the model bets there
              most often and explores other minutes the rest of the time.
            </p>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Entry minute</th>
                  <th className="num">Bets</th>
                  <th className="num">Wins</th>
                  <th className="num">Win rate</th>
                  <th className="num">Avg P&amp;L / bet</th>
                  <th className="num">Total P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {minutes.map((m) => {
                  const isBest =
                    bestMinute !== null && m.entry_minute === bestMinute;
                  return (
                    <tr
                      key={m.entry_minute}
                      className={isBest ? "row-best" : undefined}
                    >
                      <td>
                        Minute {m.entry_minute}
                        {isBest && (
                          <span className="badge badge-settled"> best</span>
                        )}
                      </td>
                      <td className="num">{m.bets}</td>
                      <td className="num">{m.wins}</td>
                      <td className="num">
                        {m.bets > 0
                          ? `${(((m.win_rate ?? 0) > 1 ? (m.win_rate ?? 0) : (m.win_rate ?? 0) * 100)).toFixed(0)}%`
                          : "—"}
                      </td>
                      <td
                        className={`num ${(m.avg_pnl ?? 0) >= 0 ? "txt-pos" : "txt-neg"}`}
                      >
                        {m.bets > 0 ? fmtSignedUsd(m.avg_pnl) : "—"}
                      </td>
                      <td
                        className={`num ${(m.total_pnl ?? 0) >= 0 ? "txt-pos" : "txt-neg"}`}
                      >
                        {m.bets > 0 ? fmtSignedUsd(m.total_pnl) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <h3>By hour of day (ET)</h3>
          {bestHour !== null && (
            <p className="section-note">
              Best hour so far: <strong>hour {bestHour} ET</strong> —
              the model prefers betting in hours that have paid best.
            </p>
          )}
          {hours.length === 0 ? (
            <p className="empty">
              No bets yet — the model is still learning.
            </p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Hour (ET)</th>
                    <th className="num">Bets</th>
                    <th className="num">Wins</th>
                    <th className="num">Win rate</th>
                    <th className="num">Avg P&amp;L / bet</th>
                    <th className="num">Total P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  {hours.map((h) => {
                    const isBest =
                      bestHour !== null && h.hour === bestHour;
                    return (
                      <tr
                        key={h.hour}
                        className={isBest ? "row-best" : undefined}
                      >
                        <td>
                          Hour {h.hour}
                          {isBest && (
                            <span className="badge badge-settled"> best</span>
                          )}
                        </td>
                        <td className="num">{h.bets}</td>
                        <td className="num">{h.wins}</td>
                        <td className="num">
                          {h.bets > 0
                            ? `${(((h.win_rate ?? 0) > 1 ? (h.win_rate ?? 0) : (h.win_rate ?? 0) * 100)).toFixed(0)}%`
                            : "—"}
                        </td>
                        <td
                          className={`num ${(h.avg_pnl ?? 0) >= 0 ? "txt-pos" : "txt-neg"}`}
                        >
                          {h.bets > 0 ? fmtSignedUsd(h.avg_pnl) : "—"}
                        </td>
                        <td
                          className={`num ${(h.total_pnl ?? 0) >= 0 ? "txt-pos" : "txt-neg"}`}
                        >
                          {h.bets > 0 ? fmtSignedUsd(h.total_pnl) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

type TopTab = "arb" | "btc_trend" | "btc_timing";

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
  // The three runs, split by the trade's `source` field. Pre-BTC trades
  // carry no source field and are arb trades.
  const arbTrades = trades.filter((t) => (t.source ?? "arb") === "arb");
  const btcTrendTrades = trades.filter((t) => t.source === "btc_trend");
  const btcTimingTrades = trades.filter((t) => t.source === "btc_timing");

  const watchlist = data?.watchlist ?? [];
  const groups: Record<string, WatchlistItem[]> = { Chess: [], NBA: [], NFL: [], Other: [] };
  for (const item of watchlist) groups[categoryOf(item)].push(item);

  const portfolio = data?.portfolio;
  // Each run has its OWN bankroll and never shares cash: the arb pool,
  // the BTC Trend pool (fresh $1,000) and the BTC Timing pool (fresh
  // $1,000). The new pools are absent until the backend deploys them.
  const btcTrendPortfolio = data?.btc_trend_portfolio;
  const btcTimingPortfolio = data?.btc_timing_portfolio;
  const activePortfolio =
    topTab === "arb"
      ? portfolio
      : topTab === "btc_trend"
        ? btcTrendPortfolio
        : btcTimingPortfolio;
  const seriesPoints = data?.series?.portfolio_value ?? [];
  const btcTrendSeriesPoints = data?.series?.btc_trend_portfolio_value ?? [];
  const btcTimingSeriesPoints =
    data?.series?.btc_timing_portfolio_value ?? [];
  const activeSeriesPoints =
    topTab === "arb"
      ? seriesPoints
      : topTab === "btc_trend"
        ? btcTrendSeriesPoints
        : btcTimingSeriesPoints;
  const apiUrl = getApiUrl();

  // The counts on the portfolio cards reflect the active tab's trades.
  const activeTrades =
    topTab === "arb"
      ? arbTrades
      : topTab === "btc_trend"
        ? btcTrendTrades
        : btcTimingTrades;
  const activeLabel =
    topTab === "arb"
      ? "Arbitrage bankroll"
      : topTab === "btc_trend"
        ? "BTC Trend bankroll"
        : "BTC Timing bankroll";

  return (
    <main className="page">
      <header className="header">
        <div>
          <h1>Paper Trader</h1>
          <p className="subtitle">
            Three separate paper runs — Kalshi vs Polymarket arbitrage, a
            fixed 12-minute Bitcoin trend bet, and a timing model that
            learns the best minute to bet. Each has its own bankroll.
            Fake money. Read-only.
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
                ["btc_trend", `BTC Trend (${btcTrendTrades.length})`],
                ["btc_timing", `BTC Timing (${btcTimingTrades.length})`],
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
            Three separate paper bankrolls — arbitrage, BTC Trend and BTC
            Timing never share cash. Arbitrage started at $10,000; BTC
            Trend and BTC Timing each started fresh at $1,000.
          </p>

          {activePortfolio ? (
            <PortfolioCards
              portfolio={activePortfolio}
              trades={activeTrades}
              label={activeLabel}
            />
          ) : (
            <section className="card">
              <p className="empty">
                This run&apos;s bankroll appears here once the backend
                deploys it — the BTC runs each started with their own
                fresh $1,000.
              </p>
            </section>
          )}

          <section className="card chart-card">
            <h2>Portfolio value over time</h2>
            <PortfolioChart points={activeSeriesPoints} startingValue={activePortfolio?.starting_value ?? STARTING_DEFAULT} />
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

          {topTab === "btc_trend" && (
            <>
              <section className="card">
                <h2>BTC Trend</h2>
                <p className="section-note">
                  Kalshi-only, on the 15-minute Bitcoin up/down market
                  (KXBTC15M — &ldquo;BTC price up in next 15
                  mins?&rdquo;). At minute 12 of four windows a day
                  (ending 10 AM, 1 PM, 4 PM and 8 PM ET) it checks the
                  Bitcoin move since the window opened: up at least 0.15%
                  and it buys Yes, down at least 0.15% and it buys No,
                  anything smaller and it sits out. Each bet is 5% of the
                  bankroll. The market settles on the CF Benchmarks
                  Bitcoin rate at the end of the window.
                </p>
                {btcTrendTrades.length === 0 ? (
                  <p className="empty">
                    No BTC Trend bets yet — the bot only bets when the
                    trend is clear at the 12-minute mark. It checks four
                    windows a day.
                  </p>
                ) : (
                  <RunStats trades={btcTrendTrades} />
                )}
              </section>

              {btcTrendTrades.length > 0 && (
                <>
                  <PositionsSection trades={btcTrendTrades} />
                  <TradesTable
                    trades={btcTrendTrades}
                    showDedupNote={false}
                    note="Kalshi-only — one leg per bet, Yes when Bitcoin was trending up at minute 12, No when it was trending down."
                  />
                </>
              )}
            </>
          )}

          {topTab === "btc_timing" && (
            <>
              <section className="card">
                <h2>BTC Timing</h2>
                <p className="section-note">
                  Kalshi-only, on the same 15-minute Bitcoin up/down
                  market as BTC Trend — but instead of always betting at
                  minute 12, this model tries different entry minutes
                  (3, 6, 9, 12, 14) and learns which one pays best. Early
                  entry means a better price but more time for the trend
                  to flip; late entry means a worse price but the outcome
                  is nearly certain. Each bet is 5% of the bankroll.
                </p>
                {btcTimingTrades.length === 0 ? (
                  <p className="empty">
                    No BTC Timing bets yet — the model is still learning.
                  </p>
                ) : (
                  <RunStats trades={btcTimingTrades} />
                )}
              </section>

              <TimingLearningSection learning={data?.timing_learning} />

              {btcTimingTrades.length > 0 && (
                <>
                  <PositionsSection trades={btcTimingTrades} />
                  <TradesTable
                    trades={btcTimingTrades}
                    showDedupNote={false}
                    note="Kalshi-only — one leg per bet. The entry minute is in the trade label."
                  />
                </>
              )}
            </>
          )}

          <footer className="footer">
            <span>
              Read-only dashboard for the paper trader (fake money, 2-week
              run). It never places trades. Three runs with separate
              bankrolls: cross-venue arbitrage, BTC 15-minute trend, and
              the BTC timing model.
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
