"use client";

import { useState } from "react";
import type { ToolResultBlock } from "@runtime/types";

// Collapsed one-line preview by default; clicking expands the full
// (already-truncated by the server, see chatBlockArgsPreviewFor) preview
// so the user can inspect a tool's output without leaving the chat.
export function BlockToolResult({ block }: { block: ToolResultBlock }) {
  const [expanded, setExpanded] = useState(false);
  const collapsedPreview = firstLine(block.preview);
  return (
    <div className="text-[11px] text-muted-foreground">
      <button
        type="button"
        className="text-left font-mono leading-snug hover:text-foreground"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? (
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-muted/40 p-2 text-[11px]">
            {block.preview}
          </pre>
        ) : (
          <span className="line-clamp-1 break-all">{collapsedPreview || "(empty result)"}</span>
        )}
      </button>
      {block.truncated && !expanded ? (
        <span className="ml-1 text-[10px] italic">(truncated)</span>
      ) : null}
    </div>
  );
}

function firstLine(text: string): string {
  const idx = text.indexOf("\n");
  return idx >= 0 ? text.slice(0, idx) : text;
}
