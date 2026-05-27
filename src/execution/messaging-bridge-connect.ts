// Bounded runtime module for the messaging.add_bridge /connect flow.
//
// The HTTP /connect handler delegates here so http.ts stays a thin
// routing layer (matching the browser_fill_secret precedent in
// browser-fill-secrets.ts and the AGENTS.md guideline that handlers
// should delegate to bounded runtime modules). The flow:
//   1. Parse kind from approval.payload; reject unknown kinds.
//   2. Parse + validate the submitted name + bot-token + (for
//      discord) deliveryTargets. Run assertHeaderSafeToken BEFORE
//      resolveApproval so a malformed token does not burn the
//      approval — the chat card stays pending and the user can
//      retype.
//   3. resolveApproval(resumeChatTask: false) — atomic check-and-flip
//      from pending → approved that closes the deny-mid-create
//      race (browser-fill-secrets's precedent).
//   4. addMessagingBridge — the shared substrate the CLI and the
//      settings page also use. The bot token never enters audit
//      evidence or the chat transcript; the secret store handles
//      encryption at rest.
//   5. resumeChatTask with a result string reflecting actual
//      outcome, wrapped in a try/catch that calls failTask on
//      throw to recover an orphaned task (matches
//      browser-fill-secrets.ts:318-347). The same recovery is
//      used on the addMessagingBridge-failed path: the approval
//      is already resolved at that point, so the chat-task loop
//      must be told the create failed instead of being left
//      waiting indefinitely.

import type { Approval, MessagingBridgeRecord, RuntimeConfig } from "../types";
import { failTask, resolveApproval } from "../agent";
import { addMessagingBridge, assertHeaderSafeToken } from "../integrations/messaging";
import { appendTrace } from "../state";
import { resumeChatTask } from "./chat-task";

export interface MessagingBridgeConnectResult {
  status: number;
  body: {
    ok: boolean;
    message?: string;
    bridge?: MessagingBridgeRecord;
  };
}

export async function runMessagingBridgeConnect(
  config: RuntimeConfig,
  approval: Approval,
  secrets: Record<string, string>,
  deliveryTargetsRaw: unknown
): Promise<MessagingBridgeConnectResult> {
  const kind = approval.payload.kind === "telegram" || approval.payload.kind === "discord"
    ? (approval.payload.kind as "telegram" | "discord")
    : undefined;
  if (!kind) {
    return {
      status: 400,
      body: { ok: false, message: "Approval payload missing kind (telegram|discord); refusing to create bridge." }
    };
  }
  const submittedName = typeof secrets.name === "string" ? secrets.name.trim() : "";
  const submittedToken = typeof secrets.botToken === "string" ? secrets.botToken.trim() : "";
  const deliveryTargets = Array.isArray(deliveryTargetsRaw)
    ? deliveryTargetsRaw.map(String).map((t) => t.trim()).filter((t) => t.length > 0)
    : [];

  // Field-shape validations BEFORE resolveApproval so a malformed
  // submission does not burn the approval — the chat card stays
  // pending and the user can retype. The fill_secret precedent
  // (browser-fill-secrets.ts:67-105) does the same pre-validation
  // (missing slots + min length) before its resolveApproval at
  // line 189.
  if (!submittedName) {
    return { status: 200, body: { ok: false, message: "Bridge name is required." } };
  }
  if (!submittedToken) {
    return { status: 200, body: { ok: false, message: "Bot token is required." } };
  }
  // Token-format pre-check using the same assertion addMessagingBridge
  // would call internally. Running it here lets a header-unsafe token
  // bounce off the chat card with the approval still pending so the
  // user can paste a clean one without re-issuing the agent tool call.
  try {
    assertHeaderSafeToken(kind, submittedToken);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 200, body: { ok: false, message } };
  }
  if (kind === "discord" && deliveryTargets.length === 0) {
    return {
      status: 200,
      body: { ok: false, message: "Discord bridges require at least one channel id under deliveryTargets." }
    };
  }

  // Atomic check-and-flip closes the deny-mid-create race.
  try {
    await resolveApproval(config, approval.id, { actor: "user", resumeChatTask: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 410,
      body: { ok: false, message: `Could not lock approval for bridge create: ${message}` }
    };
  }

  const taskId = approval.taskId;
  const toolCallId = typeof approval.payload.toolCallId === "string"
    ? approval.payload.toolCallId
    : undefined;
  const kindLabel = kind === "telegram" ? "Telegram" : "Discord";

  let bridge: MessagingBridgeRecord;
  try {
    bridge = await addMessagingBridge(config, {
      name: submittedName,
      kind,
      botToken: submittedToken,
      deliveryTargets
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Approval already resolved — the chat card has flipped out of
    // pending state. Resume the chat-task loop with the failure so
    // the agent verbalizes the error back to the user. Recover an
    // orphaned task via failTask if the resume itself throws
    // (mirrors browser-fill-secrets.ts:318-347).
    if (taskId && toolCallId) {
      await resumeOrFail(
        config,
        taskId,
        toolCallId,
        `Could not create ${kindLabel} bridge: ${message}. Tell the user about the failure so they can retry from the settings page.`,
        approval.id
      );
    }
    return { status: 200, body: { ok: false, message } };
  }

  if (taskId && toolCallId) {
    await resumeOrFail(
      config,
      taskId,
      toolCallId,
      `${kindLabel} bridge added: ${bridge.name}. Tell the user it's ready and walk them through enrolling a chat (DM the bot, share the verification code, you approve from the settings page) if relevant.`,
      approval.id
    );
  }
  return { status: 200, body: { ok: true, bridge } };
}

// Wrap resumeChatTask so a terminal-task throw inside the chat-task
// loop (provider rate limit, dispatch error, etc.) doesn't leave the
// task in status="running" with no live executor — a real
// orphan-task hazard since the resume call flips the task to running
// before re-entering the loop. Mirrors browser-fill-secrets.ts's
// resumeChatTask wrapper: trace the failure, then failTask to flip
// the task out of running. failTask's own throw is swallowed
// silently — the next external trigger (user message, supervisor)
// will reconcile from the task row's current status.
async function resumeOrFail(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  result: string,
  approvalId: string
): Promise<void> {
  try {
    await resumeChatTask(config, taskId, toolCallId, result);
  } catch (resumeError) {
    appendTrace(config.instance, taskId, {
      type: "error",
      message: "resumeChatTask threw during messaging.add_bridge completion",
      data: {
        approvalId,
        toolCallId,
        error: resumeError instanceof Error ? resumeError.message : String(resumeError)
      }
    });
    try {
      await failTask(config, taskId, resumeError);
    } catch {
      // Best-effort recovery — the next external trigger will
      // observe whatever status failTask managed to land.
    }
  }
}
