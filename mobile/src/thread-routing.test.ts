import { describe, expect, test } from "bun:test";
import type { ChatBlock, ThreadSummary } from "@/src/types";
import {
  blockBelongsToView,
  filterBlocksForView,
  indexThreadsByParentBlock
} from "./thread-routing";

// Minimal assistant_text-shaped block; only the fields the routing
// helpers read (`threadId`) matter, so the rest is cast through unknown.
function block(id: string, threadId?: string): ChatBlock {
  return {
    id,
    sessionId: "s1",
    kind: "assistant_text",
    text: id,
    streaming: false,
    ...(threadId ? { threadId } : {})
  } as unknown as ChatBlock;
}

describe("blockBelongsToView", () => {
  test("main chat keeps only untagged blocks", () => {
    expect(blockBelongsToView(block("a"), null)).toBe(true);
    expect(blockBelongsToView(block("b", "t1"), null)).toBe(false);
  });

  test("thread view keeps only its own thread's blocks", () => {
    expect(blockBelongsToView(block("a", "t1"), "t1")).toBe(true);
    expect(blockBelongsToView(block("b", "t2"), "t1")).toBe(false);
    expect(blockBelongsToView(block("c"), "t1")).toBe(false);
  });
});

describe("filterBlocksForView", () => {
  const blocks = [block("a"), block("b", "t1"), block("c"), block("d", "t2")];

  test("main chat strips all threaded rows", () => {
    expect(filterBlocksForView(blocks, null).map((b) => b.id)).toEqual(["a", "c"]);
  });

  test("thread view keeps only its thread", () => {
    expect(filterBlocksForView(blocks, "t1").map((b) => b.id)).toEqual(["b"]);
  });
});

describe("indexThreadsByParentBlock", () => {
  function summary(threadId: string, parentBlockId?: string): ThreadSummary {
    return { threadId, sessionId: "s1", replyCount: 1, lastReplyAt: "x", parentBlockId };
  }

  test("indexes by parentBlockId and skips summaries without one", () => {
    const map = indexThreadsByParentBlock([
      summary("t1", "blockA"),
      summary("t2"),
      summary("t3", "blockB")
    ]);
    expect(map.get("blockA")?.threadId).toBe("t1");
    expect(map.get("blockB")?.threadId).toBe("t3");
    expect(map.size).toBe(2);
  });
});
