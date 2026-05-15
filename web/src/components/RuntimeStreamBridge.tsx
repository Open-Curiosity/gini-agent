"use client";

import { useCallback } from "react";
import { useRuntimeStream } from "@/lib/useRuntimeStream";
import { useInvalidate } from "@/lib/queries";

// Maps server-side event kinds (RuntimeEventKind in src/types.ts) to the
// react-query keys that should refetch on each event. Every event also
// invalidates the derived feeds ("events", "audit", "state") which the
// activity page consumes regardless of kind.
const KIND_TO_KEYS: Record<string, string[]> = {
  task: ["tasks", "task", "chat"],
  approval: ["approvals"],
  job: ["jobs", "jobRuns", "improvements"],
  memory: ["memory"],
  skill: ["skills"],
  connector: ["connectors"],
  mcp: [],
  messaging: ["chat"],
  provider: ["status"],
  runtime: ["status"],
  notification: []
};

const ALWAYS = ["events", "audit", "state"];

/**
 * Mounted once at the app root. Subscribes to the runtime SSE stream and
 * invalidates the matching react-query keys on every event. With this in
 * place, per-query `refetchInterval` only needs to be a slow safety net
 * (~60s) rather than the primary mechanism — state changes propagate within
 * ~50ms via SSE.
 */
export function RuntimeStreamBridge(): null {
  const invalidate = useInvalidate();
  useRuntimeStream(
    useCallback(
      ({ kind }) => {
        const keys = KIND_TO_KEYS[kind] ?? [];
        invalidate([...keys, ...ALWAYS]);
      },
      [invalidate]
    )
  );
  return null;
}
