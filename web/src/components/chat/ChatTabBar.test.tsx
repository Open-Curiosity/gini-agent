/// <reference lib="dom" />

// ChatTabBar tests. Pins the tab strip's contract:
//   - tab visibility flags (Jobs on channels, Settings on pinned sessions)
//   - count pills hide at zero
//   - the Threads tab pulses while any thread run is in flight
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

  test("shows count pills only when non-zero", () => {
    const { rerender } = render(
      <ChatTabBar active="messages" onChange={() => {}} threadCount={3} jobCount={2} />
    );
    expect(screen.getByText("3")).not.toBeNull();
    expect(screen.getByText("2")).not.toBeNull();
    rerender(<ChatTabBar active="messages" onChange={() => {}} threadCount={0} jobCount={0} />);
    expect(screen.queryByText("3")).toBeNull();
    expect(screen.queryByText("2")).toBeNull();
  });

  test("pulses the Threads tab while a thread run is in flight", () => {
    const { rerender } = render(
      <ChatTabBar active="messages" onChange={() => {}} threadsActive threadCount={1} />
    );
    expect(screen.getByLabelText("Thread running")).not.toBeNull();
    rerender(<ChatTabBar active="messages" onChange={() => {}} threadsActive={false} />);
    expect(screen.queryByLabelText("Thread running")).toBeNull();
  });
});
