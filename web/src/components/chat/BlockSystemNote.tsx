import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SystemNoteBlock } from "@runtime/types";

// Muted italic line used for terminal flags ("Cancelled", "Failed: …") and
// other operator-attributed notes. Kept low-key so it doesn't pull focus
// from the assistant's reply.
//
// Provider-credential failures (block.authError) are the exception: they
// render as an alert card that names the provider and links to Settings →
// Providers, so the user can re-authenticate instead of being told to "sign
// in again" with no provider and no entry point (issue #205).
export function BlockSystemNote({ block }: { block: SystemNoteBlock }) {
  if (block.authError) {
    const { providerLabel, detail } = block.authError;
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
        <div className="flex items-center gap-2">
          <ShieldAlert className="size-4 shrink-0 text-amber-600 dark:text-amber-500" aria-hidden />
          <span className="text-xs font-medium text-foreground">{block.text}</span>
        </div>
        {detail ? (
          <p className="mt-1 text-[11px] italic text-muted-foreground">{detail}</p>
        ) : null}
        <Button asChild size="sm" variant="outline" className="mt-2">
          <Link href="/settings">Re-authenticate {providerLabel}</Link>
        </Button>
      </div>
    );
  }
  return (
    <p className="text-xs italic text-muted-foreground">{block.text}</p>
  );
}
