import { cn } from "@/lib/utils";
import type { ThreadSummary } from "@/lib/view-types";

export type ThreadActivity = NonNullable<ThreadSummary["activity"]>;

// The shared thread-activity dot: pulsing green while a run is working,
// steady amber while it waits on the user. One source for the colors and
// motion so the tab bar, thread chips, and thread cards can't drift apart.
// Purely decorative (aria-hidden) — every surface pairs it with its own
// visible label or sr-only text.
export function ActivityDot({
  activity,
  className
}: {
  activity: ThreadActivity;
  className?: string;
}) {
  if (activity === "waiting_approval") {
    return <span aria-hidden className={cn("inline-flex size-2 rounded-full bg-amber-500", className)} />;
  }
  return (
    <span aria-hidden className={cn("relative flex size-2", className)}>
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60 motion-reduce:animate-none" />
      <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
    </span>
  );
}
