"use client";

import { useState } from "react";
import { ChevronRight, Globe } from "lucide-react";
import type { ToolCallBlock, ToolResultBlock } from "@runtime/types";

// Restored the pre-protocol visual: small leading icon + bold display
// label + monospace args pill. No badge on the happy path — completed
// tool calls sit quietly. Error/denied surface the error message in
// red inline, since those are user-actionable.
//
// The row itself is a button: clicking toggles an inline preview of
// the matching tool_result. Result blocks are passed by the chat page
// via the BlockRenderer dispatcher.
export function BlockToolCall({
  block,
  result
}: {
  block: ToolCallBlock;
  result?: ToolResultBlock;
}) {
  const [expanded, setExpanded] = useState(false);
  const failed = block.status === "error" || block.status === "denied";
  const canExpand = Boolean(result);
  return (
    <div className="flex flex-col gap-1 text-xs">
      <button
        type="button"
        className="flex flex-wrap items-center gap-2 text-left transition-colors hover:text-foreground disabled:cursor-default"
        disabled={!canExpand}
        onClick={canExpand ? () => setExpanded((v) => !v) : undefined}
      >
        {canExpand ? (
          <ChevronRight
            className={`size-3 shrink-0 text-muted-foreground transition-transform ${
              expanded ? "rotate-90" : ""
            }`}
            aria-hidden="true"
          />
        ) : (
          <Globe className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <span className="font-semibold text-foreground">{block.displayLabel}</span>
        {block.argsPreview ? (
          <span className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            {block.argsPreview}
          </span>
        ) : null}
      </button>
      {failed && block.errorMessage ? (
        <span className="pl-1 text-[11px] text-red-400/90">{block.errorMessage}</span>
      ) : null}
      {expanded && result ? (
        <pre className="ml-4 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground">
          {result.preview}
          {result.truncated ? "\n\n[truncated]" : ""}
        </pre>
      ) : null}
    </div>
  );
}
