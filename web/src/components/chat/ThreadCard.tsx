"use client";

import { ChevronRight, MessagesSquare } from "lucide-react";
import type { ThreadSummary } from "@/lib/view-types";
import { formatRelativeTime } from "./relative-time";
import { agentColor } from "@/lib/agent-visuals";

// Thread Card — one row in the cross-agent Threads inbox and the per-agent
// Threads tab. The WHOLE card is a single button that opens the thread side
// panel, matching the chat surface's thread chip (no inline expansion — the
// panel is the one place replies render). Content is width-capped to the
// chat's column so footers don't straddle ultra-wide rows. Layout:
//   - meta: "in <agent chip>" + New badge, with an activity pill on the
//     right while the thread's run is in flight (green "Running", or amber
//     "Needs approval" when the run is parked on a user gate)
//   - root: "<author>: <parent-message preview>" (clamped to two lines)
//   - last reply: "<author>: <preview>" one-liner — the freshest context
//   - footer: reply count + last-reply age + "View thread →", in the same
//     blue the in-chat thread chip uses for the identical action
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
  const rootAuthor = thread.rootAuthor === "user" ? "You" : agentName;
  const lastReplyAuthor = thread.lastReplyAuthor === "user" ? "You" : agentName;
  const rootPreview = thread.rootPreview || thread.lastReplyPreview || "Thread";
  // The aria-label replaces the button's content in accessible-name
  // computation, so it must carry the same state sighted users get from the
  // badges: reply count, activity, unread.
  const ariaState = [
    `${thread.replyCount} ${thread.replyCount === 1 ? "reply" : "replies"}`,
    ...(thread.activity === "running" ? ["running"] : []),
    ...(thread.activity === "waiting_approval" ? ["needs approval"] : []),
    ...(isUnread ? ["unread"] : [])
  ].join(", ");

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open thread: ${rootPreview} (${ariaState})`}
      className="group w-full cursor-pointer border-b border-border bg-background px-10 py-5 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2.5">
        {/* Meta */}
        <div className="flex w-full flex-wrap items-center gap-2 text-[12px]">
          <span className="font-medium text-muted-foreground">in</span>
          <span className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-0.5">
            <span aria-hidden className="size-[7px] rounded-full" style={{ backgroundColor: dotColor }} />
            <span className="font-semibold text-foreground">{agentName}</span>
          </span>
          {isUnread ? (
            <span className="flex items-center justify-center rounded-lg bg-primary px-1.5 py-px text-[10px] font-bold text-primary-foreground">
              New
            </span>
          ) : null}
          {thread.activity === "running" ? (
            <span className="ml-auto flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
              <span aria-hidden className="relative flex size-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60 motion-reduce:animate-none" />
                <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
              </span>
              Running
            </span>
          ) : thread.activity === "waiting_approval" ? (
            <span className="ml-auto flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-600 dark:text-amber-400">
              <span aria-hidden className="inline-flex size-2 rounded-full bg-amber-500" />
              Needs approval
            </span>
          ) : null}
        </div>

        {/* Original message (root preview) */}
        <p className="line-clamp-2 text-[13px] font-medium leading-relaxed text-foreground">
          <span className="font-bold">{rootAuthor}:</span> {rootPreview}
        </p>

        {/* Last reply preview */}
        {thread.replyCount > 0 && thread.lastReplyPreview ? (
          <p className="w-full truncate text-[13px] font-medium text-muted-foreground">
            <span className="font-semibold text-foreground">{lastReplyAuthor}:</span>{" "}
            {thread.lastReplyPreview}
          </p>
        ) : null}

        {/* Footer */}
        <div className="flex w-full items-center gap-2">
          <MessagesSquare className="size-3.5 shrink-0 text-[#4277FB] dark:text-[#8893A8]" />
          {thread.replyCount > 0 ? (
            <>
              <span className="text-[13px] font-semibold text-[#4277FB] dark:text-[#9AB0FF]">
                {thread.replyCount} {thread.replyCount === 1 ? "reply" : "replies"}
              </span>
              {lastReply ? (
                <>
                  <span className="text-[12px] text-muted-foreground">·</span>
                  <span className="text-[12px] font-medium text-muted-foreground">
                    Last reply {lastReply}
                  </span>
                </>
              ) : null}
            </>
          ) : (
            <span className="text-[13px] font-semibold text-muted-foreground">No replies yet</span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1 text-[12px] font-semibold text-[#4277FB] group-hover:underline group-focus-visible:underline dark:text-[#9AB0FF]">
            View thread
            <ChevronRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
          </span>
        </div>
      </div>
    </button>
  );
}
