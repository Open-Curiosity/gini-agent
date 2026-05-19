// Inbound Telegram poller.
//
// Each configured Telegram bridge owns one long-poll loop against
// api.telegram.org's getUpdates. The supervisor reconciles the set of
// running loops against state every few seconds — new bridges start a
// loop, disabled or deleted bridges stop theirs. Loops are cancellable
// via AbortController so SIGTERM doesn't have to wait out the long-poll
// timeout.

import { mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import type { MessagingBridgeRecord, MessagingMessageMedia, RuntimeConfig } from "../types";
import { appendLog, isTerminalTaskStatus, mutateState, now, readState } from "../state";
import { instanceRoot } from "../paths";
import { findTelegramChatSession, readBridgeBotToken, receiveMessagingInput, sendMessagingOutput } from "./messaging";
import { syncChatTaskResult } from "../execution/chat";
import { awaitTerminalTask, createDetachedTracker, markBridgeError } from "./messaging-poller-helpers";
import {
  createTelegramClient,
  extractIncomingPayload,
  type IncomingPayload,
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
  // Shared detached-worker tracker. The drain has a bounded timeout
  // so a hung Telegram send (the Telegram client doesn't thread
  // AbortSignal) can't deadlock shutdown.
  const detached = createDetachedTracker(config, "messaging.telegram.detached_drain_timeout");

  function shouldRun(bridge: MessagingBridgeRecord): boolean {
    if (bridge.kind !== "telegram") return false;
    if (bridge.status !== "configured") return false;
    return Boolean(bridge.secretRefs?.some((ref) => ref.purpose === "bot-token"));
  }

  function startLoop(bridgeId: string): void {
    if (loops.has(bridgeId) || stopped) return;
    const controller = new AbortController();
    const done = runLoop(config, bridgeId, controller.signal, factory, detached.track).finally(() => {
      // Always abort the controller when the loop exits, so detached
      // children captured this signal observe abort and unwind on
      // natural returns (status flip, missing secret) as well as on
      // stopAll-driven aborts.
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
      // Drain detached workers with a bounded timeout. Telegram's
      // client API doesn't accept AbortSignal today, so a hung
      // sendMessage/sendChatAction would otherwise keep stopAll
      // pending forever.
      await detached.drain();
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
  factory: (token: string) => TelegramClient,
  trackDetached: (work: Promise<void>) => void
): Promise<void> {
  while (!signal.aborted) {
    const bridge = readState(config.instance).messagingBridges.find((item) => item.id === bridgeId);
    if (!bridge || bridge.kind !== "telegram" || bridge.status !== "configured") return;
    // readBridgeBotToken throws ENOENT if the encrypted secret file is
    // missing under the secretRef path (rotation, manual deletion,
    // corruption). Without a catch the rejection propagates out of
    // the loop and the supervisor reconcile restarts it on every
    // tick because shouldRun only checks for the secretRef entry,
    // not the file. Flip the bridge to "error" so the supervisor
    // drops it until the user re-supplies the token.
    let token: string | undefined;
    try {
      token = readBridgeBotToken(config, bridge);
    } catch (error) {
      await markBridgeError(
        config,
        bridgeId,
        "messaging.telegram.token_error",
        "messaging.telegram.mark_error_failed",
        error
      );
      return;
    }
    if (!token) {
      await markBridgeError(
        config,
        bridgeId,
        "messaging.telegram.token_error",
        "messaging.telegram.mark_error_failed",
        new Error("Telegram bot token secret is missing.")
      );
      return;
    }

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
      const incoming = extractIncomingPayload(update);
      if (incoming) {
        // Resolve photo bytes to a local file before submitting the
        // task. A download failure logs and continues with whatever
        // text/caption we already have so a transient network blip
        // doesn't drop the message entirely.
        const downloaded = incoming.photo
          ? await downloadIncomingPhoto(config, bridgeId, update.update_id, incoming, client).catch((error) => {
              appendLog(config.instance, "messaging.telegram.photo_download_error", {
                bridgeId,
                fileId: incoming.photo?.file_id,
                error: error instanceof Error ? error.message : String(error)
              });
              return undefined;
            })
          : undefined;
        try {
          const taskInput = buildTaskInput(incoming, downloaded?.path);
          const record = await receiveMessagingInput(config, bridgeId, {
            text: taskInput,
            target: String(incoming.chatId),
            media: downloaded?.media
          });
          // Surface a "typing…" indicator while the agent works, and
          // once the task settles mirror the assistant reply back to
          // the originating chat. The pulse is best-effort and runs
          // detached so a slow chat_action call doesn't block the
          // next update. Tracked via trackDetached so stopAll awaits
          // the in-flight state writes — see the matching shape in
          // src/integrations/discord-poller.ts.
          if (record.taskId) {
            const work = maintainTypingAndMirrorReply(
              config,
              bridgeId,
              record.taskId,
              incoming.chatId,
              client,
              signal
            ).catch((error) => {
              appendLog(config.instance, "messaging.telegram.typing_error", {
                bridgeId,
                error: error instanceof Error ? error.message : String(error)
              });
            });
            trackDetached(work);
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

// Combined typing pulse + reply mirror. While the task is non-terminal
// we refresh sendChatAction("typing") on a ~4s cadence so the chat
// shows "is typing…". Once the task settles we sync the assistant
// message into the chat session (the web UI's sync path) and dispatch
// the resulting text back to Telegram via sendMessagingOutput, which
// applies the MarkdownV2 transform and records an outbound message.
async function maintainTypingAndMirrorReply(
  config: RuntimeConfig,
  bridgeId: string,
  taskId: string,
  chatId: number,
  client: TelegramClient,
  signal: AbortSignal
): Promise<void> {
  await maintainTypingIndicator(config, taskId, chatId, client, signal);
  if (signal.aborted) return;

  // Decoupled from the typing pulse: if maintainTypingIndicator
  // returned early because of a transient sendChatAction error, the
  // task may still be running. Wait for terminal state before
  // syncing — without this, syncChatTaskResult would throw "Task
  // is not ready for chat sync" and the assistant reply would be
  // permanently dropped on a single typing failure.
  await awaitTerminalTask(config, taskId, signal);
  if (signal.aborted) return;

  // Resolve the chat session for this (bridge, chat) so we can land
  // the assistant message and look up the dispatch target. The session
  // exists because receiveMessagingInput went through the chat path.
  const session = findTelegramChatSession(config, bridgeId, chatId);
  if (!session || !session.source || session.source.kind !== "telegram") return;

  let replyText: string | undefined;
  try {
    const message = await syncChatTaskResult(config, session.id, taskId);
    if (message && message.role === "assistant") replyText = message.content;
  } catch (error) {
    appendLog(config.instance, "messaging.telegram.sync_error", {
      bridgeId,
      taskId,
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  // Empty replies or [SILENT]-suppressed messages produce nothing to
  // dispatch — leave the inbound record in place but stay quiet.
  if (!replyText || replyText.trim().length === 0) return;

  try {
    await sendMessagingOutput(config, bridgeId, {
      text: replyText,
      target: session.source.target
    });
  } catch (error) {
    appendLog(config.instance, "messaging.telegram.reply_error", {
      bridgeId,
      taskId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
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

// Resolve an inbound photo's file_id to a local path under the instance
// inbound directory. The path is stable across restarts (keyed on
// bridge + update_id + file_id), and the media descriptor records both
// the local path and the Telegram file_id so the agent can re-fetch via
// sendPhoto if it needs to echo the image back.
async function downloadIncomingPhoto(
  config: RuntimeConfig,
  bridgeId: string,
  updateId: number,
  incoming: IncomingPayload,
  client: TelegramClient
): Promise<{ path: string; media: MessagingMessageMedia } | undefined> {
  if (!incoming.photo) return undefined;
  const file = await client.getFile(incoming.photo.file_id);
  if (!file.file_path) {
    throw new Error("Telegram returned no file_path (file may exceed the 20MB Bot API limit)");
  }
  const bytes = await client.downloadFile(file.file_path);
  const ext = (extname(file.file_path) || ".jpg").toLowerCase();
  const dir = join(instanceRoot(config.instance), "inbound", bridgeId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${updateId}-${incoming.photo.file_id}${ext}`);
  await Bun.write(path, bytes);
  return {
    path,
    media: { kind: "photo", path, fileId: incoming.photo.file_id }
  };
}

// Compose the input string handed to submitTask. When a photo arrives
// we prefix the caption (or empty body) with a single line pointing at
// the saved file, so an agent inspecting `task.input` can pick up the
// attachment via the file toolset without changing how task inputs
// flow through the runtime.
function buildTaskInput(incoming: IncomingPayload, savedPath: string | undefined): string {
  if (!savedPath) return incoming.text;
  const header = `[photo: ${savedPath}]`;
  return incoming.text ? `${header}\n${incoming.text}` : header;
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
