export const DEFAULT_API_URL =
  "https://idox5intcqigk2awm73y43ynly0ndvmv.lambda-url.us-east-1.on.aws/";

export function getApiUrl(): string {
  return (
    process.env.NEXT_PUBLIC_ARB_API_URL || DEFAULT_API_URL
  );
}

export interface VenueSummary {
  cash: number;
  positions_value: number;
  value: number;
  open_positions: number;
}

export interface Portfolio {
  total_value: number;
  starting_value: number;
  pnl: number;
  kalshi: VenueSummary;
  polymarket: VenueSummary;
  kill_switch_active?: boolean;
  last_updated?: string;
}

export interface Leg {
  venue: string;
  market_id?: string;
  title?: string;
  proposition?: string;
  side?: string;
  ask_cents?: number;
  bid_cents?: number;
  entry_price_cents?: number;
  contracts?: number;
  outlay_usd?: number;
  payout_usd?: number | null;
  status?: string;
  depth_ask_usd?: number;
  depth_bid_usd?: number;
  fee_cents?: number;
  event_key?: string;
  group?: string;
  pays_if?: string[];
}

export interface Trade {
  trade_id?: string;
  timestamp: string;
  label: string;
  status: string;
  /** "arb" (cross-venue arbitrage) or "model" (self-learning betting model). */
  source?: string;
  cost_cents: number;
  contracts: number;
  outlay_usd: number;
  fees_usd: number;
  fees_cents?: number;
  net_edge_cents: number;
  locked_in_profit_usd: number;
  group?: string;
  event_key?: string;
  signal_id?: string;
  legs?: Leg[];
}

export interface Signal {
  id: string;
  ts?: string;
  event_key?: string;
  event_name?: string | null;
  group?: string;
  label: string;
  legs?: Leg[];
  cost_cents?: number;
  fees_cents?: number;
  net_edge_cents: number;
  depth_min_usd?: number;
  depth_ok?: boolean;
  tradeable?: boolean;
  reason?: string;
}

export interface WatchlistItem {
  key: string;
  name: string;
  venues?: string[];
  kalshi_series?: string[];
  polymarket_slug?: string;
}

export interface SeriesPoint {
  ts: string;
  total: number;
  kalshi: number;
  polymarket: number;
}

export interface DashboardData {
  portfolio: Portfolio;
  trades: Trade[];
  signals: Signal[];
  best_signal: Signal | null;
  watchlist: WatchlistItem[];
  series: {
    portfolio_value: SeriesPoint[];
    best_edge?: { ts: string; edge_c: number }[];
    candidates?: { ts: string; count: number }[];
  };
  meta?: {
    generated_at?: string;
    events_scanned?: number;
    watchlist_source?: string;
  };
  generated?: string | null;
}

/** The API is slow (~8-13s) because it re-derives the slate on every call. */
export const FETCH_TIMEOUT_MS = 45000;

/** ---------- positions / settlement helpers ---------- */

/** A leg is settled only when the API says so; missing status counts as open. */
export function isLegSettled(leg: Leg | undefined): boolean {
  return leg?.status === "settled";
}

/**
 * The trade-level `status` field is unreliable — the log keeps the
 * entry-time status, so settled trades still say "open". Derive a trade's
 * settled state from its legs: settled only when it has legs and all of
 * them are settled.
 */
export function tradeIsSettled(trade: Trade): boolean {
  const legs = trade.legs ?? [];
  return legs.length > 0 && legs.every(isLegSettled);
}

/** Sum of this trade's leg payouts (null payout counts as 0). */
export function tradePayout(trade: Trade): number {
  return (trade.legs ?? []).reduce(
    (s, l) => s + (l.payout_usd ?? 0),
    0,
  );
}

/** Realised P&L for a trade = sum of leg payouts − outlay. */
export function tradeRealisedPnl(trade: Trade): number {
  return tradePayout(trade) - (trade.outlay_usd ?? 0);
}

/** Realised P&L for a single leg = payout − outlay. */
export function legRealisedPnl(leg: Leg): number {
  return (leg.payout_usd ?? 0) - (leg.outlay_usd ?? 0);
}

export function venueLabel(venue: string | undefined): string {
  return venue === "kalshi" ? "Kalshi" : venue === "polymarket" ? "Poly" : (venue ?? "—");
}

/** e.g. "Trail Blazers YES". */
export function positionLabel(leg: Leg): string {
  const prop = leg.proposition ?? leg.title ?? "";
  const side = (leg.side ?? "").toUpperCase();
  return side ? `${prop} ${side}` : prop;
}

/**
 * Group trades into unique arbs. The pre-v4.2 double-trading bug logged the
 * same arb twice — once as a Kalshi YES and once as the equivalent Kalshi
 * NO — while the Polymarket leg and the net edge are identical in both
 * records. So the Poly leg + net edge identifies one unique arb.
 * Returns one representative trade per unique arb.
 */
export function uniqueArbTrades(trades: Trade[]): Trade[] {
  const seen = new Map<string, Trade>();
  for (const t of trades) {
    const poly = (t.legs ?? []).find((l) => l.venue === "polymarket");
    const key = poly
      ? `poly:${poly.market_id ?? ""}:${poly.side ?? ""}:${poly.proposition ?? ""}:${poly.entry_price_cents ?? ""}:${t.net_edge_cents ?? ""}`
      : `trade:${t.trade_id ?? t.signal_id ?? t.timestamp}`;
    if (!seen.has(key)) seen.set(key, t);
  }
  return [...seen.values()];
}


export async function fetchDashboard(
  signal: AbortSignal,
): Promise<DashboardData> {
  const res = await fetch(getApiUrl(), {
    cache: "no-store",
    signal,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`API returned HTTP ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as DashboardData;
  if (!json || typeof json !== "object" || !json.portfolio) {
    throw new Error("API returned an unexpected payload (no portfolio)");
  }
  return json;
}

export function fmtUsd(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "—";
  const sign = n < 0 ? "−" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function fmtCents(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "—";
  return `${n.toFixed(2)}¢`;
}

export function fmtSignedUsd(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function fmtTime(iso: string | undefined | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function fmtTimeShort(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function timeAgo(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const secs = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
