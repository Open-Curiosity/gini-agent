"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  Download,
  Loader2,
  Menu,
  MessagesSquare,
  Moon,
  Plus,
  Settings,
  Sun,
  WandSparkles
} from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useChatSessions, useInvalidate, useStatus, useThreadsInbox } from "@/lib/queries";
import { useChatReadState, useThreadReadState } from "@/lib/use-chat-read-state";
import { AgentAvatar } from "@/components/chat/AgentAvatar";
import { CreateAgentDialog } from "@/components/CreateAgentDialog";
import type { AgentRow, ChatSession } from "@/lib/view-types";
import type { GiniUpdateResult, GiniVersionInfo } from "@runtime/types";

// "Online" is a coarse status hint on the sidebar agent rows. The runtime
// reports a richer AgentStatus; anything that isn't an explicit error/paused
// state reads as ready, matching the green dot in the design.
function isAgentOnline(status: string | undefined): boolean {
  if (!status) return true;
  return !["error", "paused", "disabled", "stopped"].includes(status);
}

function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();
  const invalidate = useInvalidate();
  const [createOpen, setCreateOpen] = useState(false);

  const status = useStatus();
  const activeAgentId = status.data?.activeAgent?.id;
  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: () => api<{ agents: AgentRow[]; activeAgentId?: string }>("/agents")
  });
  const agents = agentsQuery.data?.agents ?? [];

  const sessions = useChatSessions();
  const channels = useMemo<ChatSession[]>(() => {
    const all = sessions.data ?? [];
    return all
      .filter((s) => s.kind === "channel" || s.origin === "job")
      .sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt));
  }, [sessions.data]);

  const { isUnread } = useChatReadState(sessions.data);
  const threadsInbox = useThreadsInbox();
  const { isThreadUnread } = useThreadReadState(threadsInbox.data);
  const unreadThreadCount = useMemo(
    () => (threadsInbox.data ?? []).filter((t) => isThreadUnread(t)).length,
    [threadsInbox.data, isThreadUnread]
  );

  const selectedSession = params?.get("session") ?? null;
  const onChat = pathname === "/chat";
  const onThreads = pathname === "/threads";

  const useAgentMutation = useMutation({
    mutationFn: (id: string) => api(`/agents/${encodeURIComponent(id)}/use`, { method: "POST" }),
    onSuccess: () => invalidate(["agents", "state", "status", "memory", "agent-chat"]),
    onError: (error: Error) => toast.error(error.message)
  });

  const selectAgent = (id: string) => {
    if (id !== activeAgentId) useAgentMutation.mutate(id);
    router.push("/chat");
    onNavigate?.();
  };
  const selectChannel = (sessionId: string) => {
    router.push(`/chat?session=${sessionId}`);
    onNavigate?.();
  };

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-2">
        <Link href="/" onClick={onNavigate} className="flex min-w-0 flex-col leading-tight">
          <span className="text-sm font-semibold text-foreground">Gini</span>
          <span className="text-[11px] font-medium text-muted-foreground">Direct messages</span>
        </Link>
        {mounted ? (
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            aria-label="Toggle theme"
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
        ) : null}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 px-2 py-2">
          {/* Agents (DMs) */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between px-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Agents
              </span>
              <button
                type="button"
                aria-label="New agent"
                onClick={() => setCreateOpen(true)}
                className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
              >
                <Plus className="size-3.5" />
              </button>
            </div>
            <ul className="flex flex-col gap-0.5">
              {agents.length === 0 ? (
                <li className="px-2 py-1.5 text-xs text-muted-foreground">No agents yet</li>
              ) : (
                agents.map((agent) => {
                  const active = onChat && !selectedSession && agent.id === activeAgentId;
                  return (
                    <li key={agent.id}>
                      <button
                        type="button"
                        onClick={() => selectAgent(agent.id)}
                        className={cn(
                          "group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                          active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/50"
                        )}
                      >
                        <AgentAvatar name={agent.name} seed={agent.id} size={22} />
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate text-[13px]",
                            active ? "font-semibold text-foreground" : "font-medium text-sidebar-foreground/85"
                          )}
                        >
                          {agent.name}
                        </span>
                        {isAgentOnline(agent.status) ? (
                          <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-[#39C36E]" />
                        ) : null}
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          </div>

          {/* Recurring Jobs (channels) */}
          {channels.length > 0 ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between px-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Recurring Jobs
                </span>
              </div>
              <ul className="flex flex-col gap-0.5">
                {channels.map((channel) => {
                  const active = onChat && selectedSession === channel.id;
                  const unread = !active && isUnread(channel);
                  return (
                    <li key={channel.id}>
                      <button
                        type="button"
                        onClick={() => selectChannel(channel.id)}
                        className={cn(
                          "group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                          active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/50"
                        )}
                      >
                        <span aria-hidden className="text-muted-foreground">#</span>
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate text-[13px]",
                            active || unread
                              ? "font-semibold text-foreground"
                              : "font-medium text-sidebar-foreground/85"
                          )}
                        >
                          {channel.title?.trim() || "Channel"}
                        </span>
                        {unread ? (
                          <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-primary" />
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          <div className="border-t border-sidebar-border" />

          {/* Nav: Threads, Skills, Settings */}
          <ul className="flex flex-col gap-0.5">
            <li>
              <Link
                href="/threads"
                onClick={onNavigate}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors",
                  onThreads
                    ? "bg-sidebar-accent text-foreground"
                    : "text-sidebar-foreground/85 hover:bg-sidebar-accent/50"
                )}
              >
                <MessagesSquare className="size-3.5 text-muted-foreground" />
                <span className="flex-1">Threads</span>
                {unreadThreadCount > 0 ? (
                  <span className="flex items-center justify-center rounded-full bg-primary px-1.5 py-px text-[10px] font-bold text-primary-foreground">
                    {unreadThreadCount}
                  </span>
                ) : null}
              </Link>
            </li>
            <li>
              <Link
                href="/skills"
                onClick={onNavigate}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors",
                  pathname === "/skills"
                    ? "bg-sidebar-accent text-foreground"
                    : "text-sidebar-foreground/85 hover:bg-sidebar-accent/50"
                )}
              >
                <WandSparkles className="size-3.5 text-muted-foreground" />
                Skills
              </Link>
            </li>
            <li>
              <Link
                href="/settings"
                onClick={onNavigate}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors",
                  pathname === "/settings"
                    ? "bg-sidebar-accent text-foreground"
                    : "text-sidebar-foreground/85 hover:bg-sidebar-accent/50"
                )}
              >
                <Settings className="size-3.5 text-muted-foreground" />
                Settings
              </Link>
            </li>
          </ul>
        </div>
      </ScrollArea>

      <UpdateReminder />
      <CreateAgentDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function useMounted() {
  return useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false
  );
}

function UpdateReminder() {
  const qc = useQueryClient();
  const [appliedSha, setAppliedSha] = useState<string | null>(null);
  const status = useStatus({ refetchInterval: appliedSha ? 1_500 : 60_000 });
  const statusVersion = status.data?.version;
  const updateSupported = statusVersion?.update.supported === true;
  const versionCheck = useQuery({
    queryKey: ["version", "check"],
    queryFn: () => api<GiniVersionInfo>("/update/check", { method: "POST" }),
    enabled: updateSupported,
    refetchInterval: 5 * 60_000
  });
  const version = versionCheck.data ?? statusVersion;
  const updateAvailable = version?.git.updateAvailable === true;

  useEffect(() => {
    if (!appliedSha) return;
    if (statusVersion?.git.sha === appliedSha) {
      setAppliedSha(null);
      qc.invalidateQueries({ queryKey: ["version", "check"] });
    }
  }, [appliedSha, statusVersion?.git.sha, qc]);

  useEffect(() => {
    if (!appliedSha) return;
    const timer = setTimeout(() => {
      setAppliedSha(null);
      toast.error("Update applied, but the runtime hasn't reported back. Reload to check.");
      qc.invalidateQueries({ queryKey: ["status"] });
      qc.invalidateQueries({ queryKey: ["version", "check"] });
    }, 30_000);
    return () => clearTimeout(timer);
  }, [appliedSha, qc]);

  const update = useMutation({
    mutationFn: () => api<GiniUpdateResult>("/update", { method: "POST" }),
    onSuccess: (result) => {
      if (result.upToDate) {
        toast.success("Gini is already current");
        qc.invalidateQueries({ queryKey: ["status"] });
        qc.invalidateQueries({ queryKey: ["version", "check"] });
        return;
      }
      toast.success("Gini updated. Restarting...");
      setAppliedSha(result.afterSha);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const showUpdate = updateAvailable && !appliedSha;

  return (
    <div className="border-t border-sidebar-border px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-mono text-[10px] text-sidebar-foreground/65">
            v{version?.packageVersion ?? "0.0.0"}{version?.git.shortSha ? ` · ${version.git.shortSha}` : ""}
          </div>
          {showUpdate ? (
            <div className="text-xs font-medium text-sidebar-foreground">Update ready</div>
          ) : (
            <div className="text-xs text-sidebar-foreground/65">Gini agent</div>
          )}
        </div>
        {showUpdate ? (
          <Button
            size="sm"
            variant="default"
            className="h-7 shrink-0"
            disabled={update.isPending || !updateSupported}
            onClick={() => update.mutate()}
          >
            {update.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            Update
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function Sidebar() {
  return (
    <aside className="hidden h-full w-[266px] shrink-0 border-r border-sidebar-border md:flex md:flex-col">
      <SidebarBody />
    </aside>
  );
}

export function MobileTopBar() {
  const [open, setOpen] = useState(false);
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-3 md:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button size="icon" variant="ghost" className="h-9 w-9" aria-label="Open navigation">
            <Menu className="h-5 w-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-[266px] p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Navigation</SheetTitle>
          </SheetHeader>
          <SidebarBody onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
      <span className="text-sm font-semibold">Gini</span>
    </header>
  );
}
