import { submitTask } from "../agent";
import {
  createChatMessage,
  createChatSession,
  deleteChatSession,
  mutateState,
  readState,
  renameChatSession
} from "../state";
import type { ChatMessageRecord, RuntimeConfig, TaskStatus } from "../types";
import { createConversationRun, linkRunToTask } from "./runs";

// Statuses where a task is no longer producing partial text. Once a task
// reaches one of these, the synthesized streaming message is dropped in
// favor of the synced assistant message (or task error).
const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "waiting_approval"
]);

export function listChatSessions(config: RuntimeConfig) {
  const state = readState(config.instance);
  return state.chatSessions.map((session) => ({
    ...session,
    messages: state.chatMessages.filter((message) => message.sessionId === session.id),
    runs: state.runs.filter((run) => session.runIds.includes(run.id))
  }));
}

export function getChatSession(config: RuntimeConfig, id: string) {
  const state = readState(config.instance);
  const session = state.chatSessions.find((item) => item.id === id);
  if (!session) throw new Error(`Chat session not found: ${id}`);

  const stored = state.chatMessages.filter((message) => message.sessionId === id);
  const tasks = state.tasks.filter((task) => session.taskIds.includes(task.id));

  // Synthesize transient streaming assistant messages: any in-flight task
  // with partialSummary that doesn't yet have a synced assistant message
  // gets a virtual ChatMessageRecord so the chat UI sees text mid-flight.
  // Once the real synced message arrives, this branch is skipped and the
  // synthesized one disappears — the caller never sees both for the same
  // task.
  const syncedAssistantTaskIds = new Set(
    stored.filter((m) => m.role === "assistant" && m.taskId).map((m) => m.taskId as string)
  );
  const synthetic: ChatMessageRecord[] = [];
  for (const task of tasks) {
    if (TERMINAL_TASK_STATUSES.has(task.status)) continue;
    if (!task.partialSummary) continue;
    if (syncedAssistantTaskIds.has(task.id)) continue;
    synthetic.push({
      // Stable id so React's keying stays consistent across polls; switches
      // to the real msg_* id once the task completes and sync runs.
      id: `${task.id}-streaming`,
      instance: state.instance,
      sessionId: id,
      role: "assistant",
      content: task.partialSummary,
      taskId: task.id,
      runId: task.runId,
      createdAt: task.updatedAt
    });
  }

  const messages = synthetic.length === 0
    ? stored
    : [...stored, ...synthetic].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return {
    ...session,
    messages,
    tasks,
    runs: state.runs.filter((run) => session.runIds.includes(run.id)).map((run) => ({
      ...run,
      planSteps: state.planSteps.filter((step) => step.runId === run.id)
    }))
  };
}

export async function createChat(config: RuntimeConfig, input: Record<string, unknown>) {
  return mutateState(config.instance, (state) => createChatSession(state, String(input.title ?? "New chat")));
}

export async function deleteChat(config: RuntimeConfig, id: string) {
  await mutateState(config.instance, (state) => deleteChatSession(state, id));
  return { ok: true };
}

export async function renameChat(config: RuntimeConfig, id: string, input: Record<string, unknown>) {
  const title = String(input.title ?? "");
  return mutateState(config.instance, (state) => renameChatSession(state, id, title));
}

export async function submitChatMessage(config: RuntimeConfig, sessionId: string, input: Record<string, unknown>) {
  const content = String(input.content ?? "").trim();
  if (!content) throw new Error("Chat message content is required.");
  const state = readState(config.instance);
  const session = state.chatSessions.find((item) => item.id === sessionId);
  if (!session) throw new Error(`Chat session not found: ${sessionId}`);
  const run = await createConversationRun(config, { conversationId: sessionId, input: content });
  const task = await submitTask(config, content, undefined, undefined, undefined, run.id);
  await linkRunToTask(config, run.id, task);
  await mutateState(config.instance, (current) => {
    const message = createChatMessage(current, { sessionId, role: "user", content, taskId: task.id, runId: run.id });
    const runRecord = current.runs.find((item) => item.id === run.id);
    if (runRecord) {
      runRecord.userMessageId = message.id;
      runRecord.updatedAt = message.createdAt;
    }
  });
  return { sessionId, runId: run.id, taskId: task.id, status: task.status };
}

export async function syncChatTaskResult(config: RuntimeConfig, sessionId: string, taskId: string) {
  return mutateState(config.instance, (state) => {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const existing = state.chatMessages.find((message) => message.taskId === taskId && message.role === "assistant");
    if (existing) return existing;
    if (task.status !== "completed" && task.status !== "failed" && task.status !== "waiting_approval") {
      throw new Error(`Task is not ready for chat sync: ${task.status}`);
    }
    const content = task.status === "completed"
      ? task.summary ?? "Task completed."
      : task.error ?? task.currentStep ?? `Task is ${task.status}.`;
    const message = createChatMessage(state, { sessionId, role: "assistant", content, taskId, runId: task.runId });
    if (task.runId) {
      const run = state.runs.find((item) => item.id === task.runId);
      if (run) {
        run.assistantMessageId = message.id;
        run.updatedAt = message.createdAt;
      }
    }
    return message;
  });
}
