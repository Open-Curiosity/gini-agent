"use client";

import { useEffect, useLayoutEffect, useRef } from "react";

// Runtime-side event kinds. Source of truth: src/types.ts RuntimeEventKind.
// The server emits each event as `event: <kind>` (named SSE events), so the
// client must register a listener per kind — `EventSource.onmessage` only fires
// for unnamed default events, which the runtime never sends.
const EVENT_KINDS = [
  "task",
  "approval",
  "job",
  "memory",
  "skill",
  "connector",
  "mcp",
  "messaging",
  "provider",
  "runtime",
  "notification",
  "run"
] as const;

export type RuntimeStreamEvent = { kind: string; data: string };
type Listener = (event: RuntimeStreamEvent) => void;

// Module-level singleton — one EventSource per browser tab, shared by every
// `useRuntimeStream` caller and the global `RuntimeStreamBridge`. Subscribing
// from N places does not open N connections.
let source: EventSource | null = null;
const listeners = new Set<Listener>();

function ensureConnection(): void {
  if (source) return;
  const next = new EventSource("/api/runtime/events/stream");
  const fanOut = (kind: string) => (event: MessageEvent) => {
    for (const listener of listeners) listener({ kind, data: event.data });
  };
  for (const kind of EVENT_KINDS) next.addEventListener(kind, fanOut(kind));
  // Default `message` listener kept as a fallback for servers that emit
  // unnamed events; the local runtime does not, but this avoids breakage if
  // the upstream surface changes.
  next.addEventListener("message", fanOut("message"));
  // Intentionally NOT closing on error — EventSource has built-in reconnect
  // with backoff, and closing turns transient hiccups into permanent
  // disconnects. Some browsers fire onerror on every reconnect attempt during
  // a brief outage, so we stay quiet.
  next.onerror = () => {};
  source = next;
}

function subscribe(listener: Listener): () => void {
  ensureConnection();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && source) {
      source.close();
      source = null;
    }
  };
}

/**
 * Subscribes to /api/runtime/events/stream. Multiple callers share a single
 * underlying EventSource (module-level singleton), so mounting many
 * subscribers across the app does not open many connections.
 *
 * Stability:
 *   The effect deps are EMPTY and `onEvent` is captured via a ref so callers
 *   can pass a fresh closure each render without retriggering the effect or
 *   re-opening the connection.
 */
export function useRuntimeStream(onEvent: Listener): void {
  const callbackRef = useRef(onEvent);
  // Layout effect so the ref updates synchronously after every commit, before
  // any subsequent SSE message can fire.
  useLayoutEffect(() => {
    callbackRef.current = onEvent;
  });

  useEffect(() => {
    return subscribe((event) => callbackRef.current(event));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
