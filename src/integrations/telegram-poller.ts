// Inbound Telegram poller.
//
// Each configured Telegram bridge owns one long-poll loop against
// api.telegram.org's getUpdates. The supervisor reconciles the set of
// running loops against state every few seconds — new bridges start a
// loop, disabled or deleted bridges stop theirs. Loops are cancellable
// via AbortController so SIGTERM doesn't have to wait out the long-poll
// timeout.

import type { MessagingBridgeRecord, RuntimeConfig } from "../types";
import { appendLog, isTerminalTaskStatus, mutateState, now, readState } from "../state";
import { readBridgeBotToken, receiveMessagingInput } from "./messaging";
import {
  createTelegramClient,
  extractIncomingText,
  type TelegramClient
} from "./telegram";

// Telegram caps the long-poll timeout at 50s. 25s is a comfortable middle
// ground — long enough to amortize HTTP overhead, short enough that a
// dropped connection recovers within half a minute.
const LONG_POLL_SECONDS = 25;

// Backoff after an error so a flaky network or a revoked token doesn't
// hammer the API.
const ERROR_BACKOFF_MS = 5000;

// Telegram chat actions auto-clear after ~5 seconds. We refresh just under
// that so the "is typing…" stays visible continuously until the task
// settles, without piling on requests.
const TYPING_REFRESH_MS = 4000;

export interface PollerDeps {
  clientFactory?: (token: string) => TelegramClient;
}

interface RunningLoop {
  controller: AbortController;
  done: Promise<void>;
}

export interface PollerSupervisor {
  // Snapshot the current state and start/stop loops to match.
  reconcile(): void;
  // Cancel every running loop and await their exits.
  stopAll(): Promise<void>;
  // Number of live loops. Exposed for tests + diagnostics.
  size(): number;
}

export function createTelegramPollerSupervisor(
  config: RuntimeConfig,
  deps: PollerDeps = {}
): PollerSupervisor {
  const loops = new Map<string, RunningLoop>();
  const factory = deps.clientFactory ?? ((token: string) => createTelegramClient(token));
  let stopped = false;

  function shouldRun(bridge: MessagingBridgeRecord): boolean {
    if (bridge.kind !== "telegram") return false;
    if (bridge.status !== "configured") return false;
    return Boolean(bridge.secretRefs?.some((ref) => ref.purpose === "bot-token"));
  }

  function startLoop(bridgeId: string): void {
    if (loops.has(bridgeId) || stopped) return;
    const controller = new AbortController();
    const done = runLoop(config, bridgeId, controller.signal, factory).finally(() => {
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
  factory: (token: string) => TelegramClient
): Promise<void> {
  while (!signal.aborted) {
    const bridge = readState(config.instance).messagingBridges.find((item) => item.id === bridgeId);
    if (!bridge || bridge.kind !== "telegram" || bridge.status !== "configured") return;
    const token = readBridgeBotToken(config, bridge);
    if (!token) return;

    const offset = readLastOffset(bridge);
    let client: TelegramClient;
    try {
      client = factory(token);
    } catch (error) {
      appendLog(config.instance, "messaging.telegram.client_error", {
        bridgeId,
        error: error instanceof Error ? error.message : String(error)
      });
      await sleepUnlessAborted(ERROR_BACKOFF_MS, signal);
      continue;
    }

    let updates: Awaited<ReturnType<TelegramClient["getUpdates"]>>;
    try {
      updates = await client.getUpdates(offset, LONG_POLL_SECONDS, signal);
    } catch (error) {
      if (signal.aborted) return;
      appendLog(config.instance, "messaging.telegram.poll_error", {
        bridgeId,
        error: error instanceof Error ? error.message : String(error)
      });
      await sleepUnlessAborted(ERROR_BACKOFF_MS, signal);
      continue;
    }

    if (updates.length === 0) continue;

    for (const update of updates) {
      if (signal.aborted) return;
      const incoming = extractIncomingText(update);
      if (incoming) {
        try {
          const record = await receiveMessagingInput(config, bridgeId, {
            text: incoming.text,
            target: String(incoming.chatId)
          });
          // Surface a "typing…" indicator in the chat while the agent
          // works on the just-submitted task. The pulse is best-effort
          // and runs detached so a slow chat_action call doesn't block
          // the next update.
          if (record.taskId) {
            void maintainTypingIndicator(config, record.taskId, incoming.chatId, client, signal).catch(
              (error) => {
                appendLog(config.instance, "messaging.telegram.typing_error", {
                  bridgeId,
                  error: error instanceof Error ? error.message : String(error)
                });
              }
            );
          }
        } catch (error) {
          appendLog(config.instance, "messaging.telegram.receive_error", {
            bridgeId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      // Persist the offset *after* each update so a crash mid-batch
      // doesn't replay messages that already produced tasks. Telegram's
      // contract is "next offset = highest update_id + 1".
      await mutateState(config.instance, (state) => {
        const live = state.messagingBridges.find((item) => item.id === bridgeId);
        if (!live) return;
        live.metadata = { ...(live.metadata ?? {}), lastOffset: update.update_id + 1 };
        live.updatedAt = now();
      });
    }
  }
}

function readLastOffset(bridge: MessagingBridgeRecord): number | undefined {
  const raw = bridge.metadata?.lastOffset;
  return typeof raw === "number" ? raw : undefined;
}

// Refresh sendChatAction("typing") on a ~4s cadence for as long as the
// originating task is in a non-terminal state. The first action fires
// immediately so the user sees "is typing…" the moment they finish
// sending. Errors halt the pulse — a revoked chat (`chat not found`) or
// a network blip shouldn't keep us looping forever.
async function maintainTypingIndicator(
  config: RuntimeConfig,
  taskId: string,
  chatId: number,
  client: TelegramClient,
  signal: AbortSignal
): Promise<void> {
  while (!signal.aborted) {
    const task = readState(config.instance).tasks.find((t) => t.id === taskId);
    if (!task) return;
    if (isTerminalTaskStatus(task.status)) return;
    try {
      await client.sendChatAction(chatId, "typing");
    } catch {
      return;
    }
    await sleepUnlessAborted(TYPING_REFRESH_MS, signal);
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
