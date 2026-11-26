"use client";

import { useMemo } from "react";
import type { SeriesPoint } from "../lib/api";
import { fmtTimeShort, fmtUsd } from "../lib/api";

const W = 720;
const H = 240;
const PAD = { top: 16, right: 12, bottom: 28, left: 64 };

function pointsFor(
  pts: SeriesPoint[],
  key: "total" | "kalshi" | "polymarket",
  min: number,
  max: number,
): string {
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const span = max - min || 1;
  return pts
    .map((p, i) => {
      const x =
        PAD.left + (pts.length === 1 ? innerW / 2 : (i / (pts.length - 1)) * innerW);
      const y = PAD.top + (1 - (p[key] - min) / span) * innerH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export default function PortfolioChart({
  points,
  startingValue,
}: {
  points: SeriesPoint[];
  startingValue: number;
}) {
  const { min, max } = useMemo(() => {
    if (points.length === 0) return { min: 0, max: 0 };
    const vals = points.flatMap((p) => [p.total, p.kalshi, p.polymarket]);
    let lo = Math.min(...vals, startingValue);
    let hi = Math.max(...vals, startingValue);
    const pad = Math.max((hi - lo) * 0.15, 10);
    return { min: lo - pad, max: hi + pad };
  }, [points, startingValue]);

  if (points.length < 2) {
    return (
      <div className="chart-empty">
        Not enough history yet — the chart appears once a few snapshots have
        been recorded.
      </div>
    );
  }

  const innerH = H - PAD.top - PAD.bottom;
  const span = max - min || 1;
  const startY = PAD.top + (1 - (startingValue - min) / span) * innerH;
  const first = points[0];
  const last = points[points.length - 1];

  return (
    <div className="chart-wrap">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="chart-svg"
        role="img"
        aria-label="Portfolio value over time"
      >
        {/* starting-value reference line */}
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={startY}
          y2={startY}
          className="chart-ref"
          strokeDasharray="5 4"
        />
        <text x={W - PAD.right} y={startY - 5} className="chart-label" textAnchor="end">
          start {fmtUsd(startingValue)}
        </text>
        {/* venue lines */}
        <polyline
          points={pointsFor(points, "kalshi", min, max)}
          className="chart-line chart-line-kalshi"
        />
        <polyline
          points={pointsFor(points, "polymarket", min, max)}
          className="chart-line chart-line-poly"
        />
        {/* total line */}
        <polyline
          points={pointsFor(points, "total", min, max)}
          className="chart-line chart-line-total"
        />
        {points.map((p, i) => {
          const x =
            PAD.left +
            (points.length === 1
              ? (W - PAD.left - PAD.right) / 2
              : (i / (points.length - 1)) * (W - PAD.left - PAD.right));
          const y =
            PAD.top + (1 - (p.total - min) / span) * innerH;
          return (
            <circle key={p.ts + i} cx={x} cy={y} r={3.5} className="chart-dot" />
          );
        })}
        {/* y labels */}
        <text x={PAD.left - 8} y={PAD.top + 4} className="chart-label" textAnchor="end">
          {fmtUsd(max)}
        </text>
        <text x={PAD.left - 8} y={H - PAD.bottom + 4} className="chart-label" textAnchor="end">
          {fmtUsd(min)}
        </text>
        {/* x labels */}
        <text x={PAD.left} y={H - 8} className="chart-label">
          {fmtTimeShort(first.ts)}
        </text>
        <text x={W - PAD.right} y={H - 8} className="chart-label" textAnchor="end">
          {fmtTimeShort(last.ts)}
        </text>
      </svg>
      <div className="chart-legend">
        <span>
          <i className="swatch swatch-total" /> Total
        </span>
        <span>
          <i className="swatch swatch-kalshi" /> Kalshi
        </span>
        <span>
          <i className="swatch swatch-poly" /> Polymarket
        </span>
        <span className="chart-last">
          Latest: <strong>{fmtUsd(last.total)}</strong>
        </span>
      </div>
    </div>
  );
}
