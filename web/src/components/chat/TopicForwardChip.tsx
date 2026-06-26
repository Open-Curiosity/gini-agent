import Link from "next/link";
import { MessagesSquare } from "lucide-react";

// A forwarded copy of a Topic's final answer lands in the parent Chat tagged
// with the Topic's id + title (ADR chat-topics-tasks-subagents.md). This chip
// renders below that answer text as a subtle sky-accented pill — matching the
// "from <job name>" container in the chat transcript — and deep-links into the
// Topic's own conversation via the same `?session=` navigation the sidebar uses.
export function TopicForwardChip({
  topicId,
  topicTitle
}: {
  topicId: string;
  topicTitle?: string;
}) {
  const title = topicTitle?.trim() || "topic";
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-sky-500/30 bg-sky-500/5 px-3 py-1 text-xs text-muted-foreground">
      <MessagesSquare className="size-3.5 text-sky-500/70" />
      <span>
        from <span className="font-medium text-foreground">#{title}</span>
      </span>
      <Link
        href={`/chat?session=${topicId}`}
        className="font-medium text-sky-600 hover:underline dark:text-sky-400"
      >
        View topic →
      </Link>
    </div>
  );
}
