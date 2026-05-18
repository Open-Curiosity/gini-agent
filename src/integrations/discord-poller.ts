// Inbound Discord poller.
//
// Mirrors the Telegram poller's lifecycle: a supervisor reconciles
// per-bridge loops against state, each loop pulls new messages for
// every delivery target, and the runtime aborts every loop on SIGTERM
// via AbortController.
//
// The transport differs from Telegram. Discord exposes no long-poll —
// the runtime uses REST history with `?after=<snowflake>` and the
// per-target watermark lives on `bridge.metadata.lastInboundExternalIds`.
// First contact seeds the watermark from the newest visible message so
// a fresh bridge doesn't backfill history into the agent. Typing
// indicators piggy-back on Discord's `POST /channels/:id/typing` which
// auto-clears after ~10 seconds; the pulse refreshes on a tighter
// cadence so long-running tasks stay visible without piling up
// requests.

import type { MessagingBridgeRecord, RuntimeConfig } from "../types";
import { appendLog, isTerminalTaskStatus, mutateState, now, readState } from "../state";
import { findDiscordChatSession, readBridgeBotToken, receiveMessagingInput, sendMessagingOutput } from "./messaging";
import { syncChatTaskResult } from "../execution/chat";
import {
  createDiscordClient,
  extractIncomingPayload,
  type DiscordClient,
  type DiscordMessage
} from "./discord";

// Cadence for the per-target REST poll. Discord's global rate limit is
// generous (~50 req/s), but per-channel limits are tighter; 3s leaves
// plenty of headroom for a handful of bridges polling a handful of
// channels each.
const POLL_INTERVAL_MS = 3000;

// Backoff after an error so a flaky network or a revoked token doesn't
// hammer the API on every tick.
const ERROR_BACKOFF_MS = 5000;

// Discord typing indicators auto-clear after ~10 seconds. Refresh just
// under that so the "Gini is typing…" stays continuous for as long as
// the agent task is running.
const TYPING_REFRESH_MS = 7000;

// Max messages to fetch per poll. Discord caps `limit` at 100; the
// poller uses a smaller window because a steady-state bridge should
// only see one or two new messages per tick.
const FETCH_BATCH_LIMIT = 50;

export interface PollerDeps {
  clientFactory?: (token: string) => DiscordClient;
  // Per-target polling cadence override (ms). Production leaves this
  // undefined and falls back to POLL_INTERVAL_MS; tests dial it down
  // to step the loop without waiting on real seconds.
  pollIntervalMs?: number;
  // Typing-indicator refresh cadence override (ms). Same story — the
  // 7s production default keeps the indicator continuous; tests crank
  // it down to verify the pulse fires while the task is running.
  typingRefreshMs?: number;
}

interface RunningLoop {
  controller: AbortController;
  done: Promise<void>;
}

export interface PollerSupervisor {
  reconcile(): void;
  stopAll(): Promise<void>;
  size(): number;
}

export function createDiscordPollerSupervisor(
  config: RuntimeConfig,
  deps: PollerDeps = {}
): PollerSupervisor {
  const loops = new Map<string, RunningLoop>();
  const factory = deps.clientFactory ?? ((token: string) => createDiscordClient(token));
  const pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
  const typingRefreshMs = deps.typingRefreshMs ?? TYPING_REFRESH_MS;
  let stopped = false;
  // Tracks every detached typing+reply worker so stopAll can await
  // their completion. Without this, a worker still mid-sendMessagingOutput
  // when the runtime tears down would land its state mutation against
  // a stale GINI_STATE_ROOT (tests) or after the process has begun
  // exiting (production) — both are observable as orphaned writes.
  const detached = new Set<Promise<void>>();

  function shouldRun(bridge: MessagingBridgeRecord): boolean {
    if (bridge.kind !== "discord") return false;
    if (bridge.status !== "configured") return false;
    if (bridge.deliveryTargets.length === 0) return false;
    return Boolean(bridge.secretRefs?.some((ref) => ref.purpose === "bot-token"));
  }

  function startLoop(bridgeId: string): void {
    if (loops.has(bridgeId) || stopped) return;
    const controller = new AbortController();
    const trackDetached = (work: Promise<void>): void => {
      detached.add(work);
      void work.finally(() => detached.delete(work));
    };
    const done = runLoop(
      config,
      bridgeId,
      controller.signal,
      factory,
      pollIntervalMs,
      typingRefreshMs,
      trackDetached
    ).finally(() => {
      // Always abort the controller when the loop exits, even for
      // natural returns (bridge disabled, token rotated, status
      // flipped). Detached typing pulses + reply mirrors captured
      // this signal — without an abort here they keep firing
      // triggerTypingIndicator against the now-orphaned client
      // until the underlying task settles.
      controller.abort();
      loops.delete(bridgeId);
    });
    loops.set(bridgeId, { controller, done });
  }

  function stopLoop(bridgeId: string): void {
    const loop = loops.get(bridgeId);
    if (!loop) return;
    loop.controller.abort();
  }

  return {
    reconcile() {
      if (stopped) return;
      const bridges = readState(config.instance).messagingBridges;
      const desired = new Set<string>();
      for (const bridge of bridges) {
        if (shouldRun(bridge)) desired.add(bridge.id);
      }
      for (const id of desired) {
        if (!loops.has(id)) startLoop(id);
      }
      for (const id of loops.keys()) {
        if (!desired.has(id)) stopLoop(id);
      }
    },
    async stopAll() {
      stopped = true;
      for (const loop of loops.values()) loop.controller.abort();
      await Promise.all(Array.from(loops.values()).map((loop) => loop.done.catch(() => {})));
      // Wait for any in-flight detached typing+reply workers to
      // unwind before resolving. The loops aborting above lets these
      // observe abort and short-circuit; any worker mid-state-write
      // still gets to finish so the audit trail and outbound record
      // land before shutdown continues.
      await Promise.all(Array.from(detached).map((work) => work.catch(() => {})));
    },
    size() {
      return loops.size;
    }
  };
}

async function runLoop(
  config: RuntimeConfig,
  bridgeId: string,
  signal: AbortSignal,
  factory: (token: string) => DiscordClient,
  pollIntervalMs: number,
  typingRefreshMs: number,
  trackDetached: (work: Promise<void>) => void
): Promise<void> {
  while (!signal.aborted) {
    const bridge = readState(config.instance).messagingBridges.find((item) => item.id === bridgeId);
    if (!bridge || bridge.kind !== "discord" || bridge.status !== "configured") return;
    // readBridgeBotToken throws ENOENT when the encrypted secret file
    // is missing under the secretRef path (rotation in progress,
    // manual deletion, corruption). Without a catch the rejection
    // propagates out of the loop, the supervisor reconcile sees the
    // bridge still matches shouldRun (it only checks secretRefs, not
    // the on-disk file), and restarts the loop every reconcile tick.
    // Flip the bridge to "error" so shouldRun stops returning true
    // and the supervisor drops the broken bridge until the user
    // re-supplies the token.
    let token: string | undefined;
    try {
      token = readBridgeBotToken(config, bridge);
    } catch (error) {
      await markBridgeError(config, bridgeId, error);
      return;
    }
    if (!token) {
      await markBridgeError(config, bridgeId, new Error("Discord bot token secret is missing."));
      return;
    }

    let client: DiscordClient;
    try {
      client = factory(token);
    } catch (error) {
      appendLog(config.instance, "messaging.discord.client_error", {
        bridgeId,
        error: error instanceof Error ? error.message : String(error)
      });
      await sleepUnlessAborted(ERROR_BACKOFF_MS, signal);
      continue;
    }

    for (const channelId of bridge.deliveryTargets) {
      if (signal.aborted) return;
      await pollChannel(config, bridgeId, channelId, client, signal, typingRefreshMs, trackDetached);
    }

    await sleepUnlessAborted(pollIntervalMs, signal);
  }
}

async function pollChannel(
  config: RuntimeConfig,
  bridgeId: string,
  channelId: string,
  client: DiscordClient,
  signal: AbortSignal,
  typingRefreshMs: number,
  trackDetached: (work: Promise<void>) => void
): Promise<void> {
  const watermark = readChannelWatermark(config, bridgeId, channelId);

  let messages: DiscordMessage[];
  try {
    messages = await client.fetchChannelMessages(channelId, {
      afterId: watermark,
      limit: FETCH_BATCH_LIMIT,
      signal
    });
  } catch (error) {
    if (signal.aborted) return;
    appendLog(config.instance, "messaging.discord.poll_error", {
      bridgeId,
      channelId,
      error: error instanceof Error ? error.message : String(error)
    });
    await sleepUnlessAborted(ERROR_BACKOFF_MS, signal);
    return;
  }

  // First-contact seeding. We have to pin a watermark on the very
  // first poll even when the channel is empty — otherwise a user
  // typing between this empty poll and the next non-empty poll lands
  // their first message in the seeding branch, where it would be
  // consumed as the seed and never routed. The "0" sentinel is
  // strictly less than every real Discord snowflake (which start at
  // ~10^18), so the next poll with afterId="0" correctly fetches the
  // user's message.
  if (messages.length === 0) {
    if (watermark === undefined) {
      await advanceWatermark(config, bridgeId, channelId, "0");
    }
    return;
  }

  // Discord returns newest-first; process oldest-first so the watermark
  // advances monotonically and we don't reply to messages out of order.
  // Sort by BigInt-comparable snowflake (decimal strings of mixed
  // length sort wrong lexically — "999" sorts after "1000" — so a
  // future digit-length boundary would mis-order without this).
  const ordered = [...messages].sort((a, b) => snowflakeCompare(a.id, b.id));

  // Non-empty first poll: pin to the newest existing message and
  // skip routing so a fresh bridge attaching to an active channel
  // doesn't backfill history into the agent.
  if (watermark === undefined) {
    const newest = ordered[ordered.length - 1]!;
    await advanceWatermark(config, bridgeId, channelId, newest.id);
    return;
  }

  for (const raw of ordered) {
    if (signal.aborted) return;
    const incoming = extractIncomingPayload(raw);
    if (!incoming || incoming.authorIsBot) {
      // Bot-authored messages (including our own replies) and
      // attachment-only / empty messages advance the watermark without
      // spawning a task — they're accounted for but not routed.
      await advanceWatermark(config, bridgeId, channelId, raw.id);
      continue;
    }

    try {
      const record = await receiveMessagingInput(config, bridgeId, {
        text: incoming.text,
        target: incoming.channelId
      });
      if (record.taskId) {
        // Typing pulse + reply mirror runs detached so a slow
        // sendMessage call can't stall the next poll cycle. Errors
        // land on the runtime log; the inbound record stays. The
        // worker is tracked so stopAll can await it — without that
        // a worker mid-state-write at shutdown would land its write
        // against a torn-down runtime (or in tests against a stale
        // GINI_STATE_ROOT after the next test rebinds it).
        const work = maintainTypingAndMirrorReply(
          config,
          bridgeId,
          record.taskId,
          incoming.channelId,
          client,
          signal,
          typingRefreshMs
        ).catch((error) => {
          appendLog(config.instance, "messaging.discord.typing_error", {
            bridgeId,
            error: error instanceof Error ? error.message : String(error)
          });
        });
        trackDetached(work);
      }
    } catch (error) {
      appendLog(config.instance, "messaging.discord.receive_error", {
        bridgeId,
        channelId,
        externalId: raw.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    // Advance the watermark after the receive call regardless of
    // success — a poison message must not block the queue forever. The
    // audit row from receiveMessagingInput (or the error log above)
    // preserves the message id for manual replay.
    await advanceWatermark(config, bridgeId, channelId, raw.id);
  }
}

// Typing pulse + reply mirror, identical to the Telegram poller in
// spirit. While the task is non-terminal we refresh the typing
// indicator on a ~7s cadence; once the task settles we sync the
// assistant message into the chat session and dispatch the text back
// via sendMessagingOutput, which records an outbound MessagingMessageRecord.
async function maintainTypingAndMirrorReply(
  config: RuntimeConfig,
  bridgeId: string,
  taskId: string,
  channelId: string,
  client: DiscordClient,
  signal: AbortSignal,
  typingRefreshMs: number
): Promise<void> {
  await maintainTypingIndicator(config, taskId, channelId, client, signal, typingRefreshMs);
  if (signal.aborted) return;

  const session = findDiscordChatSession(config, bridgeId, channelId);
  if (!session || !session.source || session.source.kind !== "discord") return;

  let replyText: string | undefined;
  try {
    const message = await syncChatTaskResult(config, session.id, taskId);
    if (message && message.role === "assistant") replyText = message.content;
  } catch (error) {
    appendLog(config.instance, "messaging.discord.sync_error", {
      bridgeId,
      taskId,
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  if (!replyText || replyText.trim().length === 0) return;

  try {
    await sendMessagingOutput(config, bridgeId, {
      text: replyText,
      target: session.source.target
    });
  } catch (error) {
    appendLog(config.instance, "messaging.discord.reply_error", {
      bridgeId,
      taskId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function maintainTypingIndicator(
  config: RuntimeConfig,
  taskId: string,
  channelId: string,
  client: DiscordClient,
  signal: AbortSignal,
  typingRefreshMs: number
): Promise<void> {
  while (!signal.aborted) {
    const task = readState(config.instance).tasks.find((t) => t.id === taskId);
    if (!task) return;
    if (isTerminalTaskStatus(task.status)) return;
    try {
      // Pass the loop's signal so a hung typing POST gets cancelled
      // on bridge disable / shutdown — without this the await could
      // block the sequential reply mirror indefinitely.
      await client.triggerTypingIndicator(channelId, signal);
    } catch (error) {
      // A revoked channel or network blip shouldn't keep us looping
      // forever — log once and abandon the pulse so the reply
      // mirror still attempts to land the eventual message. Aborts
      // are expected on shutdown and stay quiet.
      if (signal.aborted) return;
      appendLog(config.instance, "messaging.discord.typing_pulse_error", {
        channelId,
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }
    await sleepUnlessAborted(typingRefreshMs, signal);
  }
}

function readChannelWatermark(
  config: RuntimeConfig,
  bridgeId: string,
  channelId: string
): string | undefined {
  const bridge = readState(config.instance).messagingBridges.find((item) => item.id === bridgeId);
  if (!bridge) return undefined;
  const raw = bridge.metadata?.lastInboundExternalIds;
  if (!raw || typeof raw !== "object") return undefined;
  const value = (raw as Record<string, unknown>)[channelId];
  return typeof value === "string" ? value : undefined;
}

async function advanceWatermark(
  config: RuntimeConfig,
  bridgeId: string,
  channelId: string,
  externalId: string
): Promise<void> {
  await mutateState(config.instance, (state) => {
    const live = state.messagingBridges.find((item) => item.id === bridgeId);
    if (!live) return;
    const previous = (live.metadata?.lastInboundExternalIds ?? {}) as Record<string, unknown>;
    const current = previous[channelId];
    const currentStr = typeof current === "string" ? current : undefined;
    // Snowflake compare via BigInt — decimal strings of different
    // lengths sort wrong lexically. Today's snowflakes are all 19
    // digits, but the "0" sentinel used for empty-channel seeding is
    // length 1, so a naïve string compare would refuse to advance
    // past it.
    if (currentStr && snowflakeCompare(currentStr, externalId) >= 0) return;
    live.metadata = {
      ...(live.metadata ?? {}),
      lastInboundExternalIds: { ...previous, [channelId]: externalId }
    };
    live.updatedAt = now();
  });
}

// Compare two Discord snowflake-shaped decimal strings as integers.
// Returns negative if a < b, 0 if equal, positive if a > b. Falls
// back to lexicographic compare for non-decimal inputs so an unknown
// metadata value can't crash the poller — that branch is dead under
// normal operation since we only write digit strings.
function snowflakeCompare(a: string, b: string): number {
  if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const ai = BigInt(a);
  const bi = BigInt(b);
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

// Flip a bridge to "error" so the supervisor reconcile loop drops it
// from the desired set (shouldRun checks status === "configured"). The
// user can re-enable the bridge by re-supplying the secret. Always
// best-effort — a state write failure here is logged but does not
// propagate further; the worst case is that the supervisor restarts
// the loop on the next reconcile tick.
async function markBridgeError(
  config: RuntimeConfig,
  bridgeId: string,
  error: unknown
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  appendLog(config.instance, "messaging.discord.token_error", { bridgeId, error: message });
  try {
    await mutateState(config.instance, (state) => {
      const live = state.messagingBridges.find((item) => item.id === bridgeId);
      if (!live) return;
      live.status = "error";
      live.message = message;
      live.updatedAt = now();
    });
  } catch (err) {
    appendLog(config.instance, "messaging.discord.mark_error_failed", {
      bridgeId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

async function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
