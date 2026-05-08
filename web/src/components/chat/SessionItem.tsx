"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { ChatSession } from "@/lib/view-types";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "./relative-time";

export interface SessionItemProps {
  session: ChatSession;
  isActive: boolean;
  isMain: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
}

export function SessionItem({
  session,
  isActive,
  isMain,
  onSelect,
  onDelete,
  onRename
}: SessionItemProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title || "");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const startEdit = () => {
    setDraft(session.title || "");
    setEditing(true);
  };

  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, [editing]);

  const finishEdit = (commit: boolean) => {
    if (!editing) return;
    setEditing(false);
    if (!commit) return;
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (trimmed === session.title) return;
    onRename(trimmed);
  };

  const label = (() => {
    const raw = session.title?.trim() || (isMain ? "Main" : "New chat");
    return raw.length <= 50 ? raw : `${raw.slice(0, 50)}...`;
  })();

  const time = formatRelativeTime(session.updatedAt ?? session.createdAt);

  return (
    <li>
      <div
        className={cn(
          "group flex h-9 items-center gap-2 rounded-[10px] px-2.5 text-sm transition-colors",
          isActive ? "bg-accent text-foreground" : "text-foreground/80 hover:bg-accent/60"
        )}
      >
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => finishEdit(true)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                finishEdit(true);
              } else if (event.key === "Escape") {
                event.preventDefault();
                finishEdit(false);
              }
            }}
            className="min-w-0 flex-1 border-0 bg-transparent text-sm outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={onSelect}
            onDoubleClick={startEdit}
            className="flex min-w-0 flex-1 items-center gap-2 truncate text-left"
          >
            <span className="truncate">{label}</span>
            {isMain ? (
              <span className="rounded bg-muted px-1 py-px text-[9px] font-medium leading-tight text-muted-foreground">
                Main
              </span>
            ) : null}
          </button>
        )}
        {!editing && time ? (
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground group-hover:hidden">
            {time}
          </span>
        ) : null}
        {!editing && !isMain ? (
          <button
            type="button"
            aria-label="Delete chat"
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
            className="ml-auto hidden size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive group-hover:flex"
          >
            <X className="size-3" />
          </button>
        ) : null}
      </div>
    </li>
  );
}
