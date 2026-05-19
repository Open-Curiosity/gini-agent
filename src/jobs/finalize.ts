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
import { addAudit, appendEvent, appendLog, isTerminalTaskStatus, mutateState, now, readState } from "../state";
import { syncChatTaskResult } from "../execution/chat";
import { sendMessagingOutput } from "../integrations/messaging";

export async function finalizeJobRunFromTask(config: RuntimeConfig, task: Task): Promise<void> {
  if (!task.jobId) return;
  if (!isTerminalTaskStatus(task.status)) return;
  // Capture session/oneShot context inside the mutateState write so the
  // post-write chat sync uses the same view we used to flip the run.
  let chatSessionIdToSync: string | undefined;
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
        addAudit(state, {
          actor: "runtime",
          action: "job.oneshot.completed",
          target: job.id,
          risk: "low",
          taskId: task.id,
          evidence: { runId: run.id, runStatus: run.status }
        });
      }
      // Stage the chat sync for after the write closes — calling another
      // mutateState (which syncChatTaskResult does) inside this one would
      // deadlock the state queue.
      if (job.chatSessionId) {
        chatSessionIdToSync = job.chatSessionId;
      }
    }
    appendEvent(state, {
      kind: "job",
      action: run.status === "completed" ? "job.run.completed" : "job.run.failed",
      target: task.jobId!,
      jobId: task.jobId,
      taskId: task.id,
      risk: "low",
      summary: run.status === "completed" ? "Prompt job run completed." : "Prompt job run failed.",
      data: { runId: run.id, taskStatus: task.status }
    });
  });

  // Materialize the assistant chat message for jobs created via the agent
  // tool with a chat session. syncChatTaskResult is idempotent (no-ops if
  // the message already exists) and only writes for terminal task states,
  // both of which match our gating. Wrap in try/catch so a vanished
  // session can't break the finalize hook for everyone else.
  if (chatSessionIdToSync) {
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
    // When the chat session was opened by a messaging bridge (Discord
    // or Telegram), mirror the freshly-synced assistant reply out to
    // the originating chat. Without this, a "remind me in 20s" job
    // would settle quietly in the chat session record but never reach
    // Discord/Telegram — the agent's promise to follow up would
    // silently break. We thread onto `lastInboundMessageId` so the
    // delayed reply lands as a reply to the user's original prompt
    // (Discord message_reference / Telegram reply_to_message_id);
    // bridges without a thread anchor still send unthreaded.
    if (task.status === "completed") {
      await dispatchJobReplyToBridge(config, chatSessionIdToSync, task);
    }
  }
}

async function dispatchJobReplyToBridge(
  config: RuntimeConfig,
  chatSessionId: string,
  task: Task
): Promise<void> {
  const state = readState(config.instance);
  const session = state.chatSessions.find((candidate) => candidate.id === chatSessionId);
  if (!session || !session.source) return;
  const source = session.source;
  // The synced assistant message is the most recent one on the
  // session keyed to this task; pick it up from chatMessages so we
  // never accidentally re-dispatch an older turn.
  const assistantMessage = state.chatMessages
    .filter((m) => m.sessionId === chatSessionId && m.taskId === task.id && m.role === "assistant")
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  const replyText = assistantMessage?.content?.trim();
  // `[SILENT]` summaries explicitly suppress the bridge mirror — same
  // convention the inline reply mirror in the pollers honors.
  if (!replyText || replyText.length === 0) return;
  if (replyText.startsWith("[SILENT]")) return;
  try {
    const replyToMessageId = source.lastInboundMessageId;
    await sendMessagingOutput(config, source.bridgeId, {
      text: replyText,
      target: source.target,
      ...(replyToMessageId !== undefined ? { replyToMessageId } : {})
    });
  } catch (error) {
    appendLog(config.instance, "job.messaging.dispatch.error", {
      jobId: task.jobId,
      taskId: task.id,
      sessionId: chatSessionId,
      bridgeId: source.bridgeId,
      kind: source.kind,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
