// Integration tests for per-turn thread membership.
//
// Thread membership is fixed when a task is spawned: a task pre-seeded with
// threadId/parentBlockId (the thread-reply endpoint) threads its whole
// response, and a main-chat task answers in the main timeline. There is no
// agent-decided re-route — a message sent from the main composer must never
// be answered inside a thread (issue #280), so neither a `start_thread` tool
// call nor a leading `<route>thread</route> ` directive may move the turn.
//
// We drive real turns through submitChatMessage with the echo provider's
// stubbed tool-calling responses so the loop is fully deterministic.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearEchoToolCallingResponses,
  normalizeProvider,
  setEchoToolCallingResponse
} from "../provider";
import {
  createTask,
  listChatBlocks,
  mutateState,
  readState,
  upsertTask
} from "../state";
import { listMainChatBlocks } from "../state/chat-blocks";
import type { RuntimeConfig, Task } from "../types";
import { createChat, submitChatMessage } from "./chat";
import { runChatTask } from "./chat-task";

function buildConfig(workspaceRoot: string, instance: string): RuntimeConfig {
  return {
    instance,
    port: 7339,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: process.env.GINI_STATE_ROOT ?? "/tmp/gini-chat-route-test",
    logRoot: process.env.GINI_LOG_ROOT ?? "/tmp/gini-chat-route-test-logs"
  };
}

async function waitForTerminal(config: RuntimeConfig, taskId: string, timeoutMs = 5000): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = readState(config.instance).tasks.find((t) => t.id === taskId);
    if (
      task &&
      (task.status === "completed" ||
        task.status === "failed" ||
        task.status === "cancelled" ||
        task.status === "waiting_approval")
    ) {
      return task;
    }
    await Bun.sleep(20);
  }
  throw new Error(`Task ${taskId} did not reach terminal state within ${timeoutMs}ms`);
}

describe("chat-task thread membership", () => {
  let root: string;
  let workspaceRoot: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-chat-route-"));
    workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-route-ws-"));
    prevState = process.env.GINI_STATE_ROOT;
    prevLog = process.env.GINI_LOG_ROOT;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
    clearEchoToolCallingResponses();
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = prevLog;
    rmSync(root, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
    clearEchoToolCallingResponses();
  });

  // Runs a first main-chat turn so a prior assistant_text block exists — the
  // block an agent-initiated re-route would have branched a thread from —
  // then returns the session id + that block's id.
  async function seedFirstTurn(
    config: RuntimeConfig,
    provider: ReturnType<typeof normalizeProvider>
  ): Promise<{ sessionId: string; parentBlockId: string }> {
    setEchoToolCallingResponse({
      provider,
      text: "First main-chat answer.",
      toolCalls: [],
      finishReason: "stop"
    });
    const session = await createChat(config, { title: "route-test" });
    const first = await submitChatMessage(config, session.id, { content: "hello" });
    await waitForTerminal(config, first.taskId);
    const main = listMainChatBlocks(config.instance, session.id);
    const lastAssistant = [...main].reverse().find((b) => b.kind === "assistant_text");
    expect(lastAssistant).toBeDefined();
    return { sessionId: session.id, parentBlockId: lastAssistant!.id };
  }

  test("a main-composer turn answers in the main chat", async () => {
    const config = buildConfig(workspaceRoot, "chat-route-main");
    const provider = normalizeProvider(config.provider);
    const { sessionId } = await seedFirstTurn(config, provider);

    setEchoToolCallingResponse({
      provider,
      text: "Plain main-chat reply.",
      toolCalls: [],
      finishReason: "stop"
    });
    const second = await submitChatMessage(config, sessionId, { content: "and?" });
    const finished = await waitForTerminal(config, second.taskId);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Plain main-chat reply.");
    expect(finished.threadId).toBeUndefined();

    const blocks = listChatBlocks(config.instance, sessionId)
      .filter((b) => b.kind === "assistant_text" && b.taskId === second.taskId);
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.threadId).toBeUndefined();
    // The answer is visible in the main timeline.
    const mainAfter = listMainChatBlocks(config.instance, sessionId);
    expect(mainAfter.some((b) => b.kind === "assistant_text" && b.taskId === second.taskId)).toBe(true);
  });

  test("a leading <route>thread</route> directive no longer threads the turn", async () => {
    const config = buildConfig(workspaceRoot, "chat-route-directive");
    const provider = normalizeProvider(config.provider);
    const { sessionId } = await seedFirstTurn(config, provider);

    setEchoToolCallingResponse({
      provider,
      text: "<route>thread</route>Answer after a stale directive.",
      toolCalls: [],
      finishReason: "stop"
    });
    const second = await submitChatMessage(config, sessionId, { content: "research this" });
    const finished = await waitForTerminal(config, second.taskId);

    // The directive grammar is gone: the text passes through verbatim (no
    // model is instructed to emit it anymore) and the turn stays unthreaded.
    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("<route>thread</route>Answer after a stale directive.");
    expect(finished.threadId).toBeUndefined();

    const turnBlocks = listChatBlocks(config.instance, sessionId).filter((b) => b.taskId === second.taskId);
    expect(turnBlocks.length).toBeGreaterThan(0);
    for (const b of turnBlocks) {
      expect(b.threadId).toBeUndefined();
    }
    const mainAfter = listMainChatBlocks(config.instance, sessionId);
    expect(mainAfter.some((b) => b.kind === "assistant_text" && b.taskId === second.taskId)).toBe(true);
  });

  test("a model calling the removed start_thread tool cannot move the turn out of the main chat", async () => {
    const config = buildConfig(workspaceRoot, "chat-route-startthread");
    const provider = normalizeProvider(config.provider);
    const { sessionId } = await seedFirstTurn(config, provider);

    // The model's first action is a start_thread call — the exact shape that
    // used to divert the whole reply into a freshly minted thread (issue
    // #280). The tool no longer exists, so the call resolves like any other
    // unknown tool and the turn continues in the main chat.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_start", type: "function", function: { name: "start_thread", arguments: JSON.stringify({ topic: "app names" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Here are 5 names to start.",
      toolCalls: [],
      finishReason: "stop"
    });

    const second = await submitChatMessage(config, sessionId, { content: "brainstorm app names" });
    const finished = await waitForTerminal(config, second.taskId);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Here are 5 names to start.");
    expect(finished.threadId).toBeUndefined();
    expect(finished.parentBlockId).toBeUndefined();

    // Every block of the turn stays in the main timeline.
    const turnBlocks = listChatBlocks(config.instance, sessionId).filter((b) => b.taskId === second.taskId);
    expect(turnBlocks.length).toBeGreaterThan(0);
    for (const b of turnBlocks) {
      expect(b.threadId).toBeUndefined();
    }
    const mainAfter = listMainChatBlocks(config.instance, sessionId);
    expect(mainAfter.some((b) => b.kind === "assistant_text" && b.taskId === second.taskId)).toBe(true);
  });

  test("a task pre-seeded with task.threadId threads its whole response", async () => {
    const config = buildConfig(workspaceRoot, "chat-route-preseed");
    const provider = normalizeProvider(config.provider);
    const { sessionId, parentBlockId } = await seedFirstTurn(config, provider);

    setEchoToolCallingResponse({
      provider,
      text: "Replying inside the existing thread.",
      toolCalls: [],
      finishReason: "stop"
    });

    // Build the task with the thread fields already set (mirrors how the
    // thread-reply endpoint spawns it) and run it directly so the loop
    // resolves its emit context from the pre-seeded fields with no race.
    const seededThreadId = "thread_preseed";
    const task = createTask(config.instance, "thread reply", undefined, undefined, undefined, undefined, undefined, sessionId);
    task.mode = "chat";
    task.threadId = seededThreadId;
    task.parentBlockId = parentBlockId;
    await mutateState(config.instance, (state) => {
      upsertTask(state, task);
    });
    const finished = await runChatTask(config, task.id);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Replying inside the existing thread.");

    const blocks = listChatBlocks(config.instance, sessionId)
      .filter((b) => b.kind === "assistant_text" && b.taskId === task.id);
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.threadId).toBe(seededThreadId);
    expect(blocks[0]!.parentBlockId).toBe(parentBlockId);
  });
});
