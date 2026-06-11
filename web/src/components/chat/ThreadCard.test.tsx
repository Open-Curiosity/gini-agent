/// <reference lib="dom" />

// ThreadCard tests. Pins the card's contract:
//   - the WHOLE card is one button and clicking it opens the thread (no
//     inline expansion, no dead zones — same interaction as the chat chip)
//   - the Running pill renders exactly while `thread.active`
//   - New badge follows `isUnread`
//   - root/last-reply previews attribute their authors correctly

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
    active: false,
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

  test("renders agent chip, root author and previews", () => {
    render(<ThreadCard thread={makeThread()} isUnread={false} onOpen={() => {}} />);
    expect(screen.getByText("Gini")).not.toBeNull();
    // Root author is the human for an agent-started thread.
    expect(screen.getByText("You")).not.toBeNull();
    expect(screen.getByText("Investigate the flaky deploy")).not.toBeNull();
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
    // Root author line shows the agent name; reply line shows "You:".
    expect(screen.getAllByText("Gini")).not.toHaveLength(0);
    expect(screen.getByText("You:")).not.toBeNull();
    expect(screen.getByText("1 reply")).not.toBeNull();
  });

  test("shows the Running pill only while the thread is active", () => {
    const { rerender } = render(
      <ThreadCard thread={makeThread({ active: true })} isUnread={false} onOpen={() => {}} />
    );
    expect(screen.getByText("Running")).not.toBeNull();
    rerender(<ThreadCard thread={makeThread({ active: false })} isUnread={false} onOpen={() => {}} />);
    expect(screen.queryByText("Running")).toBeNull();
    // An older runtime that doesn't emit the flag renders no pill either.
    rerender(<ThreadCard thread={makeThread({ active: undefined })} isUnread={false} onOpen={() => {}} />);
    expect(screen.queryByText("Running")).toBeNull();
  });

  test("shows the New badge only when unread", () => {
    const { rerender } = render(<ThreadCard thread={makeThread()} isUnread={true} onOpen={() => {}} />);
    expect(screen.getByText("New")).not.toBeNull();
    rerender(<ThreadCard thread={makeThread()} isUnread={false} onOpen={() => {}} />);
    expect(screen.queryByText("New")).toBeNull();
  });

  test("hides the last-reply line when the thread has no replies yet", () => {
    render(
      <ThreadCard
        thread={makeThread({ replyCount: 0, lastReplyPreview: undefined, lastReplyAuthor: undefined })}
        isUnread={false}
        onOpen={() => {}}
      />
    );
    expect(screen.queryByText(/Gini:/)).toBeNull();
    expect(screen.getByText("0 replies")).not.toBeNull();
  });

  test("falls back to the last reply, then 'Thread', when there is no root preview", () => {
    const { rerender } = render(
      <ThreadCard
        thread={makeThread({ rootPreview: undefined })}
        isUnread={false}
        onOpen={() => {}}
      />
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
    expect(screen.getByText("Thread")).not.toBeNull();
    expect(screen.getByLabelText("Open thread: Thread")).not.toBeNull();
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
    // Falls back to the generic agent label for chip + root author.
    expect(screen.getAllByText("Agent")).not.toHaveLength(0);
    expect(screen.queryByText(/Last reply/)).toBeNull();
  });
});
