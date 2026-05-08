import { submitTask } from "../agent";
import { createChatMessage, createChatSession, mutateState, readState } from "../state";
import type { RuntimeConfig } from "../types";
import { createConversationRun, linkRunToTask } from "./runs";

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
  return {
    ...session,
    messages: state.chatMessages.filter((message) => message.sessionId === id),
    tasks: state.tasks.filter((task) => session.taskIds.includes(task.id)),
    runs: state.runs.filter((run) => session.runIds.includes(run.id)).map((run) => ({
      ...run,
      planSteps: state.planSteps.filter((step) => step.runId === run.id)
    }))
  };
}

export async function createChat(config: RuntimeConfig, input: Record<string, unknown>) {
  return mutateState(config.instance, (state) => createChatSession(state, String(input.title ?? "New chat")));
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
