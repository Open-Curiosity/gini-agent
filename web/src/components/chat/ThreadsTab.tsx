"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import type { ThreadSummary } from "@/lib/view-types";
import { useThreadReadState } from "@/lib/use-chat-read-state";
import { ThreadCard } from "./ThreadCard";

// Shared thread ordering for the per-agent tab and the global inbox:
// threads with a run in flight first, newest reply first within each group.
export function sortThreads(threads: ThreadSummary[]): ThreadSummary[] {
  return [...threads].sort((a, b) => {
    const inFlight = Number(Boolean(b.activity)) - Number(Boolean(a.activity));
    if (inFlight !== 0) return inFlight;
    return b.lastReplyAt.localeCompare(a.lastReplyAt);
  });
}

// Per-agent Threads tab. Lists this agent's threads as Thread Cards —
// in-flight threads first (their last text reply can be old while tools
// churn, and the thing most worth watching shouldn't sink), newest reply
// first within each group. Clicking a card opens the side panel. Read-state
// drives the NEW badge — same per-thread localStorage store as the global
// inbox.
export function ThreadsTab({
  threads,
  agentName,
  onOpen
}: {
  threads: ThreadSummary[];
  agentName: string;
  onOpen: (thread: ThreadSummary) => void;
}) {
  const { isThreadUnread } = useThreadReadState(threads);
  const ordered = sortThreads(threads);

  if (ordered.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-10 text-center">
        <p className="text-[15px] font-semibold text-foreground">No threads yet</p>
        <p className="text-sm text-muted-foreground">
          Replies to {agentName}&apos;s messages branch into threads here.
        </p>
      </div>
    );
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <ul>
        {ordered.map((thread) => (
          <li key={thread.threadId}>
            <ThreadCard
              thread={{ ...thread, agentName: thread.agentName ?? agentName }}
              isUnread={isThreadUnread(thread)}
              onOpen={() => onOpen(thread)}
            />
          </li>
        ))}
      </ul>
    </ScrollArea>
  );
}
