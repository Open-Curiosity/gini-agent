/// <reference lib="dom" />

// ThreadChip tests. Pins the inline chip's contract:
//   - replies state: count + recency + "View thread", click opens the panel
//   - empty state: "Reply in thread" prompt
//   - activity dot mirrors the thread list (green running / amber waiting)
//     with screen-reader text, so the parent message doesn't look idle

import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ThreadSummary } from "@/lib/view-types";
import { ThreadChip } from "./ThreadChip";

function makeThread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    threadId: "thread_1",
    sessionId: "chat_1",
    parentBlockId: "block_1",
    rootPreview: "Root",
    rootAuthor: "agent",
    replyCount: 2,
    lastReplyAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    lastReplyPreview: "Latest",
    lastReplyAuthor: "agent",
    ...overrides
  };
}

describe("ThreadChip", () => {
  test("shows count, recency, and opens the thread on click", () => {
    let opened = 0;
    render(<ThreadChip thread={makeThread()} onOpen={() => opened++} />);
    expect(screen.getByText("2 replies in a thread")).not.toBeNull();
    expect(screen.getByText(/Last reply/)).not.toBeNull();
    expect(screen.getByText("View thread")).not.toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(opened).toBe(1);
  });

  test("singular reply copy and no recency when lastReplyAt is blank", () => {
    render(
      <ThreadChip thread={makeThread({ replyCount: 1, lastReplyAt: "" })} onOpen={() => {}} />
    );
    expect(screen.getByText("1 reply in a thread")).not.toBeNull();
    expect(screen.queryByText(/Last reply/)).toBeNull();
  });

  test("prompts to reply when the thread has no replies yet", () => {
    render(<ThreadChip thread={makeThread({ replyCount: 0 })} onOpen={() => {}} />);
    expect(screen.getByText("Reply in thread")).not.toBeNull();
    expect(screen.queryByText("View thread")).toBeNull();
  });

  test("dots the chip while the thread's run is in flight", () => {
    const { rerender } = render(
      <ThreadChip thread={makeThread({ activity: "running" })} onOpen={() => {}} />
    );
    expect(screen.getByText("running")).not.toBeNull();
    rerender(<ThreadChip thread={makeThread({ activity: "waiting_approval" })} onOpen={() => {}} />);
    expect(screen.getByText("needs approval")).not.toBeNull();
    rerender(<ThreadChip thread={makeThread()} onOpen={() => {}} />);
    expect(screen.queryByText("running")).toBeNull();
    expect(screen.queryByText("needs approval")).toBeNull();
  });
});
