"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { DayTokens } from "../tasks/_components/observability";

// Daily token-usage chart for the home page. Renders a stacked bar per day
// (input on the bottom, output on top) over the supplied window, plus a
// headline for today's total and a legend with window totals. Hand-built to
// match the in-house viz style (StatusDonut / Sparkline / TokenBar) — the web
// app ships no charting library.

// Match TokenBar in TaskDetail.tsx: input = blue-500/70, output = emerald-500/70.
const INPUT_COLOR = "#3b82f6";
const OUTPUT_COLOR = "#10b981";
const SERIES_OPACITY = 0.7;

// Label every Nth bar on the date axis so 14 ticks don't crowd. Today and the
// oldest day are always labeled.
const AXIS_LABEL_EVERY = 3;

export function TokenUsageChart({ buckets }: { buckets: DayTokens[] }) {
  const today = buckets[buckets.length - 1] ?? { input: 0, output: 0, dayStart: Date.now() };
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
  const lastIndex = buckets.length - 1;
  return (
    <div className="flex h-32 items-end gap-1" role="img" aria-label="Daily token usage, input and output">
      {buckets.map((bucket, i) => {
        const total = bucket.input + bucket.output;
        const totalPct = (total / maxTotal) * 100;
        // Within the bar, split the rendered height between input (bottom) and
        // output (top). Guard total===0 so an empty day stays flat, not NaN.
        const inputPct = total > 0 ? (bucket.input / total) * 100 : 0;
        const outputPct = total > 0 ? 100 - inputPct : 0;
        const isToday = i === lastIndex;
        return (
          <div key={bucket.dayStart} className="flex min-w-0 flex-1 flex-col items-center gap-1">
            <div
              className="flex w-full flex-col-reverse overflow-hidden rounded-sm bg-muted/40"
              style={{ height: `${Math.max(totalPct, total > 0 ? 2 : 0)}%` }}
              title={`${formatDay(bucket.dayStart)} — ${bucket.input.toLocaleString()} in · ${bucket.output.toLocaleString()} out (${total.toLocaleString()} total)`}
            >
              <span className="block w-full" style={{ height: `${inputPct}%`, backgroundColor: INPUT_COLOR, opacity: SERIES_OPACITY }} />
              <span className="block w-full" style={{ height: `${outputPct}%`, backgroundColor: OUTPUT_COLOR, opacity: SERIES_OPACITY }} />
            </div>
            <span className={`text-[9px] tabular-nums ${isToday ? "font-medium text-foreground" : "text-muted-foreground"}`}>
              {i === lastIndex || i === 0 || i % AXIS_LABEL_EVERY === 0 ? formatAxis(bucket.dayStart) : " "}
            </span>
          </div>
        );
      })}
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
