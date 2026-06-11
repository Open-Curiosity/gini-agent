/// <reference lib="dom" />

// ThreadCard tests. Pins the card's contract:
//   - the WHOLE card is one button and clicking it opens the thread (no
//     inline expansion, no dead zones — same interaction as the chat chip)
//   - the activity pill renders "Running" / "Needs approval" off
//     thread.activity, and the accessible name carries the same state
//   - New badge follows `isUnread`
//   - root/last-reply previews attribute their authors correctly
//   - 0-reply copy stays honest ("No replies yet", no fake recency)

import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ThreadSummary } from "@/lib/view-types";
import { ThreadCard } from "./ThreadCard";

function makeThread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    threadId: "thread_1",
    sessionId: "chat_1",
    agentId: "agent_1",
    agentName: "Gini",
    parentBlockId: "block_1",
    rootPreview: "Investigate the flaky deploy",
    rootAuthor: "user",
    replyCount: 3,
    lastReplyAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    lastReplyPreview: "Deploy pipeline is green again.",
    lastReplyAuthor: "agent",
    ...overrides
  };
}

describe("ThreadCard", () => {
  test("the whole card is a single button that opens the thread", () => {
    let opened = 0;
    render(<ThreadCard thread={makeThread()} isUnread={false} onOpen={() => opened++} />);
    const buttons = screen.getAllByRole("button");
    // One button covering the card — no separate expand/footer click targets.
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(opened).toBe(1);
  });

  test("renders agent chip, author-prefixed previews, and the footer", () => {
    render(<ThreadCard thread={makeThread()} isUnread={false} onOpen={() => {}} />);
    expect(screen.getByText("Gini")).not.toBeNull();
    // Root author is the human for an agent-started thread, prefixed inline.
    expect(screen.getByText("You:")).not.toBeNull();
    expect(screen.getByText(/Investigate the flaky deploy/)).not.toBeNull();
    // Last reply line attributes the agent.
    expect(screen.getByText("Gini:")).not.toBeNull();
    expect(screen.getByText(/Deploy pipeline is green again/)).not.toBeNull();
    expect(screen.getByText("3 replies")).not.toBeNull();
    expect(screen.getByText(/Last reply/)).not.toBeNull();
    expect(screen.getByText("View thread")).not.toBeNull();
  });

  test("attributes the root to the agent and the last reply to the user", () => {
    render(
      <ThreadCard
        thread={makeThread({ rootAuthor: "agent", lastReplyAuthor: "user", replyCount: 1 })}
        isUnread={false}
        onOpen={() => {}}
      />
    );
    expect(screen.getByText("Gini:")).not.toBeNull();
    expect(screen.getByText("You:")).not.toBeNull();
    expect(screen.getByText("1 reply")).not.toBeNull();
  });

  test("shows the Running pill and announces it while the thread is running", () => {
    const { rerender } = render(
      <ThreadCard thread={makeThread({ activity: "running" })} isUnread={false} onOpen={() => {}} />
    );
    expect(screen.getByText("Running")).not.toBeNull();
    expect(
      screen.getByLabelText(/Open thread: Investigate the flaky deploy \(3 replies, running\)/)
    ).not.toBeNull();
    rerender(<ThreadCard thread={makeThread()} isUnread={false} onOpen={() => {}} />);
    expect(screen.queryByText("Running")).toBeNull();
  });

  test("shows the amber Needs-approval pill while the run is parked on a user gate", () => {
    render(
      <ThreadCard
        thread={makeThread({ activity: "waiting_approval" })}
        isUnread={false}
        onOpen={() => {}}
      />
    );
    expect(screen.getByText("Needs approval")).not.toBeNull();
    expect(screen.queryByText("Running")).toBeNull();
    expect(
      screen.getByLabelText(/Open thread: Investigate the flaky deploy \(3 replies, needs approval\)/)
    ).not.toBeNull();
  });

  test("shows the New badge and carries unread into the accessible name", () => {
    const { rerender } = render(<ThreadCard thread={makeThread()} isUnread={true} onOpen={() => {}} />);
    expect(screen.getByText("New")).not.toBeNull();
    expect(screen.getByLabelText(/\(3 replies, unread\)/)).not.toBeNull();
    rerender(<ThreadCard thread={makeThread()} isUnread={false} onOpen={() => {}} />);
    expect(screen.queryByText("New")).toBeNull();
  });

  test("a thread with no replies says so instead of claiming a last reply", () => {
    render(
      <ThreadCard
        thread={makeThread({ replyCount: 0, lastReplyPreview: undefined, lastReplyAuthor: undefined })}
        isUnread={false}
        onOpen={() => {}}
      />
    );
    expect(screen.getByText("No replies yet")).not.toBeNull();
    // The card still carries a time anchor — the thread's start age — but
    // never a fabricated "Last reply".
    expect(screen.getByText(/Started/)).not.toBeNull();
    expect(screen.queryByText(/Last reply/)).toBeNull();
    expect(screen.queryByText(/0 replies/)).toBeNull();
  });

  test("falls back to the last reply, then 'Thread', when there is no root preview", () => {
    const { rerender } = render(
      <ThreadCard thread={makeThread({ rootPreview: undefined })} isUnread={false} onOpen={() => {}} />
    );
    // The body shows the last-reply text in place of the missing root.
    expect(screen.getAllByText(/Deploy pipeline is green again/)).not.toHaveLength(0);
    rerender(
      <ThreadCard
        thread={makeThread({ rootPreview: undefined, lastReplyPreview: undefined, replyCount: 0 })}
        isUnread={false}
        onOpen={() => {}}
      />
    );
    expect(screen.getByText(/Thread/)).not.toBeNull();
    expect(screen.getByLabelText("Open thread: Thread (0 replies)")).not.toBeNull();
  });

  test("renders without timestamps or agent identity when the summary is minimal", () => {
    render(
      <ThreadCard
        thread={makeThread({
          agentId: undefined,
          agentName: undefined,
          lastReplyAt: "",
          rootAuthor: undefined,
          lastReplyAuthor: undefined
        })}
        isUnread={false}
        onOpen={() => {}}
      />
    );
    // Falls back to the generic agent label for chip + both author prefixes.
    expect(screen.getByText("Agent")).not.toBeNull();
    expect(screen.getAllByText("Agent:")).toHaveLength(2);
    expect(screen.queryByText(/Last reply/)).toBeNull();
  });
});
