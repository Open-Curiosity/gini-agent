"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar } from "@/components/chat/Avatar";
import { Composer } from "@/components/chat/Composer";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { PhaseIndicator } from "@/components/chat/PhaseIndicator";
import { SessionItem } from "@/components/chat/SessionItem";
import { api } from "@/lib/api";
import {
  useChatSession,
  useChatSessions,
  useDeleteChatSession,
  useInvalidate,
  useRenameChatSession
} from "@/lib/queries";
import type { ChatMessage, ChatSession } from "@/lib/view-types";

const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "waiting_approval"]);

export default function ChatPage() {
  const sessions = useChatSessions();
  const params = useSearchParams();
  const initial = params?.get("session") ?? null;
  const [selected, setSelected] = useState<string | null>(initial);
  const [text, setText] = useState("");
  const session = useChatSession(selected);
  const invalidate = useInvalidate();
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  // Tracks taskIds that have already been auto-synced (or are in flight) for
  // the current session view, so the polling effect doesn't refire sync on
  // every 3s tick once the task hits a terminal state.
  const syncedTaskIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (initial && initial !== selected) setSelected(initial);
  }, [initial, selected]);

  const orderedSessions = useMemo<ChatSession[]>(() => {
    const all = sessions.data ?? [];
    if (all.length === 0) return [];
    const sortedByCreatedAt = [...all].sort((a, b) =>
      (a.createdAt ?? "").localeCompare(b.createdAt ?? "")
    );
    const main = sortedByCreatedAt[0];
    if (!main) return [];
    const rest = sortedByCreatedAt
      .slice(1)
      .sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt));
    return [main, ...rest];
  }, [sessions.data]);

  useEffect(() => {
    if (!selected && orderedSessions.length > 0) setSelected(orderedSessions[0]!.id);
  }, [selected, orderedSessions]);

  useEffect(() => {
    syncedTaskIdsRef.current = new Set();
  }, [selected]);

  const create = useMutation({
    mutationFn: () =>
      api<ChatSession>("/chat", { method: "POST", body: JSON.stringify({ title: "" }) }),
    onSuccess: (s) => {
      setSelected(s.id);
      invalidate(["chat"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const send = useMutation({
    mutationFn: (content: string) =>
      api<{ taskId: string }>(`/chat/${selected}/messages`, {
        method: "POST",
        body: JSON.stringify({ content })
      }),
    onSuccess: () => {
      setText("");
      invalidate(["chat", "tasks"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const sync = useMutation({
    mutationFn: (taskId: string) =>
      api<ChatMessage>(`/chat/${selected}/tasks/${taskId}/sync`, { method: "POST" }),
    onSuccess: () => invalidate(["chat"]),
    onError: (error: Error) => toast.error(error.message)
  });

  const deleteSession = useDeleteChatSession();
  const renameSession = useRenameChatSession();

  const messages = session.data?.messages;
  const tasks = session.data?.tasks;

  useEffect(() => {
    if (!messages || !tasks) return;
    const assistantTaskIds = new Set(
      messages.filter((m) => m.role === "assistant" && m.taskId).map((m) => m.taskId as string)
    );
    for (const message of messages) {
      if (message.role !== "user" || !message.taskId) continue;
      if (assistantTaskIds.has(message.taskId)) continue;
      if (syncedTaskIdsRef.current.has(message.taskId)) continue;
      const task = tasks.find((t) => t.id === message.taskId);
      if (!task || !TERMINAL_TASK_STATUSES.has(task.status)) continue;
      syncedTaskIdsRef.current.add(message.taskId);
      sync.mutate(message.taskId);
    }
  }, [messages, tasks, sync]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages?.length, selected]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || send.isPending || !selected) return;
    send.mutate(trimmed);
  };

  const mainId = orderedSessions[0]?.id;

  // Determine if a pending assistant reply is in-flight for this session.
  const pendingPhase: "thinking" | null = useMemo(() => {
    if (!messages || !tasks) return null;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "user" || !last.taskId) return null;
    const hasAssistantForTask = messages.some(
      (m) => m.role === "assistant" && m.taskId === last.taskId
    );
    if (hasAssistantForTask) return null;
    const task = tasks.find((t) => t.id === last.taskId);
    if (task && TERMINAL_TASK_STATUSES.has(task.status)) return null;
    return "thinking";
  }, [messages, tasks]);

  const handleDelete = (id: string) => {
    deleteSession.mutate(id, {
      onSuccess: () => {
        if (selected === id) {
          const next = orderedSessions.find((s) => s.id !== id);
          setSelected(next?.id ?? null);
        }
      },
      onError: (error) => toast.error(error.message)
    });
  };

  const handleRename = (id: string, title: string) => {
    renameSession.mutate(
      { id, title },
      { onError: (error) => toast.error(error.message) }
    );
  };

  return (
    <div className="flex flex-1 overflow-hidden">
      <aside className="flex w-full shrink-0 flex-col border-b border-border md:w-[260px] md:border-r md:border-b-0">
        <div className="p-2">
          <button
            className="flex h-9 w-full items-center gap-1.5 rounded-lg px-2.5 text-sm font-normal hover:bg-accent disabled:opacity-50"
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            <Plus className="size-4" /> New chat
          </button>
        </div>
        <ScrollArea className="flex-1">
          <div className="px-2 pb-3">
            {orderedSessions.length === 0 ? (
              <p className="px-2.5 py-3 text-xs text-muted-foreground">No chats yet</p>
            ) : (
              <ul className="space-y-0.5">
                {orderedSessions.map((s) => (
                  <SessionItem
                    key={s.id}
                    session={s}
                    isActive={selected === s.id}
                    isMain={s.id === mainId}
                    onSelect={() => setSelected(s.id)}
                    onDelete={() => handleDelete(s.id)}
                    onRename={(title) => handleRename(s.id, title)}
                  />
                ))}
              </ul>
            )}
          </div>
        </ScrollArea>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
            {orderedSessions.length === 0 ? "No chats yet — start a new one" : "Select a chat"}
          </div>
        ) : !session.data ? (
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
            Loading…
          </div>
        ) : (
          <>
            <header className="sticky top-0 z-10 bg-background px-4 py-3">
              <h1 className="truncate text-base font-semibold">
                {session.data.title || "New chat"}
              </h1>
            </header>

            <ScrollArea className="flex-1">
              <div className="mx-auto w-full max-w-3xl px-4 py-6">
                {!messages || messages.length === 0 ? (
                  <div className="flex min-h-[40vh] items-center justify-center">
                    <h2 className="text-2xl font-semibold">What can I help with?</h2>
                  </div>
                ) : (
                  <ul className="space-y-5">
                    {messages.map((message) => (
                      <li key={message.id}>
                        <MessageBubble message={message} />
                      </li>
                    ))}
                    {pendingPhase ? (
                      <li>
                        <div className="flex items-start gap-2.5">
                          <Avatar />
                          <PhaseIndicator phase={pendingPhase} />
                        </div>
                      </li>
                    ) : null}
                  </ul>
                )}
                <div ref={messagesEndRef} />
              </div>
            </ScrollArea>

            <div className="px-4 pb-4 pt-2">
              <div className="mx-auto w-full max-w-3xl">
                <Composer
                  value={text}
                  onChange={setText}
                  onSubmit={submit}
                  busy={send.isPending}
                  disabled={!selected}
                />
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
