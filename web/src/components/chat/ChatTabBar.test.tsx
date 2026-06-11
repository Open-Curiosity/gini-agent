/// <reference lib="dom" />

// ChatTabBar tests. Pins the tab strip's contract:
//   - tab visibility flags (Jobs on channels, Settings on pinned sessions)
//   - count pills hide at zero and carry an accessible label
//   - the Threads tab dots green while a thread runs, amber while one waits
//     on the user, with screen-reader text for both
//   - clicking a tab reports its id

import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ChatTab } from "./ChatTabBar";
import { ChatTabBar } from "./ChatTabBar";

describe("ChatTabBar", () => {
  test("renders all tabs and reports clicks", () => {
    const changes: ChatTab[] = [];
    render(<ChatTabBar active="messages" onChange={(t) => changes.push(t)} />);
    for (const label of ["Messages", "Threads", "Jobs", "Settings"]) {
      expect(screen.getByText(label)).not.toBeNull();
    }
    fireEvent.click(screen.getByText("Threads"));
    expect(changes).toEqual(["threads"]);
  });

  test("hides Jobs on channels and Settings on pinned sessions", () => {
    render(<ChatTabBar active="messages" onChange={() => {}} hideJobsTab hideSettingsTab />);
    expect(screen.queryByText("Jobs")).toBeNull();
    expect(screen.queryByText("Settings")).toBeNull();
    expect(screen.getByText("Messages")).not.toBeNull();
  });

  test("shows count pills only when non-zero, with screen-reader context on Threads", () => {
    const { rerender } = render(
      <ChatTabBar active="messages" onChange={() => {}} threadCount={3} jobCount={2} />
    );
    // The Threads pill carries sr-only context, so its full text is the
    // labelled form; the Jobs pill is just the number.
    expect(screen.getByText(/unread threads/)).not.toBeNull();
    expect(screen.getByText("2")).not.toBeNull();
    rerender(<ChatTabBar active="messages" onChange={() => {}} threadCount={0} jobCount={0} />);
    expect(screen.queryByText(/unread threads/)).toBeNull();
    expect(screen.queryByText("2")).toBeNull();
  });

  test("dots the Threads tab while a thread runs, announcing it to screen readers", () => {
    const { rerender } = render(
      <ChatTabBar active="messages" onChange={() => {}} threadsActivity="running" threadCount={1} />
    );
    expect(screen.getByText("a thread is running")).not.toBeNull();
    rerender(<ChatTabBar active="messages" onChange={() => {}} />);
    expect(screen.queryByText("a thread is running")).toBeNull();
  });

  test("shows the amber waiting state while a thread run is parked on the user", () => {
    render(<ChatTabBar active="messages" onChange={() => {}} threadsActivity="waiting_approval" />);
    expect(screen.getByText("a thread needs approval")).not.toBeNull();
    expect(screen.queryByText("a thread is running")).toBeNull();
  });
});
