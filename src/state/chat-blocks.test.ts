// Unit tests for the chat block persistence layer.
//
// Pins:
//   - ordinal allocation is per-session and monotonically increasing
//   - inserts and upserts fire the subscriber AFTER the SQLite commit
//   - assistant_text upserts replace text without changing ordinal
//   - tool_call upserts look up by callId + session and flip status
//   - listChatBlocksAfter respects the cursor, falls back to full list
//     when the cursor is unknown
//   - delete cascade clears the rows
//   - subscribers are isolated per (instance, sessionId)

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  closeAllMemoryDbs,
  deleteChatBlocksForSession,
  getMemoryDb,
  insertChatBlock,
  listChatBlocks,
  listChatBlocksAfter,
  subscribeChatBlocks,
  updateToolCallBlock,
  upsertAssistantTextBlock
} from "./index";
import type { ChatBlock } from "../types";

const ROOT = "/tmp/gini-chat-blocks-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  closeAllMemoryDbs();
  rmSync(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  // Each test uses its own instance name, but defensively reset the
  // module-level emitter listeners by closing the DB so nothing
  // accumulates across describe blocks if a previous failure left a
  // subscriber attached.
  closeAllMemoryDbs();
});

describe("chat-blocks persistence", () => {
  test("allocates ordinals per session in monotonic order", () => {
    const instance = "chat-blocks-ordinals";
    // Insert two blocks in session A and one in session B, interleaved.
    const a1 = insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_a",
      text: "hello"
    });
    const b1 = insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_b",
      text: "ello"
    });
    const a2 = insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: "chat_a",
      text: "Hi",
      streaming: true
    });
    const a3 = insertChatBlock(instance, {
      kind: "phase",
      sessionId: "chat_a",
      label: "Working: file_read"
    });

    expect(a1.ordinal).toBe(1);
    expect(a2.ordinal).toBe(2);
    expect(a3.ordinal).toBe(3);
    // Session B's ordinal stream is independent — also starts at 1.
    expect(b1.ordinal).toBe(1);

    const listed = listChatBlocks(instance, "chat_a");
    expect(listed.map((b) => b.ordinal)).toEqual([1, 2, 3]);
    expect(listed.map((b) => b.kind)).toEqual(["user_text", "assistant_text", "phase"]);
  });

  test("upsertAssistantTextBlock updates text without re-allocating ordinal", () => {
    const instance = "chat-blocks-assistant";
    const initial = insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: "chat_x",
      text: "Hi",
      streaming: true
    });
    const after = insertChatBlock(instance, {
      kind: "phase",
      sessionId: "chat_x",
      label: "Completed"
    });
    expect(after.ordinal).toBe(2);

    const updated = upsertAssistantTextBlock(instance, initial.id, {
      text: "Hi there",
      streaming: true
    });
    expect(updated?.kind).toBe("assistant_text");
    if (updated?.kind === "assistant_text") {
      expect(updated.text).toBe("Hi there");
      expect(updated.streaming).toBe(true);
      expect(updated.ordinal).toBe(1);
    }

    // Final flip to streaming=false. Ordinal still pinned.
    const finalized = upsertAssistantTextBlock(instance, initial.id, {
      text: "Hi there, friend",
      streaming: false
    });
    expect(finalized?.kind).toBe("assistant_text");
    if (finalized?.kind === "assistant_text") {
      expect(finalized.text).toBe("Hi there, friend");
      expect(finalized.streaming).toBe(false);
      expect(finalized.ordinal).toBe(1);
    }
    // The phase block stays at ordinal 2 — order is preserved across the
    // upserts so a reconnecting client still sees text streaming before
    // the phase that followed.
    const listed = listChatBlocks(instance, "chat_x");
    expect(listed[0]?.ordinal).toBe(1);
    expect(listed[0]?.kind).toBe("assistant_text");
    expect(listed[1]?.ordinal).toBe(2);
    expect(listed[1]?.kind).toBe("phase");
  });

  test("updateToolCallBlock flips status by callId within session", () => {
    const instance = "chat-blocks-toolcall";
    insertChatBlock(instance, {
      kind: "tool_call",
      sessionId: "chat_t",
      toolName: "file_read",
      displayLabel: "Read file",
      argsPreview: "hello.md",
      argsFull: { path: "hello.md" },
      status: "running",
      callId: "call_1"
    });
    // Parallel fan-out — two distinct callIds.
    insertChatBlock(instance, {
      kind: "tool_call",
      sessionId: "chat_t",
      toolName: "file_list",
      displayLabel: "List files",
      argsPreview: ".",
      argsFull: { path: "." },
      status: "running",
      callId: "call_2"
    });

    const ok = updateToolCallBlock(instance, "call_1", "chat_t", { status: "ok" });
    expect(ok?.kind).toBe("tool_call");
    if (ok?.kind === "tool_call") expect(ok.status).toBe("ok");

    // Other call left untouched.
    const listed = listChatBlocks(instance, "chat_t");
    const call2 = listed.find(
      (b): b is ChatBlock & { kind: "tool_call" } =>
        b.kind === "tool_call" && b.callId === "call_2"
    );
    expect(call2?.status).toBe("running");

    // Error path stamps message.
    const err = updateToolCallBlock(instance, "call_2", "chat_t", {
      status: "error",
      errorMessage: "boom"
    });
    expect(err?.kind).toBe("tool_call");
    if (err?.kind === "tool_call") {
      expect(err.status).toBe("error");
      expect(err.errorMessage).toBe("boom");
    }
  });

  test("listChatBlocksAfter honors cursor and falls back when unknown", () => {
    const instance = "chat-blocks-cursor";
    const a = insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_c",
      text: "hi"
    });
    const b = insertChatBlock(instance, {
      kind: "phase",
      sessionId: "chat_c",
      label: "Thinking"
    });
    const c = insertChatBlock(instance, {
      kind: "system_note",
      sessionId: "chat_c",
      text: "tick"
    });

    const afterA = listChatBlocksAfter(instance, "chat_c", a.id);
    expect(afterA.map((row) => row.id)).toEqual([b.id, c.id]);

    const afterC = listChatBlocksAfter(instance, "chat_c", c.id);
    expect(afterC).toHaveLength(0);

    // Unknown cursor: best-effort fall back to the full session list.
    const afterUnknown = listChatBlocksAfter(instance, "chat_c", "block_does_not_exist");
    expect(afterUnknown.map((row) => row.id)).toEqual([a.id, b.id, c.id]);

    // Null cursor (initial subscribe): equivalent to listChatBlocks.
    const afterNull = listChatBlocksAfter(instance, "chat_c", null);
    expect(afterNull.map((row) => row.id)).toEqual([a.id, b.id, c.id]);
  });

  test("listChatBlocksAfter replays in-place updates after the cursor", async () => {
    // A reconnecting client carries a Last-Event-ID equal to the most
    // recent block it observed. The resume query compares each row's
    // current updated_at against the cursor row's current updated_at,
    // and includes any other row whose updated_at moved forward later.
    // This lets upsert-style mutations (assistant_text deltas, tool_call
    // status flips) on earlier-ordinal blocks replay on reconnect.
    //
    // The cursor row itself is excluded via `id <> ?`; clients already
    // hold its most recent state in their local cache.
    const instance = "chat-blocks-resume-upserts";
    const stream = insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: "chat_r",
      text: "Hi",
      streaming: true
    });
    const call = insertChatBlock(instance, {
      kind: "tool_call",
      sessionId: "chat_r",
      toolName: "file_read",
      displayLabel: "Read file",
      argsPreview: "x.md",
      argsFull: { path: "x.md" },
      status: "running",
      callId: "call_resume"
    });
    const phase = insertChatBlock(instance, {
      kind: "phase",
      sessionId: "chat_r",
      label: "Working: file_read"
    });

    // Client disconnects holding cursor = stream.id. It has Hi/running.
    // Sleep so subsequent now() calls produce later ISO timestamps.
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Tool_call flips to ok in place; the cursor row is untouched, so
    // its updated_at stays older than this upsert's.
    updateToolCallBlock(instance, "call_resume", "chat_r", { status: "ok" });

    // Resume from cursor=stream.id: ordinal-only filter would only see
    // the phase block. With the updated_at fan-in, the in-place tool_call
    // flip also replays.
    const replay = listChatBlocksAfter(instance, "chat_r", stream.id);
    const replayedIds = replay.map((row) => row.id).sort();
    expect(replayedIds).toEqual([call.id, phase.id].sort());

    const replayedCall = replay.find((row) => row.id === call.id);
    if (replayedCall?.kind === "tool_call") {
      expect(replayedCall.status).toBe("ok");
    }

    // Cursor block is excluded even though its updated_at is, by
    // definition, not greater than itself.
    expect(replay.map((row) => row.id)).not.toContain(stream.id);

    // Same shape for assistant_text deltas to an earlier-ordinal block.
    await new Promise((resolve) => setTimeout(resolve, 5));
    upsertAssistantTextBlock(instance, stream.id, {
      text: "Hi there",
      streaming: false
    });
    // New cursor = phase.id (latest ordinal). Earlier-ordinal blocks
    // with newer updated_at must replay — both the assistant_text upsert
    // we just did and the still-newer tool_call ok flip from earlier.
    const replay2 = listChatBlocksAfter(instance, "chat_r", phase.id);
    const ids2 = replay2.map((row) => row.id).sort();
    expect(ids2).toEqual([stream.id, call.id].sort());
    const text = replay2.find((row) => row.id === stream.id);
    if (text?.kind === "assistant_text") {
      expect(text.text).toBe("Hi there");
      expect(text.streaming).toBe(false);
    }
  });

  test("subscribers fire on insert and upsert, then stop after unsubscribe", () => {
    const instance = "chat-blocks-subscribe";
    const events: ChatBlock[] = [];
    const unsubscribe = subscribeChatBlocks(instance, "chat_sub", (block) => {
      events.push(block);
    });

    const first = insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_sub",
      text: "first"
    });
    const stream = insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: "chat_sub",
      text: "",
      streaming: true
    });
    upsertAssistantTextBlock(instance, stream.id, { text: "ok", streaming: true });
    upsertAssistantTextBlock(instance, stream.id, { text: "ok!", streaming: false });

    expect(events).toHaveLength(4);
    expect(events[0]?.id).toBe(first.id);
    expect(events[1]?.kind).toBe("assistant_text");
    expect(events[2]?.kind).toBe("assistant_text");
    if (events[2]?.kind === "assistant_text") expect(events[2].text).toBe("ok");
    if (events[3]?.kind === "assistant_text") {
      expect(events[3].text).toBe("ok!");
      expect(events[3].streaming).toBe(false);
    }

    unsubscribe();
    insertChatBlock(instance, {
      kind: "system_note",
      sessionId: "chat_sub",
      text: "after unsubscribe"
    });
    expect(events).toHaveLength(4);
  });

  test("subscribers are isolated per (instance, sessionId)", () => {
    const instance = "chat-blocks-isolation";
    const aEvents: ChatBlock[] = [];
    const bEvents: ChatBlock[] = [];
    const unsubA = subscribeChatBlocks(instance, "chat_a", (block) => aEvents.push(block));
    const unsubB = subscribeChatBlocks(instance, "chat_b", (block) => bEvents.push(block));

    insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_a",
      text: "a"
    });
    insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_b",
      text: "b"
    });

    expect(aEvents).toHaveLength(1);
    expect(bEvents).toHaveLength(1);
    if (aEvents[0]?.kind === "user_text") expect(aEvents[0].text).toBe("a");
    if (bEvents[0]?.kind === "user_text") expect(bEvents[0].text).toBe("b");

    unsubA();
    unsubB();
  });

  test("deleteChatBlocksForSession removes only that session's rows", () => {
    const instance = "chat-blocks-delete";
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_d1", text: "1" });
    insertChatBlock(instance, { kind: "phase", sessionId: "chat_d1", label: "x" });
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_d2", text: "2" });

    expect(deleteChatBlocksForSession(instance, "chat_d1")).toBe(2);
    expect(listChatBlocks(instance, "chat_d1")).toHaveLength(0);
    expect(listChatBlocks(instance, "chat_d2")).toHaveLength(1);

    // Idempotent: second delete returns zero, listChatBlocks still empty.
    expect(deleteChatBlocksForSession(instance, "chat_d1")).toBe(0);
  });

  test("rows persist taskId, runId, and agentId for indexable joins", () => {
    const instance = "chat-blocks-metadata";
    insertChatBlock(instance, {
      kind: "tool_call",
      sessionId: "chat_meta",
      toolName: "file_read",
      displayLabel: "Read file",
      argsPreview: "hello.md",
      argsFull: { path: "hello.md" },
      status: "running",
      callId: "call_meta",
      taskId: "task_meta",
      runId: "run_meta",
      agentId: "agent_meta"
    });

    // Verify the columns are persisted (we expose them via the
    // re-assembled block + the agent_id column directly on the row).
    const block = listChatBlocks(instance, "chat_meta")[0];
    expect(block?.taskId).toBe("task_meta");
    expect(block?.runId).toBe("run_meta");

    const db = getMemoryDb(instance);
    const row = db
      .query<{ agent_id: string | null; task_id: string | null; run_id: string | null }, [string]>(
        "SELECT agent_id, task_id, run_id FROM chat_blocks WHERE id = ?"
      )
      .get(block!.id);
    expect(row?.agent_id).toBe("agent_meta");
    expect(row?.task_id).toBe("task_meta");
    expect(row?.run_id).toBe("run_meta");
  });
});
