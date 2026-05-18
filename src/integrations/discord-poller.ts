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

  function shouldRun(bridge: MessagingBridgeRecord): boolean {
    if (bridge.kind !== "discord") return false;
    if (bridge.status !== "configured") return false;
    if (bridge.deliveryTargets.length === 0) return false;
    return Boolean(bridge.secretRefs?.some((ref) => ref.purpose === "bot-token"));
  }

  function startLoop(bridgeId: string): void {
    if (loops.has(bridgeId) || stopped) return;
    const controller = new AbortController();
    const done = runLoop(config, bridgeId, controller.signal, factory, pollIntervalMs, typingRefreshMs).finally(() => {
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
  typingRefreshMs: number
): Promise<void> {
  while (!signal.aborted) {
    const bridge = readState(config.instance).messagingBridges.find((item) => item.id === bridgeId);
    if (!bridge || bridge.kind !== "discord" || bridge.status !== "configured") return;
    const token = readBridgeBotToken(config, bridge);
    if (!token) return;

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
      await pollChannel(config, bridgeId, channelId, client, signal, typingRefreshMs);
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
  typingRefreshMs: number
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

  if (messages.length === 0) return;

  // Discord returns newest-first; process oldest-first so the watermark
  // advances monotonically and we don't reply to messages out of order.
  const ordered = [...messages].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // First-contact seeding: a bridge with no watermark yet skips every
  // existing message and just pins the watermark to the newest. Without
  // this, adding a new bridge would dump the channel's recent history
  // into the agent on first start.
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
        // land on the runtime log; the inbound record stays.
        void maintainTypingAndMirrorReply(
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
      await client.triggerTypingIndicator(channelId);
    } catch {
      // A revoked channel or network blip shouldn't keep us looping
      // forever — abandon the pulse and let the reply mirror still
      // attempt to land the eventual message.
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
    // Discord snowflakes are monotonically increasing 64-bit integers
    // rendered as decimal strings. Use string compare instead of
    // numeric parsing to avoid the Number-precision cliff at 2^53.
    const current = previous[channelId];
    const currentStr = typeof current === "string" ? current : undefined;
    if (currentStr && currentStr >= externalId) return;
    live.metadata = {
      ...(live.metadata ?? {}),
      lastInboundExternalIds: { ...previous, [channelId]: externalId }
    };
    live.updatedAt = now();
  });
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
