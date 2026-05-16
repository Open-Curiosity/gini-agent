// Telegram update handlers.
//
// The poller dispatches each accepted update (message / callback_query)
// here. These handlers own:
//   - Authorization: lookup the Telegram `user_id` (NEVER `chat.id`) in
//     the bridge's allowlist.
//   - Session routing: bind each allowlisted user to a per-user Gini
//     chat session so multi-turn context survives across messages.
//   - Per-task agent stamping: each allowlist entry pins an `agentId`;
//     submitTask stamps it onto the Task row so the chat-task loop
//     resolves the intended agent's provider/toolset/memory namespace
//     without racing on the instance-wide active-agent pointer.
//   - Cross-user approval prevention: a callback_query's
//     `from.id` must match the allowlist entry that owns the chat
//     session the approval was emitted in.
//
// All audit rows here live under `messaging.telegram.*` actions so the
// trace is easy to filter; none of them include the bot token.

import type {
  MessagingBridgeRecord,
  MessagingMessageRecord,
  RuntimeConfig,
  RuntimeState,
  TelegramAllowlistEntry
} from "../../types";
import {
  addAudit,
  createChatMessage,
  createMessagingMessageRecord,
  mutateState,
  now,
  readState
} from "../../state";
import { submitTask, decideApproval } from "../../agent";
import { createConversationRun, linkRunToTask } from "../../execution/runs";
import { resolveConnectorSecret } from "../connectors";
import {
  answerCallbackQuery,
  editMessageText,
  sendChatAction,
  type TelegramCallbackQuery,
  type TelegramIncomingMessage
} from "./telegram-transport";
import { dispatchOutboundMessage, ensureChatSessionForUser } from "./telegram-stream";

// Per-update offset advancement helper. Called inside whichever mutateState
// records the durable inbound / audit row for an update so the offset
// advance and the side-effect commit atomically. Without this, a crash
// after dispatch but before the post-batch offset write would re-deliver
// the same update on restart and create duplicate Task rows.
function advanceTelegramOffset(state: RuntimeState, bridgeId: string, updateId: number): void {
  const bridge = state.messagingBridges.find((b) => b.id === bridgeId);
  if (!bridge?.telegram) return;
  const next = updateId + 1;
  if (next > (bridge.telegram.updateOffset ?? 0)) {
    bridge.telegram.updateOffset = next;
    bridge.updatedAt = now();
  }
}

function findAllowlistEntry(
  bridge: MessagingBridgeRecord,
  telegramUserId: number
): TelegramAllowlistEntry | undefined {
  return bridge.telegram?.allowlist.find((entry) => entry.telegramUserId === telegramUserId);
}

// Inbound message handler. The bridge has already been validated as
// configured and telegram-typed by the poller.
//
// `updateId` is the enclosing TelegramUpdate.update_id; the handler
// advances `bridge.telegram.updateOffset` past it inside the same
// `mutateState` that records the durable inbound row, so the offset never
// runs ahead of the side-effect commit. Combined with the externalId
// dedupe below this makes restart re-delivery a no-op.
export async function handleInboundMessage(
  config: RuntimeConfig,
  bridgeId: string,
  message: TelegramIncomingMessage,
  updateId: number
): Promise<void> {
  const fromId = message.from?.id;
  const chatId = message.chat.id;
  // No `from` means a channel post or system message we don't drive
  // agents from; treat as unsupported so the audit row exists for later
  // forensics without dispatching anything.
  if (typeof fromId !== "number") {
    await auditUnsupported(config, bridgeId, updateId, "no_from", { chatId, messageId: message.message_id });
    return;
  }
  const text = message.text?.trim() ?? "";
  if (text.length === 0) {
    // Empty / non-text messages (photos, stickers, voice) are out of
    // scope for v1. Drop with an audit row so multi-user setups can see
    // which user is sending what.
    await auditUnsupported(config, bridgeId, updateId, "non_text", {
      chatId,
      telegramUserId: fromId,
      messageId: message.message_id
    });
    return;
  }

  const bridge = readState(config.instance).messagingBridges.find((b) => b.id === bridgeId);
  if (!bridge) return;
  const entry = findAllowlistEntry(bridge, fromId);
  if (!entry) {
    await auditDropped(config, bridgeId, updateId, "unauthorized", {
      chatId,
      telegramUserId: fromId,
      telegramUsername: message.from?.username,
      messageId: message.message_id
    });
    return;
  }

  // Defense-in-depth re-validation. The deleteAgent cascade removes
  // allowlist entries whose agent is gone, but an orphan can still
  // arrive via a state import, manual JSON edit, or a future
  // regression that bypasses the cascade. Failing closed at the
  // inbound boundary preserves the per-user identity-mapping guarantee
  // from ADR agent-memory-isolation.md instead of silently falling
  // through to the instance default in resolveEffectiveContext.
  const agentExists = readState(config.instance).agents.some((a) => a.id === entry.agentId);
  if (!agentExists) {
    await auditDropped(config, bridgeId, updateId, "agent_missing", {
      chatId,
      telegramUserId: fromId,
      telegramUsername: message.from?.username,
      messageId: message.message_id,
      agentId: entry.agentId
    });
    return;
  }

  // Dedupe by externalId. A restart between submitTask and the durable
  // inbound row could otherwise re-deliver the same message_id and
  // create a second Task. If we already stamped an inbound row for this
  // (bridgeId, chatId, message_id), skip the side effects entirely and
  // just advance the offset. Telegram's `message_id` is unique per chat
  // (https://core.telegram.org/bots/api#message), not per bot, so the
  // chat prefix is required: two distinct chats can independently produce
  // identical `message_id` values and the un-prefixed key would silently
  // drop the second one.
  const externalId = `${chatId}:${message.message_id}`;
  const existingInbound = readState(config.instance).messagingMessages.find(
    (m) => m.bridgeId === bridgeId && m.direction === "inbound" && m.externalId === externalId
  );
  if (existingInbound) {
    await mutateState(config.instance, (state) => {
      advanceTelegramOffset(state, bridgeId, updateId);
    });
    return;
  }

  // Best-effort `typing` indicator. Failure here doesn't change behavior;
  // we just want the user to see the bot is alive while the LLM runs. We
  // emit this before the atomic gate because telemetry that races a
  // disable is harmless — the only state mutation in this branch is the
  // connector.secret.use audit emitted by resolveConnectorSecret.
  if (bridge.connectorId) {
    const token = await resolveConnectorSecret(config, bridge.connectorId, "token");
    if (token) {
      await sendChatAction(token, chatId, "typing").catch(() => {});
    }
  }

  // Ensure a per-user chat session exists. The allowlist entry caches
  // the session id so subsequent messages from the same user keep
  // landing in the same session (preserving context).
  const sessionId = await ensureChatSessionForUser(config, bridge.id, entry);

  // Atomic gate. The durable inbound-row write, the chat-message write,
  // the offset advance, and the live-state re-validation all happen
  // inside a single mutateState so a concurrent `disableMessagingBridge`,
  // `removeTelegramAllowlistEntry`, or `deleteAgent` cannot land
  // BETWEEN the status check and the work that follows. If the live
  // state has flipped since the snapshot at line 105, we audit the
  // drop, advance the offset, and return a "skip" verdict so the caller
  // never enqueues a task whose reply path the operator just revoked.
  // Otherwise we stamp the inbound + chat-message rows (without taskId
  // yet — backfilled below after submitTask) and return a "proceed"
  // verdict carrying the resolved ids.
  type GateVerdict =
    | { kind: "skip" }
    | {
        kind: "proceed";
        inboundId: string;
        chatMessageId: string;
        sessionId: string;
        agentId: string;
        telegramUserId: number;
      };
  const gate = await mutateState<GateVerdict>(config.instance, (state) => {
    const liveBridge = state.messagingBridges.find((b) => b.id === bridgeId);
    if (!liveBridge || liveBridge.status !== "configured") {
      addAudit(state, {
        actor: "runtime",
        action: "messaging.telegram.dropped",
        target: bridgeId,
        risk: "low",
        evidence: {
          bridgeId,
          reason: "disabled_during_dispatch",
          chatId,
          telegramUserId: fromId,
          messageId: message.message_id,
          bridgeStatus: liveBridge?.status
        }
      });
      advanceTelegramOffset(state, bridgeId, updateId);
      return { kind: "skip" };
    }
    const liveEntry = liveBridge.telegram?.allowlist.find(
      (e) => e.telegramUserId === fromId
    );
    if (!liveEntry) {
      addAudit(state, {
        actor: "runtime",
        action: "messaging.telegram.dropped",
        target: bridgeId,
        risk: "low",
        evidence: {
          bridgeId,
          reason: "unauthorized",
          chatId,
          telegramUserId: fromId,
          telegramUsername: message.from?.username,
          messageId: message.message_id
        }
      });
      advanceTelegramOffset(state, bridgeId, updateId);
      return { kind: "skip" };
    }
    const liveAgent = state.agents.some((a) => a.id === liveEntry.agentId);
    if (!liveAgent) {
      addAudit(state, {
        actor: "runtime",
        action: "messaging.telegram.dropped",
        target: bridgeId,
        risk: "low",
        evidence: {
          bridgeId,
          reason: "agent_missing",
          chatId,
          telegramUserId: fromId,
          telegramUsername: message.from?.username,
          messageId: message.message_id,
          agentId: liveEntry.agentId
        }
      });
      advanceTelegramOffset(state, bridgeId, updateId);
      return { kind: "skip" };
    }

    // Write durable artifacts. taskId/runId backfilled after submitTask
    // returns; the gate is what keeps a disable from racing in between.
    const chatMessage = createChatMessage(state, {
      sessionId,
      role: "user",
      content: text
    });
    const inboundRow = createMessagingMessageRecord(state, {
      bridgeId,
      direction: "inbound",
      status: "received",
      target: String(chatId),
      text,
      chatSessionId: sessionId,
      externalId
    });
    advanceTelegramOffset(state, bridgeId, updateId);
    return {
      kind: "proceed",
      inboundId: inboundRow.id,
      chatMessageId: chatMessage.id,
      sessionId,
      agentId: liveEntry.agentId,
      telegramUserId: liveEntry.telegramUserId
    };
  });

  if (gate.kind === "skip") return;

  // Create a conversation run + submit the chat task, mirroring
  // submitChatMessage in src/execution/chat.ts so messaging messages
  // produce identical run/task records to web-driven chats. The allowlist
  // entry's pinned agent is stamped onto the Task row via the
  // `agentId` option so the asynchronously-scheduled chat-task loop
  // resolves the intended agent without racing on the instance-wide
  // active-agent pointer (multi-user safe). Reaching this point means
  // the atomic gate above committed under "configured" status, so any
  // disable that lands now races a write the operator already lost.
  const run = await createConversationRun(config, { conversationId: gate.sessionId, input: text });
  const task = await submitTask(config, text, {
    runId: run.id,
    mode: "chat",
    agentId: gate.agentId
  });
  await linkRunToTask(config, run.id, task);

  // Backfill taskId/runId onto the durable artifacts the gate wrote.
  // createChatMessage usually populates session.taskIds/runIds at write
  // time; we replicate that here since the rows were stamped before the
  // task existed.
  await mutateState(config.instance, (state) => {
    const inboundRow = state.messagingMessages.find((m) => m.id === gate.inboundId);
    if (inboundRow) {
      inboundRow.taskId = task.id;
      inboundRow.updatedAt = now();
    }
    const chatMessageRow = state.chatMessages.find((m) => m.id === gate.chatMessageId);
    if (chatMessageRow) {
      chatMessageRow.taskId = task.id;
      chatMessageRow.runId = run.id;
    }
    const session = state.chatSessions.find((s) => s.id === gate.sessionId);
    if (session) {
      if (!session.taskIds.includes(task.id)) session.taskIds.push(task.id);
      if (!session.runIds.includes(run.id)) session.runIds.push(run.id);
      session.updatedAt = now();
    }
    const runRecord = state.runs.find((r) => r.id === run.id);
    if (runRecord) {
      runRecord.userMessageId = gate.chatMessageId;
      runRecord.updatedAt = now();
    }
    addAudit(state, {
      actor: "runtime",
      action: "messaging.telegram.inbound_dispatched",
      target: bridgeId,
      risk: "low",
      taskId: task.id,
      evidence: {
        bridgeId,
        telegramUserId: gate.telegramUserId,
        agentId: gate.agentId,
        chatSessionId: gate.sessionId,
        chatId,
        messageId: message.message_id
      }
    });
  });
}

// Callback-query handler (inline-keyboard button press). Used for
// approval routing: a [Approve] or [Deny] tap arrives as a
// callback_query with `data` matching the approval payload we sent.
//
// `updateId` is the enclosing TelegramUpdate.update_id; advanced into
// `bridge.telegram.updateOffset` inside the same `mutateState` that
// records the decision audit so the offset never runs ahead of the
// side-effect commit.
export async function handleCallbackQuery(
  config: RuntimeConfig,
  bridgeId: string,
  query: TelegramCallbackQuery,
  updateId: number
): Promise<void> {
  const data = query.data ?? "";
  // We accept `appr:<id>` and `deny:<id>`. Anything else is logged and
  // acknowledged so the Telegram UI's spinner clears even if the data
  // came from an outdated keyboard.
  const match = /^(appr|deny):(.+)$/.exec(data);
  const bridge = readState(config.instance).messagingBridges.find((b) => b.id === bridgeId);
  if (!bridge) return;
  const token = bridge.connectorId
    ? await resolveConnectorSecret(config, bridge.connectorId, "token")
    : undefined;

  if (!match) {
    await auditUnsupported(config, bridgeId, updateId, "callback_data", {
      telegramUserId: query.from.id,
      data
    });
    if (token) await answerCallbackQuery(token, query.id, "Unsupported button.").catch(() => {});
    return;
  }

  const decisionKind = match[1] === "appr" ? "approve" : "deny";
  const approvalId = match[2]!;
  const fromId = query.from.id;
  const entry = findAllowlistEntry(bridge, fromId);
  if (!entry) {
    await auditDropped(config, bridgeId, updateId, "unauthorized_callback", {
      telegramUserId: fromId,
      telegramUsername: query.from.username,
      approvalId,
      decisionKind
    });
    if (token) await answerCallbackQuery(token, query.id, "Not authorized.").catch(() => {});
    return;
  }

  // Cross-user approval prevention. The approval prompt we sent carries
  // a stamped MessagingMessageRecord with the approval id and the chat
  // session that owned it. We resolve the session, find the allowlist
  // entry that owns the session, and require the callback's from.id to
  // match. Without this, allowlisted-user-A could resolve allowlisted-
  // user-B's pending action just by tapping the button in their own
  // chat.
  const state = readState(config.instance);
  const outboundPrompt = state.messagingMessages.find(
    (m) => m.bridgeId === bridge.id && m.approvalId === approvalId && m.direction === "outbound"
  );
  // Find the owning allowlist entry via the chat session the prompt was
  // emitted into. This is the strict guard.
  const sessionIdOnPrompt = outboundPrompt?.chatSessionId;
  const owningEntry = sessionIdOnPrompt
    ? bridge.telegram?.allowlist.find((a) => a.chatSessionId === sessionIdOnPrompt)
    : undefined;
  if (!owningEntry || owningEntry.telegramUserId !== fromId) {
    await auditDropped(config, bridgeId, updateId, "cross_user_approval", {
      telegramUserId: fromId,
      approvalId,
      decisionKind,
      expectedTelegramUserId: owningEntry?.telegramUserId
    });
    if (token) await answerCallbackQuery(token, query.id, "This approval is for another user.").catch(() => {});
    return;
  }

  // Live re-validation at the side-effect boundary. Every check above
  // ran against the bridge snapshot captured at handler entry; the
  // intervening `await resolveConnectorSecret` (and any future awaits)
  // is a race window for `disableMessagingBridge`, the deleteAgent
  // allowlist cascade, or `removeTelegramAllowlistEntry` to land. We
  // re-read state and re-verify the bridge is still configured AND the
  // (caller, owner) pair still resolves to the same allowlist entries,
  // failing closed so a revoked user can't flip a pending approval
  // through the gap.
  const liveState = readState(config.instance);
  const liveBridge = liveState.messagingBridges.find((b) => b.id === bridgeId);
  if (!liveBridge || liveBridge.status !== "configured" || !liveBridge.telegram) {
    await auditDropped(config, bridgeId, updateId, "callback_revoked", {
      telegramUserId: fromId,
      approvalId,
      decisionKind,
      reasonDetail: "bridge_unavailable"
    });
    if (token) await answerCallbackQuery(token, query.id, "Bridge unavailable.").catch(() => {});
    return;
  }
  const liveEntry = findAllowlistEntry(liveBridge, fromId);
  const liveOwningEntry = sessionIdOnPrompt
    ? liveBridge.telegram.allowlist.find((a) => a.chatSessionId === sessionIdOnPrompt)
    : undefined;
  if (
    !liveEntry ||
    !liveOwningEntry ||
    liveOwningEntry.telegramUserId !== fromId ||
    liveEntry.telegramUserId !== liveOwningEntry.telegramUserId
  ) {
    await auditDropped(config, bridgeId, updateId, "callback_revoked", {
      telegramUserId: fromId,
      approvalId,
      decisionKind,
      reasonDetail: "allowlist_revoked"
    });
    if (token) await answerCallbackQuery(token, query.id, "Permission revoked.").catch(() => {});
    return;
  }

  // Ack first. Telegram's ack window (~10-15s) is shorter than
  // `decideApproval` can take in the worst case (the approve branch may
  // run a side-effecting tool, then re-enter the chat-task loop for
  // another LLM round). Acking after that work means the user sees a
  // hung button spinner and Telegram silently rejects the late ack.
  // Fire-and-forget so the network round-trip doesn't add latency to
  // the actual approval execution.
  if (token) {
    void answerCallbackQuery(token, query.id, "Processing...").catch(() => {});
  }

  // Capture the prompt message id BEFORE running decideApproval so we
  // can reflect the verdict via editMessageText even if state mutates
  // in between.
  const promptExternalId = outboundPrompt?.externalId;
  const promptChatId = outboundPrompt?.target;

  try {
    await decideApproval(config, approvalId, decisionKind);
    await mutateState(config.instance, (s) => {
      addAudit(s, {
        actor: "user",
        action: `messaging.telegram.approval_${decisionKind}`,
        target: bridge.id,
        risk: "medium",
        evidence: {
          bridgeId: bridge.id,
          telegramUserId: fromId,
          approvalId,
          decision: decisionKind
        }
      });
      advanceTelegramOffset(s, bridgeId, updateId);
    });
    // Reflect the verdict on the original prompt message. Telegram only
    // honors a single answerCallbackQuery per query.id (we already used
    // ours on the early ack), so editing the prompt body is the only
    // way to surface the outcome on the message itself.
    if (token && promptExternalId && promptChatId) {
      const verdictText = decisionKind === "approve" ? "Approved." : "Denied.";
      await editMessageText(token, promptChatId, Number(promptExternalId), verdictText).catch(() => {});
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await mutateState(config.instance, (s) => {
      addAudit(s, {
        actor: "runtime",
        action: "messaging.telegram.approval_error",
        target: bridge.id,
        risk: "low",
        evidence: { approvalId, decision: decisionKind, error: message }
      });
      advanceTelegramOffset(s, bridgeId, updateId);
    });
    if (token && promptExternalId && promptChatId) {
      await editMessageText(token, promptChatId, Number(promptExternalId), "Approval failed.").catch(() => {});
    }
  }
}

async function auditDropped(
  config: RuntimeConfig,
  bridgeId: string,
  updateId: number | undefined,
  reason: string,
  evidence: Record<string, unknown>
): Promise<void> {
  await mutateState(config.instance, (state) => {
    addAudit(state, {
      actor: "runtime",
      action: "messaging.telegram.dropped",
      target: bridgeId,
      risk: "low",
      evidence: { bridgeId, reason, ...evidence }
    });
    // Advance offset alongside the drop audit so a runtime restart
    // doesn't re-dispatch this update and emit a duplicate drop row.
    // `updateId === undefined` means the caller (e.g. callback-query
    // paths) wants to log but not advance the offset.
    if (typeof updateId === "number") {
      advanceTelegramOffset(state, bridgeId, updateId);
    }
  });
}

async function auditUnsupported(
  config: RuntimeConfig,
  bridgeId: string,
  updateId: number | undefined,
  reason: string,
  evidence: Record<string, unknown>
): Promise<void> {
  await mutateState(config.instance, (state) => {
    addAudit(state, {
      actor: "runtime",
      action: "messaging.telegram.unsupported_update",
      target: bridgeId,
      risk: "low",
      evidence: { bridgeId, reason, ...evidence }
    });
    if (typeof updateId === "number") {
      advanceTelegramOffset(state, bridgeId, updateId);
    }
  });
}

// Exported for the messaging-finalize hook: locate the outbound row for
// a task's reply and the chat session, so the finalize hook can edit
// the streaming placeholder instead of posting a fresh message.
export function findInboundMessageForTask(
  config: RuntimeConfig,
  taskId: string
): MessagingMessageRecord | undefined {
  return readState(config.instance).messagingMessages.find(
    (m) => m.taskId === taskId && m.direction === "inbound"
  );
}

// Re-export for src/integrations/messaging.ts which owns outbound
// dispatch routing across all bridge kinds.
export { dispatchOutboundMessage };
