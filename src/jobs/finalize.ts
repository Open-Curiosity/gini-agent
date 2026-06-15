// Async finalizer for prompt-job runs. Runs whenever a Task that carries a
// jobId reaches a terminal status (completed | failed | cancelled). It
// flips the linked JobRunRecord from "running" to a terminal status,
// stamps lastSuccessAt/lastFailureAt on the parent JobRecord, and emits a
// job.run.completed/failed event.
//
// Lives in its own file (separate from src/jobs/index.ts) so src/agent.ts
// can import it without re-importing the rest of the jobs module — that
// reverse path would close a cycle (jobs/index.ts already imports
// submitTask from agent.ts).
//
// Idempotent: if the run is already terminal, this is a no-op.

import type { RuntimeConfig, Task } from "../types";
import { addAudit, appendEvent, appendLog, insertChatBlock, isTerminalTaskStatus, mutateState, now, readState } from "../state";
import { syncChatTaskResult } from "../execution/chat";
// `sendMessagingOutput` is imported lazily inside dispatchJobReplyToBridge
// to avoid closing a static import cycle. The runtime graph would be:
//   agent.ts -> jobs/finalize.ts -> integrations/messaging.ts -> agent.ts
// (messaging.ts imports submitTask from agent.ts). A static cycle here
// would defeat the deliberate split between agent.ts and jobs/finalize.ts —
// see the leaf-module comment at src/agent.ts:51-55 — so we defer the
// messaging import until call time. Module-init cost is unchanged; the
// dynamic import resolves to the already-loaded module the first time
// dispatchJobReplyToBridge runs.

// Human-readable degradation note naming the skipped recipe(s) + the remedy.
// Shared by the chat system_note and the bridge mirror so both surfaces carry
// the same wording.
function skillSkipNote(skips: Array<{ name: string; reason: string }>): string {
  const named = skips.map((s) => `${s.name} (${s.reason})`).join(", ");
  return `Heads up: this run could not use ${skips.length} attached skill recipe(s) — ${named}. Re-enable the skill or re-attach it via update_job to restore full behavior.`;
}

export async function finalizeJobRunFromTask(config: RuntimeConfig, task: Task): Promise<void> {
  if (!task.jobId) return;
  if (!isTerminalTaskStatus(task.status)) return;
  // Capture session/oneShot context inside the mutateState write so the
  // post-write chat sync uses the same view we used to flip the run. The
  // run's fire-time skill skips ride along so the post-write delivery can
  // name the missing recipe(s) on the chat + bridge surfaces.
  let chatSessionIdToSync: string | undefined;
  let skillSkips: Array<{ name: string; reason: string }> | undefined;
  await mutateState(config.instance, (state) => {
    // Match the run by taskId first (most reliable), fall back to the
    // most recent running run for the job (covers older runs whose
    // taskId wasn't recorded yet).
    let run = state.jobRuns.find(
      (candidate) => candidate.jobId === task.jobId && candidate.taskId === task.id && candidate.status === "running"
    );
    if (!run) {
      run = state.jobRuns.find(
        (candidate) => candidate.jobId === task.jobId && candidate.status === "running"
      );
    }
    if (!run) return; // already finalized or never tracked
    // Capture the run's fire-time skill skips before we flip it terminal so
    // the post-write delivery can name the missing recipe(s).
    if (run.skillSkips && run.skillSkips.length > 0) skillSkips = run.skillSkips;
    const job = state.jobs.find((candidate) => candidate.id === task.jobId);
    const completedAt = now();
    if (task.status === "completed") {
      run.status = "completed";
      run.summary = task.summary;
      run.error = undefined;
    } else {
      run.status = "failed";
      run.summary = task.summary;
      run.error = task.error ?? (task.status === "cancelled" ? "Cancelled" : "Failed");
    }
    run.completedAt = completedAt;
    run.updatedAt = completedAt;
    if (run.taskId === undefined) run.taskId = task.id;
    if (job) {
      if (run.status === "completed") {
        job.lastSuccessAt = completedAt;
        job.lastError = undefined;
      } else {
        job.lastFailureAt = completedAt;
        job.lastError = run.error;
      }
      // One-shot reminders auto-pause after the FIRST terminal run (success
      // or failure). The user can resume manually through /jobs. Audit the
      // transition so the deactivation is traceable.
      if (job.oneShot === true && job.status === "active") {
        job.status = "paused";
        job.updatedAt = completedAt;
        addAudit(
          state,
          {
            actor: "runtime",
            action: "job.oneshot.completed",
            target: job.id,
            risk: "low",
            taskId: task.id,
            evidence: { runId: run.id, runStatus: run.status }
          },
          { jobId: job.id, agentId: job.agentId }
        );
      }
      // Stage the chat sync for after the write closes — calling another
      // mutateState (which syncChatTaskResult does) inside this one would
      // deadlock the state queue.
      if (job.chatSessionId) {
        chatSessionIdToSync = job.chatSessionId;
      }
    }
    appendEvent(
      state,
      {
        kind: "job",
        action: run.status === "completed" ? "job.run.completed" : "job.run.failed",
        target: task.jobId!,
        jobId: task.jobId,
        taskId: task.id,
        risk: "low",
        summary: run.status === "completed" ? "Prompt job run completed." : "Prompt job run failed.",
        data: { runId: run.id, taskStatus: task.status }
      },
      { taskId: task.id, agentId: task.agentId ?? job?.agentId ?? run.agentId }
    );
  });

  // Materialize the assistant chat message for jobs created via the
  // agent tool with a chat session. syncChatTaskResult is idempotent
  // (no-ops if the message already exists) and only writes for terminal
  // task states. Validate the session still exists BEFORE the sync so
  // a deletion mid-flight doesn't land an orphan ChatMessageRecord
  // (createChatMessage silently skips session linkage when the session
  // is missing — that path is exactly what we don't want here).
  if (chatSessionIdToSync) {
    const sessionExists = readState(config.instance).chatSessions.some((s) => s.id === chatSessionIdToSync);
    if (!sessionExists) {
      appendLog(config.instance, "job.chat.session.vanished", {
        jobId: task.jobId,
        taskId: task.id,
        sessionId: chatSessionIdToSync
      });
      return;
    }
    try {
      await syncChatTaskResult(config, chatSessionIdToSync, task.id);
    } catch (error) {
      appendLog(config.instance, "job.chat.sync.error", {
        jobId: task.jobId,
        taskId: task.id,
        sessionId: chatSessionIdToSync,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    // Surface fire-time skill skips as ONE deterministic system_note in the
    // job thread, after the synced answer. This is the guaranteed (not
    // model-reliant) user-facing degradation signal for the web surface. Only
    // for a completed run — a failed run's own error already carries the
    // signal. Keyed to land in-thread after the answer; idempotent because
    // finalize early-returns once the run is terminal (so we run once).
    if (skillSkips && task.status === "completed") {
      try {
        insertChatBlock(config.instance, {
          kind: "system_note",
          sessionId: chatSessionIdToSync,
          text: skillSkipNote(skillSkips),
          taskId: task.id,
          runId: task.runId,
          ...(task.threadId != null ? { threadId: task.threadId } : {}),
          ...(task.parentBlockId != null ? { parentBlockId: task.parentBlockId } : {})
        });
      } catch (error) {
        appendLog(config.instance, "job.skill.skip.note.error", {
          jobId: task.jobId,
          taskId: task.id,
          sessionId: chatSessionIdToSync,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    // Mirror back to the originating bridge on every terminal status —
    // a failed scheduled "remind me in 20s" should still surface SOME
    // signal to the chat the user started in (the agent's error
    // summary is the best we have), otherwise the user just hears
    // silence and assumes the bot dropped the ball. The dispatch
    // helper itself filters out empty / `[SILENT]` content, so the
    // case where the synced assistant message is genuinely empty
    // (failed task with no error summary) still mirrors nothing.
    await dispatchJobReplyToBridge(config, chatSessionIdToSync, task, skillSkips);
  }
}

async function dispatchJobReplyToBridge(
  config: RuntimeConfig,
  chatSessionId: string,
  task: Task,
  skillSkips?: Array<{ name: string; reason: string }>
): Promise<void> {
  const state = readState(config.instance);
  const session = state.chatSessions.find((candidate) => candidate.id === chatSessionId);
  if (!session) return;
  // Prefer outboundMirror (set on dedicated job sessions to keep
  // inbound routing keyed off the live channel session) and fall back
  // to source (set on live channel sessions where the two are the
  // same).
  const dispatchTo = session.outboundMirror ?? session.source;
  if (!dispatchTo) return;
  // Bridge-dispatch only applies to telegram / discord sources. The
  // openclaw provenance source carries no live channel routing
  // (it's just a migration breadcrumb), so a job that landed on a
  // migrated chat has nowhere to mirror its assistant reply.
  if (dispatchTo.kind !== "telegram" && dispatchTo.kind !== "discord") return;
  // The synced assistant message is the most recent one on the
  // session keyed to this task; pick it up from chatMessages so we
  // never accidentally re-dispatch an older turn.
  const assistantMessage = state.chatMessages
    .filter(
      (m) =>
        m.sessionId === chatSessionId &&
        m.taskId === task.id &&
        m.role === "assistant" &&
        m.kind !== "tool_transcript" &&
        m.kind !== "approval_reason"
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  const replyText = assistantMessage?.content?.trim();
  // `[SILENT]` summaries explicitly suppress the bridge mirror. The
  // canonical match is EXACT (trimmed), not prefix — matching the
  // suppression contract in src/execution/chat.ts and the system-
  // prompt instruction at src/jobs/index.ts that tells the LLM to
  // "respond with exactly [SILENT] and nothing else". A prefix match
  // here would silently drop a legitimate reply like
  // `"[SILENT] but here's an update"`, which is the exact failure
  // mode the chat-side test pins against.
  if (!replyText || replyText.length === 0) return;
  if (replyText === "[SILENT]") return;
  // Append the one-line degradation note for bridge/CLI users when the run
  // skipped attachments — so the chat system_note isn't the only surface that
  // reports it. Only on a real (non-empty, non-[SILENT]) reply.
  const bridgeText = skillSkips && skillSkips.length > 0
    ? `${replyText}\n\n${skillSkipNote(skillSkips)}`
    : replyText;
  try {
    const replyToMessageId = dispatchTo.lastInboundMessageId;
    const { sendMessagingOutput } = await import("../integrations/messaging");
    await sendMessagingOutput(config, dispatchTo.bridgeId, {
      text: bridgeText,
      target: dispatchTo.target,
      ...(replyToMessageId !== undefined ? { replyToMessageId } : {})
    });
  } catch (error) {
    appendLog(config.instance, "job.messaging.dispatch.error", {
      jobId: task.jobId,
      taskId: task.id,
      sessionId: chatSessionId,
      bridgeId: dispatchTo.bridgeId,
      kind: dispatchTo.kind,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
