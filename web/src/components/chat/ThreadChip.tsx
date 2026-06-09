import { ChevronRight, MessagesSquare } from "lucide-react";
import type { ThreadSummary } from "@/lib/view-types";
import { formatRelativeTime } from "./relative-time";

// Inline thread affordance — design `vKElA` / `R3DC9`. Rendered under a
// main-chat assistant block that a thread branched from. Two states:
//   - has replies: "N replies in a thread · Last reply … · View thread →"
//   - empty (no replies yet): "Reply in thread" prompt
// Clicking opens the side panel for that thread.
export function ThreadChip({
  thread,
  onOpen
}: {
  thread: ThreadSummary;
  onOpen: () => void;
}) {
  const hasReplies = thread.replyCount > 0;
  const lastReply = thread.lastReplyAt ? formatRelativeTime(thread.lastReplyAt) : "";
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 rounded-lg border border-[#D7DEFA] bg-[#EEF2FF] px-2.5 py-1.5 text-left transition-colors hover:bg-[#E0E8FF] dark:border-[#1E2330] dark:bg-[#10131C] dark:hover:bg-[#141826]"
    >
      <MessagesSquare className="size-3.5 shrink-0 text-[#4277FB] dark:text-[#8893A8]" />
      {hasReplies ? (
        <>
          <span className="text-[13px] font-semibold text-[#4277FB] dark:text-[#9AB0FF]">
            {thread.replyCount} {thread.replyCount === 1 ? "reply" : "replies"} in a thread
          </span>
          {lastReply ? (
            <>
              <span className="text-muted-foreground">·</span>
              <span className="truncate text-[12px] font-medium text-muted-foreground">
                Last reply {lastReply}
              </span>
            </>
          ) : null}
          <span className="ml-auto flex shrink-0 items-center gap-1 text-[12px] font-semibold text-[#4277FB] dark:text-[#9AB0FF]">
            View thread
            <ChevronRight className="size-3.5" />
          </span>
        </>
      ) : (
        <span className="text-[13px] font-semibold text-[#4277FB] dark:text-[#9098AD]">Reply in thread</span>
      )}
    </button>
  );
}
