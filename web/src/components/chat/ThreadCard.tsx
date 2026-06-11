"use client";

import { ChevronRight, MessagesSquare } from "lucide-react";
import type { ThreadSummary } from "@/lib/view-types";
import { formatRelativeTime, formatMessageTimestamp } from "./relative-time";
import { agentColor } from "@/lib/agent-visuals";

// Thread Card — one row in the cross-agent Threads inbox and the per-agent
// Threads tab. The WHOLE card is a single button that opens the thread side
// panel, matching the chat surface's thread chip (no inline expansion — the
// panel is the one place replies render). Layout:
//   - meta: "in <agent chip> · <time>" + New badge, with a pulsing "Running"
//     pill on the right while the thread's run is in flight
//   - root: author + parent-message preview (clamped to two lines)
//   - last reply: "<author>: <preview>" one-liner — the freshest context
//   - footer: reply count + last-reply age + a hover-emphasized "View thread →"
export function ThreadCard({
  thread,
  isUnread,
  onOpen
}: {
  thread: ThreadSummary;
  isUnread: boolean;
  onOpen: () => void;
}) {
  const agentName = thread.agentName ?? "Agent";
  const dotColor = agentColor(thread.agentId ?? agentName);
  const lastReply = thread.lastReplyAt ? formatRelativeTime(thread.lastReplyAt) : "";
  const lastReplyAuthor = thread.lastReplyAuthor === "user" ? "You" : agentName;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open thread: ${thread.rootPreview || thread.lastReplyPreview || "Thread"}`}
      className="group flex w-full flex-col gap-2.5 border-b border-border bg-background px-10 py-5 text-left transition-colors hover:bg-accent/50"
    >
      {/* Meta */}
      <div className="flex w-full flex-wrap items-center gap-2 text-[12px]">
        <span className="font-medium text-muted-foreground">in</span>
        <span className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-0.5">
          <span aria-hidden className="size-[7px] rounded-full" style={{ backgroundColor: dotColor }} />
          <span className="font-semibold text-foreground">{agentName}</span>
        </span>
        {thread.lastReplyAt ? (
          <>
            <span className="text-muted-foreground">·</span>
            <span className="font-medium text-muted-foreground">
              {formatMessageTimestamp(thread.lastReplyAt)}
            </span>
          </>
        ) : null}
        {isUnread ? (
          <span className="flex items-center justify-center rounded-lg bg-primary px-1.5 py-px text-[10px] font-bold text-primary-foreground">
            New
          </span>
        ) : null}
        {thread.active ? (
          <span className="ml-auto flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
            <span aria-hidden className="relative flex size-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
            </span>
            Running
          </span>
        ) : null}
      </div>

      {/* Original message (root preview) */}
      <div className="flex flex-col gap-1">
        <span className="text-[13px] font-bold text-foreground">
          {thread.rootAuthor === "user" ? "You" : agentName}
        </span>
        <p className="line-clamp-2 text-[13px] font-medium leading-relaxed text-foreground">
          {thread.rootPreview || thread.lastReplyPreview || "Thread"}
        </p>
      </div>

      {/* Last reply preview */}
      {thread.replyCount > 0 && thread.lastReplyPreview ? (
        <p className="w-full truncate text-[13px] font-medium text-muted-foreground">
          <span className="font-semibold text-foreground">{lastReplyAuthor}:</span>{" "}
          {thread.lastReplyPreview}
        </p>
      ) : null}

      {/* Footer */}
      <div className="flex w-full items-center gap-2">
        <MessagesSquare className="size-3.5 shrink-0 text-[#4277FB] dark:text-[#9AB0FF]" />
        <span className="text-[13px] font-semibold text-[#4277FB] dark:text-[#9AB0FF]">
          {thread.replyCount} {thread.replyCount === 1 ? "reply" : "replies"}
        </span>
        {lastReply ? (
          <>
            <span className="text-muted-foreground">·</span>
            <span className="text-[12px] font-medium text-muted-foreground">Last reply {lastReply}</span>
          </>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1 text-[12px] font-semibold text-muted-foreground transition-colors group-hover:text-[#4277FB] dark:group-hover:text-[#9AB0FF]">
          View thread
          <ChevronRight className="size-3.5" />
        </span>
      </div>
    </button>
  );
}
