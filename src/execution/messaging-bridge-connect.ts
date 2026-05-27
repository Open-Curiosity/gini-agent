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
import { sanitizeBridgeStatusMessage } from "../integrations/messaging-poller-helpers";
import { addAudit, appendTrace, mutateState } from "../state";
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
  // CRITICAL: capture the return value — resolveApproval can succeed
  // (no throw) but internally flip status approved → denied via
  // executeApprovedAction's terminal-task guard. If the owning task
  // went terminal between the chat card mounting and the submit
  // landing, the approval comes back denied; proceeding to
  // addMessagingBridge in that state would create a bridge for a
  // cancelled task and audit it as approved.
  let resolved: Approval;
  try {
    const result = await resolveApproval(config, approval.id, { actor: "user", resumeChatTask: false });
    resolved = result.approval;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 410,
      body: { ok: false, message: `Could not lock approval for bridge create: ${message}` }
    };
  }
  if (resolved.status !== "approved") {
    return {
      status: 410,
      body: {
        ok: false,
        message: `Approval was ${resolved.status} during resolution (likely because the owning task became terminal); no bridge was created.`
      }
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
    const raw = error instanceof Error ? error.message : String(error);
    // Strip absolute filesystem paths and Authorization / bot-token
    // URL substrings before the message reaches the browser, the
    // chat-task resume, or any persisted artifact. The sibling
    // surfaces in messaging.ts (checkMessagingBridge, sendMessagingOutput)
    // already pipe through this sanitizer; the chat-side card now
    // does too. Filesystem-failure messages from writeSecret /
    // writeState can include absolute paths under <instanceRoot>,
    // and any Telegram fetch error in addMessagingBridge would
    // echo `/bot<token>/`.
    const message = sanitizeBridgeStatusMessage(raw);
    // Approval already resolved — the chat card has flipped out of
    // pending state. Resume the chat-task loop with the sanitized
    // failure string so the agent verbalizes the error back to the
    // user. Recover an orphaned task via failTask if the resume
    // itself throws (mirrors browser-fill-secrets.ts:318-347).
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

  // Stamp a follow-up audit row with the chat-side lineage. The
  // shared substrate (createMessagingBridgeRecord) writes a generic
  // `messaging.configured` row with actor:"user" and no task/approval
  // reference, so a bridge created from CLI vs settings vs chat is
  // indistinguishable in the audit log. Add a complementary row so
  // operators can prove "bridge X was created from approval Y inside
  // task Z". Mirrors browser-fill-secrets.ts:247-267 in spirit.
  await mutateState(config.instance, (state) => {
    // AgentContext is a discriminated union — `{taskId}` only
    // satisfies it when taskId is a string, so narrow before
    // passing. messaging.add_bridge approvals always carry a taskId
    // (set in tool-dispatch.ts:requestMessagingBridgeTool), but the
    // wire type makes Approval.taskId optional; fall through to
    // {system: true} if a future caller mints the approval without
    // one.
    addAudit(
      state,
      {
        actor: "user",
        action: "messaging.add_bridge",
        target: bridge.id,
        risk: "high",
        taskId,
        approvalId: approval.id,
        evidence: {
          kind,
          bridgeName: bridge.name,
          toolCallId: toolCallId ?? null
        }
      },
      taskId ? { taskId } : { system: true }
    );
  });

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
