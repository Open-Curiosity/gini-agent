// anyConversationInFlight() — the poll-while-active gate for useChatBlocks.
//
// The flat session block list interleaves thread blocks in the same ordinal
// stream, so a single tail-scan over the whole list conflates conversations:
// a thread's terminal phase landing last would mask a still-running main
// turn. These tests pin that each conversation slice is evaluated
// independently and OR'd, so a non-terminal tail in EITHER the main chat or
// any thread keeps the recovery poll alive.

import { describe, expect, test } from "bun:test";
import type { ChatBlock, PhaseBlock } from "@runtime/types";
import { anyConversationInFlight } from "./queries";

function phaseBlock(
  id: string,
  ordinal: number,
  label: string,
  opts: { taskId?: string; threadId?: string } = {}
): PhaseBlock {
  return {
    id,
    sessionId: "s1",
    instance: "test",
    ordinal,
    createdAt: "2026-05-28T00:00:00.000Z",
    kind: "phase",
    label,
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
    ...(opts.threadId ? { threadId: opts.threadId } : {})
  };
}

describe("anyConversationInFlight", () => {
  test("main turn in flight even when a thread's terminal phase lands at a higher ordinal", () => {
    // The flat tail is the thread's "Completed"; the main turn is still
    // "Thinking" at a lower ordinal. A naive whole-list tail-scan would
    // return false here — the per-slice check must catch the live main turn.
    const blocks: ChatBlock[] = [
      phaseBlock("m1", 1, "Thinking", { taskId: "task_main" }),
      phaseBlock("t1", 2, "Completed", { taskId: "task_thread", threadId: "thr_1" })
    ];
    expect(anyConversationInFlight(blocks)).toBe(true);
  });

  test("all main and thread phases terminal returns false", () => {
    const blocks: ChatBlock[] = [
      phaseBlock("m1", 1, "Completed", { taskId: "task_main" }),
      phaseBlock("t1", 2, "Completed", { taskId: "task_thread", threadId: "thr_1" })
    ];
    expect(anyConversationInFlight(blocks)).toBe(false);
  });

  test("only a thread turn in flight returns true", () => {
    // Main is quiescent (terminal); the thread's last phase is non-terminal.
    const blocks: ChatBlock[] = [
      phaseBlock("m1", 1, "Completed", { taskId: "task_main" }),
      phaseBlock("t1", 2, "Thinking", { taskId: "task_thread", threadId: "thr_1" })
    ];
    expect(anyConversationInFlight(blocks)).toBe(true);
  });

  test("empty blocks returns false", () => {
    expect(anyConversationInFlight([])).toBe(false);
  });
});
