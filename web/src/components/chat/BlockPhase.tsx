import type { PhaseBlock } from "@runtime/types";

// Animated three-dot indicator driven by the block's `label`. The runtime
// emits phase strings ("Thinking", "Working: <tool>", "Completed",
// "Cancelled", "Failed") — we render them verbatim so the vocabulary
// stays server-owned.
export function BlockPhase({ block }: { block: PhaseBlock }) {
  return (
    <div className="flex min-h-8 items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{block.label}</span>
      <div className="inline-flex items-center gap-1" aria-hidden="true">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:0ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:300ms]" />
      </div>
    </div>
  );
}
