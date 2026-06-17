"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { DayTokens } from "../tasks/_components/observability";

// Daily token-usage chart for the home page. Renders a stacked bar per day
// (input on the bottom, output on top) over the supplied window, plus a
// headline for today's total and a legend with window totals. The bars are
// SVG — like the StatusDonut / Sparkline on the tasks page — so heights are
// driven by the viewBox rather than fragile percentage-height flexbox; the
// web app ships no charting library.

// Match TokenBar in TaskDetail.tsx: input = blue-500/70, output = emerald-500/70.
const INPUT_COLOR = "#3b82f6";
const OUTPUT_COLOR = "#10b981";
const SERIES_OPACITY = 0.7;

// Label every Nth bar on the date axis so 14 ticks don't crowd. Today and the
// oldest day are always labeled.
const AXIS_LABEL_EVERY = 3;

export function TokenUsageChart({ buckets }: { buckets: DayTokens[] }) {
  const today = buckets[buckets.length - 1] ?? { input: 0, output: 0, dayStart: 0 };
  const todayTotal = today.input + today.output;
  const windowInput = buckets.reduce((sum, b) => sum + b.input, 0);
  const windowOutput = buckets.reduce((sum, b) => sum + b.output, 0);
  const maxTotal = buckets.reduce((max, b) => Math.max(max, b.input + b.output), 0);
  const hasData = maxTotal > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Token usage</CardTitle>
        <CardDescription>Input vs output tokens per day · last {buckets.length} days</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <p className="text-2xl font-semibold tabular-nums">{todayTotal.toLocaleString()}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="text-muted-foreground">today</span>
            <Swatch color={INPUT_COLOR} label="Input" value={today.input} />
            <Swatch color={OUTPUT_COLOR} label="Output" value={today.output} />
          </p>
        </div>

        {hasData ? (
          <DailyBars buckets={buckets} maxTotal={maxTotal} />
        ) : (
          <div className="flex h-32 items-center justify-center rounded-md border border-dashed border-border bg-muted/30">
            <p className="text-[11px] text-muted-foreground">No token usage yet — run a task to see consumption.</p>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-[11px]">
          <Swatch color={INPUT_COLOR} label="Input" value={windowInput} />
          <Swatch color={OUTPUT_COLOR} label="Output" value={windowOutput} />
          <span className="font-mono tabular-nums text-muted-foreground">
            {(windowInput + windowOutput).toLocaleString()} total
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function DailyBars({ buckets, maxTotal }: { buckets: DayTokens[]; maxTotal: number }) {
  // Square viewBox stretched to the box (preserveAspectRatio="none"); only
  // axis-free rects live in it, so the horizontal stretch is harmless. Each
  // day owns a band; the bar fills 70% of the band, stacked input-on-bottom.
  const H = 100;
  const W = 100;
  const band = W / buckets.length;
  const barW = band * 0.7;
  const inset = (band - barW) / 2;
  const lastIndex = buckets.length - 1;
  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-32 w-full"
        role="img"
        aria-label="Daily token usage, input and output tokens per day"
      >
        {buckets.map((bucket, i) => {
          const total = bucket.input + bucket.output;
          // A nonzero day always shows at least a 2-unit sliver so it never
          // visually reads as empty; a true-zero day stays flat.
          const totalH = total > 0 ? Math.max((total / maxTotal) * H, 2) : 0;
          const inputH = total > 0 ? (bucket.input / total) * totalH : 0;
          const outputH = totalH - inputH;
          const x = i * band + inset;
          return (
            <g key={bucket.dayStart}>
              {/* Full-band transparent hit target so every day — including
                  empty ones — surfaces a hover tooltip. */}
              <rect x={i * band} y={0} width={band} height={H} fill="transparent">
                <title>
                  {`${formatDay(bucket.dayStart)} — ${bucket.input.toLocaleString()} in · ${bucket.output.toLocaleString()} out (${total.toLocaleString()} total)`}
                </title>
              </rect>
              {total > 0 ? (
                <>
                  <rect x={x} y={H - inputH} width={barW} height={inputH} fill={INPUT_COLOR} opacity={SERIES_OPACITY} />
                  <rect x={x} y={H - totalH} width={barW} height={outputH} fill={OUTPUT_COLOR} opacity={SERIES_OPACITY} />
                </>
              ) : null}
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex">
        {buckets.map((bucket, i) => {
          const showLabel = i === lastIndex || i === 0 || i % AXIS_LABEL_EVERY === 0;
          const isToday = i === lastIndex;
          return (
            <span
              key={bucket.dayStart}
              className={`min-w-0 flex-1 text-center text-[9px] tabular-nums ${isToday ? "font-medium text-foreground" : "text-muted-foreground"}`}
            >
              {showLabel ? formatAxis(bucket.dayStart) : ""}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function Swatch({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <span className="flex items-center gap-1">
      <span
        className="inline-block size-2 rounded-full"
        style={{ backgroundColor: color, opacity: SERIES_OPACITY }}
        aria-hidden
      />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums text-foreground">{value.toLocaleString()}</span>
    </span>
  );
}

// "Jun 17" — full label for tooltips.
function formatDay(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// "17" — compact day-of-month for the axis.
function formatAxis(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { day: "numeric" });
}
