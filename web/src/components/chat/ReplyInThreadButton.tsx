import { MessagesSquare } from "lucide-react";

// Inline "Reply in thread" affordance — design `R3DC9`. Always visible under a
// main-chat assistant message that does NOT yet host a thread, so the user can
// branch a Slack-style thread off any agent reply. Subtle by default, emphasized
// on hover. Clicking mints a new thread rooted at this message.
export function ReplyInThreadButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-[7px] rounded-lg border border-[#1E2330] bg-[#10131C] px-2.5 py-1.5 text-left text-[#9098AD] transition-colors hover:border-[#2A3142] hover:bg-[#141826] hover:text-[#B6BFD4]"
    >
      <MessagesSquare className="size-3.5 shrink-0 text-[#8893A8]" />
      <span className="text-[13px] font-semibold">Reply in thread</span>
    </button>
  );
}
