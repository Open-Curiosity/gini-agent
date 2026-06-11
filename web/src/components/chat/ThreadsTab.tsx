"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import type { ThreadSummary } from "@/lib/view-types";
import { useThreadReadState } from "@/lib/use-chat-read-state";
import { ThreadCard } from "./ThreadCard";

// Shared thread ordering for the per-agent tab and the global inbox:
// runs parked on the user first (the actionable state), then running
// threads, then idle — newest reply first within each group.
const ACTIVITY_RANK: Record<string, number> = { waiting_approval: 2, running: 1 };

export function sortThreads(threads: ThreadSummary[]): ThreadSummary[] {
  return [...threads].sort((a, b) => {
    const rank = (ACTIVITY_RANK[b.activity ?? ""] ?? 0) - (ACTIVITY_RANK[a.activity ?? ""] ?? 0);
    if (rank !== 0) return rank;
    const recency = b.lastReplyAt.localeCompare(a.lastReplyAt);
    // threadId tiebreak keeps same-millisecond threads from swapping
    // between polls.
    return recency !== 0 ? recency : a.threadId.localeCompare(b.threadId);
  });
}

// Highest-priority activity across a thread list, by the SAME ranking the
// sort uses — so the tab-bar dot can never disagree with list ordering.
export function aggregateActivity(
  threads: ThreadSummary[]
): NonNullable<ThreadSummary["activity"]> | undefined {
  let best: NonNullable<ThreadSummary["activity"]> | undefined;
  for (const t of threads) {
    if (t.activity && (ACTIVITY_RANK[t.activity] ?? 0) > (best ? (ACTIVITY_RANK[best] ?? 0) : 0)) {
      best = t.activity;
    }
  }
  return best;
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
