// Shared lifecycle helpers used by every messaging-bridge poller
// supervisor (currently Discord + Telegram). Extracted so that the
// disable-respecting and detached-tracking invariants live in one
// place — both pollers grew identical copies of these patterns and
// drift between them is now load-bearing for correctness.

import type { MessagingBridgeStatus, RuntimeConfig } from "../types";
import { appendLog, mutateState, now } from "../state";

// Flip a bridge to "error" so the supervisor's reconcile drops it
// from the desired set (shouldRun checks status === "configured").
// The user re-enables the bridge by recreating it with a fresh
// bot-token secret.
//
// Critical invariant: only flip a bridge that is still "configured".
// A concurrent disableMessagingBridge can land while this loop is
// catching an ENOENT on the just-deleted secret file; without this
// guard we would stamp "error" over the user's explicit "disabled"
// intent. The check + write happen inside a single mutateState so
// they serialize through the per-instance lock together.
//
// File-path leakage: ENOENT errors from readSecret include the
// absolute on-disk secret path. We scrub `<secrets-dir>/<file>`
// shapes from the message before persisting so the bridge state
// surface doesn't leak the encrypted-store layout.
export async function markBridgeError(
  config: RuntimeConfig,
  bridgeId: string,
  logEvent: string,
  markErrorFailedEvent: string,
  error: unknown
): Promise<void> {
  const raw = error instanceof Error ? error.message : String(error);
  const sanitized = sanitizeBridgeStatusMessage(raw);
  appendLog(config.instance, logEvent, { bridgeId, error: sanitized });
  try {
    await mutateState(config.instance, (state) => {
      const live = state.messagingBridges.find((item) => item.id === bridgeId);
      if (!live) return;
      if (live.status !== "configured") return;
      live.status = "error" as MessagingBridgeStatus;
      live.message = sanitized;
      live.updatedAt = now();
    });
  } catch (err) {
    appendLog(config.instance, markErrorFailedEvent, {
      bridgeId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

// Scrub Telegram URL-path tokens (`/bot<token>/`) and Discord
// auth-header tokens (`Bot <token>`) plus absolute filesystem paths
// from a string before it lands in user-visible state. Used by
// markBridgeError (state writes) and by sendMessagingOutput's error
// persistence (sanitizeBridgeError import). Pure function, easy to
// unit-test in isolation.
export function sanitizeBridgeStatusMessage(message: string): string {
  return message
    // Discord auth header echo: "Bot abc.def.ghi"
    .replace(/Bot\s+\S+/g, "Bot <redacted>")
    // Telegram URL-path token: "/bot123:abc/getMe"
    .replace(/\/bot[A-Za-z0-9:_-]+/g, "/bot<redacted>")
    // Absolute paths to the secrets directory (helpful for ENOENT
    // messages that include the missing file's full path).
    .replace(/(['"]?)\/[^\s'"]*\/secrets\/[^\s'"]+\1/g, "<secret-path>");
}

// Create a detached-worker tracker for a supervisor. The pollers
// launch typing-pulse + reply-mirror workers detached so the per-tick
// poll cycle doesn't block on a slow agent task; without tracking,
// stopAll resolves before in-flight state writes finish, which in
// tests lands writes against the next test's GINI_STATE_ROOT and in
// production strands writes mid-shutdown.
//
// stopAll-with-timeout: a hung send on a provider that doesn't thread
// abort (Telegram today) would otherwise keep stopAll pending
// forever. The drain bounds the wait so shutdown stays prompt; any
// worker still in flight after the timeout is logged and abandoned.
const DETACHED_DRAIN_TIMEOUT_MS = 5000;

export interface DetachedTracker {
  track(work: Promise<void>): void;
  drain(): Promise<void>;
  size(): number;
}

export function createDetachedTracker(
  config: RuntimeConfig,
  timeoutLogEvent: string
): DetachedTracker {
  const detached = new Set<Promise<void>>();
  return {
    track(work) {
      detached.add(work);
      void work.finally(() => detached.delete(work));
    },
    async drain() {
      if (detached.size === 0) return;
      const snapshot = Array.from(detached).map((work) => work.catch(() => {}));
      const drained = Promise.all(snapshot).then(() => true as const);
      const timer = sleep(DETACHED_DRAIN_TIMEOUT_MS).then(() => false as const);
      const finished = await Promise.race([drained, timer]);
      if (!finished) {
        appendLog(config.instance, timeoutLogEvent, {
          remaining: detached.size,
          waited_ms: DETACHED_DRAIN_TIMEOUT_MS
        });
      }
    },
    size() {
      return detached.size;
    }
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
