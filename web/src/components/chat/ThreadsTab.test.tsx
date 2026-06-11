/// <reference lib="dom" />

// ThreadsTab tests. Pins the per-agent tab's contract:
//   - rows render in-flight-first, then newest-reply-first, as full-card
//     buttons
//   - clicking a row hands the thread summary to onOpen (the chat page opens
//     the side panel with it — the same flow as the in-chat thread chip)
//   - threads missing agentName inherit the tab's agent
//   - the empty state names the agent

import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ThreadSummary } from "@/lib/view-types";
import { ThreadsTab, aggregateActivity, sortThreads } from "./ThreadsTab";

function makeThread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    threadId: "thread_1",
    sessionId: "chat_1",
    rootPreview: "Root message",
    rootAuthor: "agent",
    replyCount: 2,
    lastReplyAt: "2026-06-01T10:00:00.000Z",
    lastReplyPreview: "Latest reply",
    lastReplyAuthor: "agent",
    ...overrides
  };
}

describe("ThreadsTab", () => {
  test("shows the agent-aware empty state when there are no threads", () => {
    render(<ThreadsTab threads={[]} agentName="Gini" onOpen={() => {}} />);
    expect(screen.getByText("No threads yet")).not.toBeNull();
    expect(screen.getByText(/Replies to Gini's messages branch into threads here/)).not.toBeNull();
  });

  test("renders threads newest-reply-first and opens the clicked one", () => {
    const older = makeThread({
      threadId: "thread_old",
      rootPreview: "Older thread",
      lastReplyAt: "2026-06-01T10:00:00.000Z"
    });
    const newer = makeThread({
      threadId: "thread_new",
      rootPreview: "Newer thread",
      lastReplyAt: "2026-06-02T10:00:00.000Z"
    });
    const opened: ThreadSummary[] = [];
    render(<ThreadsTab threads={[older, newer]} agentName="Gini" onOpen={(t) => opened.push(t)} />);

    const cards = screen.getAllByRole("button");
    expect(cards).toHaveLength(2);
    // Read-state (unread suffix) is per-device localStorage and may be seeded
    // by earlier tests in this file — pin the order, not the unread flag.
    expect(cards[0]!.getAttribute("aria-label")).toContain("Open thread: Newer thread (2 replies");
    expect(cards[1]!.getAttribute("aria-label")).toContain("Open thread: Older thread (2 replies");

    fireEvent.click(cards[1]!);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.threadId).toBe("thread_old");
  });

  test("threads with a run in flight sort ahead of newer idle threads", () => {
    const idleNewest = makeThread({
      threadId: "thread_idle",
      rootPreview: "Idle newest",
      lastReplyAt: "2026-06-03T10:00:00.000Z"
    });
    const runningOld = makeThread({
      threadId: "thread_running",
      rootPreview: "Running but old",
      lastReplyAt: "2026-06-01T10:00:00.000Z",
      activity: "running"
    });
    const waitingOlder = makeThread({
      threadId: "thread_waiting",
      rootPreview: "Waiting and older",
      lastReplyAt: "2026-05-30T10:00:00.000Z",
      activity: "waiting_approval"
    });
    // The actionable state outranks running; both outrank newer idle threads.
    expect(sortThreads([idleNewest, runningOld, waitingOlder]).map((t) => t.threadId)).toEqual([
      "thread_waiting",
      "thread_running",
      "thread_idle"
    ]);

    render(
      <ThreadsTab threads={[idleNewest, runningOld]} agentName="Gini" onOpen={() => {}} />
    );
    const cards = screen.getAllByRole("button");
    expect(cards[0]!.getAttribute("aria-label")).toContain("Running but old");
    expect(cards[1]!.getAttribute("aria-label")).toContain("Idle newest");
  });

  test("aggregateActivity reports the highest-priority in-flight state", () => {
    const idle = makeThread({ threadId: "t_idle" });
    const running = makeThread({ threadId: "t_running", activity: "running" });
    const waiting = makeThread({ threadId: "t_waiting", activity: "waiting_approval" });
    expect(aggregateActivity([])).toBeUndefined();
    expect(aggregateActivity([idle])).toBeUndefined();
    expect(aggregateActivity([idle, running])).toBe("running");
    // The actionable state wins regardless of position.
    expect(aggregateActivity([running, idle, waiting])).toBe("waiting_approval");
    expect(aggregateActivity([waiting, running])).toBe("waiting_approval");
  });

  test("threads without an agentName inherit the tab's agent", () => {
    render(
      <ThreadsTab
        threads={[makeThread({ agentName: undefined, rootAuthor: "agent" })]}
        agentName="Testing"
        onOpen={() => {}}
      />
    );
    // Chip and root author both resolve to the inherited name.
    expect(screen.getAllByText("Testing")).not.toHaveLength(0);
  });

  test("a thread's own agentName wins over the inherited one", () => {
    render(
      <ThreadsTab
        threads={[makeThread({ agentName: "Specialist" })]}
        agentName="Gini"
        onOpen={() => {}}
      />
    );
    expect(screen.getAllByText("Specialist")).not.toHaveLength(0);
  });
});
