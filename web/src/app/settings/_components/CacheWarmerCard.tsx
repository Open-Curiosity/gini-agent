"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { InfoIcon } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";

// Cache warmer is model-agnostic: every modern provider (OpenAI, Anthropic,
// OpenRouter, DeepSeek, ...) does some flavor of prompt caching, and the
// warmer's only job is to fire a minimal probe before the cache would
// expire so the next real turn pays the cache-hit rate instead of a full
// re-prefill.
//
// Piecewise slider scale: prompt cache TTLs cluster heavily in the
// 5-60 min range, so the lower half of the track maps to 0-60 min in
// 1-min snap and the upper half maps to 60-1440 min in 5-min snap. The
// native <input type="range"> still moves linearly across the underlying
// 0-1000 nominal position; we translate position → minutes for display
// and only the snapped minute value is persisted.

const TRACK_MAX = 1000;
const SPLIT = 500;
const LOWER_BREAKPOINT_MIN = 60;
const UPPER_BREAKPOINT_MIN = 1440;
const SAVE_DEBOUNCE_MS = 500;
const SAVED_NOTICE_MS = 1500;

// Lower half (0..SPLIT positions) covers 0-60 min in 1-min snap, upper
// half (SPLIT..TRACK_MAX) covers 60-1440 min in 5-min snap. The 1-min
// lower-half granularity is intentional: with a 5-min snap, 500 nominal
// positions / 12 minute-values = 41.67 positions per value-change, which
// felt like the slider was ignoring small drags. 1-min snap brings that
// down to 500/60 = 8.33 positions per value-change, so the displayed
// number ticks visibly as the thumb moves.
function positionToMinutes(pos: number): number {
  if (pos <= SPLIT) {
    return Math.round((pos / SPLIT) * LOWER_BREAKPOINT_MIN);
  }
  const raw =
    LOWER_BREAKPOINT_MIN +
    ((pos - SPLIT) / SPLIT) * (UPPER_BREAKPOINT_MIN - LOWER_BREAKPOINT_MIN);
  return Math.round(raw / 5) * 5;
}

function minutesToPosition(min: number): number {
  if (min <= 0) return 0;
  return min <= LOWER_BREAKPOINT_MIN
    ? (min / LOWER_BREAKPOINT_MIN) * SPLIT
    : SPLIT +
        ((min - LOWER_BREAKPOINT_MIN) /
          (UPPER_BREAKPOINT_MIN - LOWER_BREAKPOINT_MIN)) *
          SPLIT;
}

function formatMinutes(min: number): string {
  if (min === 0) return "Off";
  const hours = Math.floor(min / 60);
  const remainder = min % 60;
  if (hours === 0) return `${remainder} min`;
  if (remainder === 0) return `${hours} h`;
  return `${hours} h ${remainder} min`;
}

// Refresh is fixed at 90% of the chosen interval — exactly minutes × 54
// seconds. Format with sub-minute precision so a 5-min interval reads
// "4 min 30 sec", not the misleading "5 min" that would land the probe
// at the exact expiry instead of before it.
function formatRefresh(min: number): string {
  const seconds = min * 54;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const sec = seconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} h`);
  if (minutes > 0) parts.push(`${minutes} min`);
  if (sec > 0) parts.push(`${sec} sec`);
  return parts.join(" ");
}

const TICKS: { min: number; label: string }[] = [
  { min: 0, label: "Off" },
  { min: 30, label: "30 min" },
  { min: 60, label: "1 h" },
  { min: 720, label: "12 h" },
  { min: 1440, label: "24 h" }
];

interface CacheWarmerResponse {
  minutes: number;
}

export function CacheWarmerCard() {
  // Slider position is the source of truth so drags don't snap-fight the
  // re-render. `minutes` is derived for display + persistence.
  const [position, setPosition] = useState<number>(0);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const minutes = positionToMinutes(position);

  // Seed the slider from the persisted value on first successful fetch.
  // Subsequent refetches don't override local state because the user may
  // have dragged the slider mid-flight; a save will race to disk anyway.
  const query = useQuery<CacheWarmerResponse>({
    queryKey: ["cache-warmer"],
    queryFn: () => api<CacheWarmerResponse>("/settings/cache-warmer")
  });
  useEffect(() => {
    if (!query.data || hasLoaded) return;
    setPosition(minutesToPosition(query.data.minutes));
    setHasLoaded(true);
  }, [query.data, hasLoaded]);

  const save = useMutation({
    mutationFn: (next: number) =>
      api<{ ok: boolean; minutes: number; error?: string }>("/settings/cache-warmer", {
        method: "POST",
        body: JSON.stringify({ minutes: next })
      }),
    onSuccess: () => setSavedAt(Date.now())
  });

  // Debounced auto-save. The 500ms window swallows the storm of onChange
  // events a single drag emits while still feeling immediate when the
  // user releases the thumb. Guarded by hasLoaded so the initial 0
  // position doesn't clobber a persisted value before the GET resolves.
  useEffect(() => {
    if (!hasLoaded) return;
    const handle = setTimeout(() => {
      save.mutate(minutes);
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // minutes is derived from position; depending on position alone is
    // enough to schedule the save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position, hasLoaded]);

  // Auto-clear the "Saved" notice so it doesn't linger forever.
  useEffect(() => {
    if (savedAt === null) return;
    const handle = setTimeout(() => setSavedAt(null), SAVED_NOTICE_MS);
    return () => clearTimeout(handle);
  }, [savedAt]);

  // Click-outside dismiss for the info popover.
  useEffect(() => {
    if (!infoOpen) return;
    function handleDown(event: MouseEvent) {
      if (!popoverRef.current) return;
      if (popoverRef.current.contains(event.target as Node)) return;
      setInfoOpen(false);
    }
    document.addEventListener("mousedown", handleDown);
    return () => document.removeEventListener("mousedown", handleDown);
  }, [infoOpen]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <CardTitle className="text-sm">Cache warmer</CardTitle>
            <div className="relative" ref={popoverRef}>
              <button
                type="button"
                onClick={() => setInfoOpen((v) => !v)}
                aria-label="How cache warming works"
                aria-expanded={infoOpen}
                className="inline-flex items-center text-muted-foreground hover:text-foreground"
              >
                <InfoIcon className="size-3.5" />
              </button>
              {infoOpen ? (
                <div className="absolute left-0 top-6 z-50 w-80 max-w-[90vw] rounded-md border border-border bg-card p-3 text-[11px] leading-relaxed text-foreground shadow-lg">
                  Modern LLM providers cache long, repeated prompt prefixes for a short
                  window — 5–10 minutes idle for OpenAI in-memory, up to 24 hours for
                  OpenAI 24h, 5 minutes default or 1 hour beta for Anthropic. When the
                  cache expires, the next turn re-prefills from scratch and pays the full
                  input rate.
                  <span className="mt-2 block">
                    The warmer fires a one-token probe at 90% of the chosen interval. If
                    the cache is still warm, the next real turn pays the cache-hit rate
                    (10% of input pricing on OpenAI). One output token per refresh, so the
                    cost is negligible compared to a full re-prefill.
                  </span>
                  <span className="mt-2 block text-muted-foreground">
                    The slider is split: the left half covers 0–60 minutes in 1-minute
                    steps; the right half covers 1–24 hours in 5-minute steps.
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        </div>
        <CardDescription>
          Keep the prompt cache hot across every provider that supports it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-md border border-border bg-card/50 px-4 py-3.5 space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-mono text-[15px] text-foreground">{formatMinutes(minutes)}</span>
            <div className="flex items-center gap-2">
              {minutes > 0 ? (
                <span className="text-xs text-muted-foreground">
                  refresh every {formatRefresh(minutes)}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">disabled</span>
              )}
              {save.isPending ? (
                <span className="text-[10px] text-muted-foreground">Saving…</span>
              ) : savedAt !== null ? (
                <span className="text-[10px] text-emerald-400">Saved</span>
              ) : null}
            </div>
          </div>
          <input
            type="range"
            min={0}
            max={TRACK_MAX}
            step={1}
            value={position}
            onChange={(event) => setPosition(Number(event.target.value))}
            className="w-full accent-[#6F7BFF]"
            aria-label="Cache warmer interval in minutes"
            disabled={!hasLoaded}
          />
          <div className="relative h-4 text-[10px] font-mono text-muted-foreground">
            {TICKS.map((tick) => {
              const pct = (minutesToPosition(tick.min) / TRACK_MAX) * 100;
              const anchor =
                tick.min === 0
                  ? "translateX(0)"
                  : tick.min === UPPER_BREAKPOINT_MIN
                    ? "translateX(-100%)"
                    : "translateX(-50%)";
              return (
                <span
                  key={tick.min}
                  className="absolute top-0"
                  style={{ left: `${pct}%`, transform: anchor }}
                >
                  {tick.label}
                </span>
              );
            })}
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Sends a one-token probe 10% before the chosen interval to keep the prompt cache
          hot. Adds one output token per refresh, so the cost is negligible compared to a
          full re-prefill on the next real turn. Slide to{" "}
          <span className="font-mono text-[10px]">Off</span> to disable.
        </p>
        {save.error ? (
          <p className="text-[11px] text-destructive">{save.error.message}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
