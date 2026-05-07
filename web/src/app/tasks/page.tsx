"use client";

import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PageHeader, EmptyState } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";
import { useInvalidate, useTask, useTasks } from "@/lib/queries";
import type { Task } from "@/lib/types";

const FILTERS = [
  { key: "active", label: "Active", match: (t: Task) => ["queued", "running", "waiting_approval"].includes(t.status) },
  { key: "waiting", label: "Waiting", match: (t: Task) => t.status === "waiting_approval" },
  { key: "scheduled", label: "Scheduled", match: (t: Task) => Boolean(t.jobId) && (t.status === "queued" || t.status === "running") },
  { key: "completed", label: "Completed", match: (t: Task) => t.status === "completed" },
  { key: "failed", label: "Failed", match: (t: Task) => t.status === "failed" || t.status === "cancelled" },
  { key: "all", label: "All", match: () => true }
] as const;

export default function TasksPage() {
  const [input, setInput] = useState("");
  const [filter, setFilter] = useState<typeof FILTERS[number]["key"]>("active");
  const [selected, setSelected] = useState<string | null>(null);
  const tasks = useTasks();
  const detail = useTask(selected);
  const invalidate = useInvalidate();

  const submit = useMutation({
    mutationFn: (text: string) => api<Task>("/tasks", { method: "POST", body: JSON.stringify({ input: text }) }),
    onSuccess: (task) => {
      toast.success(`Task submitted: ${task.id}`);
      setInput("");
      setSelected(task.id);
      invalidate(["tasks", "state", "events"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const action = useMutation({
    mutationFn: ({ id, op }: { id: string; op: "retry" | "cancel" }) =>
      api<Task>(`/tasks/${id}/${op}`, { method: "POST" }),
    onSuccess: (_, vars) => {
      toast.success(`${vars.op}: ${vars.id}`);
      invalidate(["tasks", "task", "state"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const filtered = useMemo(() => {
    const f = FILTERS.find((x) => x.key === filter)!.match;
    return (tasks.data ?? []).filter(f).slice().reverse();
  }, [tasks.data, filter]);

  return (
    <>
      <PageHeader title="Tasks" description="Submit, monitor, and inspect tasks" />
      <div className="flex flex-1 flex-col gap-4 overflow-hidden p-4 md:flex-row md:p-6">
        <div className="flex w-full shrink-0 flex-col gap-4 md:w-[420px]">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">New task</CardTitle>
              <CardDescription>e.g. read README.md, write x.txt :: hello</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Ask Gini to do something"
                className="min-h-24"
              />
              <Button
                disabled={submit.isPending || !input.trim()}
                onClick={() => submit.mutate(input.trim())}
                className="w-full"
              >
                {submit.isPending ? "Submitting…" : "Submit task"}
              </Button>
            </CardContent>
          </Card>

          <Tabs value={filter} onValueChange={(value) => setFilter(value as typeof filter)}>
            <TabsList className="w-full">
              {FILTERS.map((f) => (
                <TabsTrigger key={f.key} value={f.key} className="text-xs">
                  {f.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {FILTERS.map((f) => (
              <TabsContent key={f.key} value={f.key} className="mt-3">
                <ScrollArea className="h-[calc(100vh-360px)]">
                  {filtered.length === 0 ? (
                    <EmptyState title={`No ${f.label.toLowerCase()} tasks`} />
                  ) : (
                    <ul className="space-y-2">
                      {filtered.map((task) => (
                        <li key={task.id}>
                          <button
                            onClick={() => setSelected(task.id)}
                            className={`flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-left transition-colors ${
                              selected === task.id
                                ? "border-primary bg-accent"
                                : "border-border bg-card hover:bg-accent/50"
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="line-clamp-1 text-sm font-medium">{task.title}</span>
                              <StatusPill value={task.status} />
                            </div>
                            <span className="font-mono text-[10px] text-muted-foreground">{task.id}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </ScrollArea>
              </TabsContent>
            ))}
          </Tabs>
        </div>

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {!selected ? (
            <EmptyState title="Select a task" description="Pick one from the list to see details and trace." />
          ) : detail.data ? (
            <TaskDetail
              data={detail.data}
              actionPending={action.isPending}
              onAction={(op) => action.mutate({ id: detail.data!.task.id, op })}
            />
          ) : (
            <EmptyState title="Loading…" />
          )}
        </div>
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

function TaskDetail({
  data,
  actionPending,
  onAction
}: {
  data: { task: Task; trace: unknown[] };
  actionPending: boolean;
  onAction: (op: "retry" | "cancel") => void;
}) {
  const task = data.task;
  return (
    <Card className="flex flex-1 flex-col overflow-hidden">
      <CardHeader>
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <CardTitle className="truncate text-base">{task.title}</CardTitle>
            <CardDescription className="font-mono text-[11px]">{task.id}</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill value={task.status} />
            <Button size="sm" variant="outline" disabled={actionPending} onClick={() => onAction("retry")}>Retry</Button>
            <Button
              size="sm"
              variant="outline"
              disabled={actionPending || ["completed", "cancelled"].includes(task.status)}
              onClick={() => onAction("cancel")}
            >
              Cancel
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden">
        <Tabs defaultValue="overview" className="flex h-full flex-col overflow-hidden">
          <TabsList className="self-start">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="related">Related</TabsTrigger>
            <TabsTrigger value="trace">Trace</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="flex-1 overflow-hidden">
            <ScrollArea className="h-full pr-3">
              <div className="space-y-4 pb-6">
                <div className="grid gap-2 text-xs sm:grid-cols-2">
                  <Field label="Status" value={task.status} mono />
                  <Field label="Lane" value={task.lane} mono />
                  <Field label="Created" value={new Date(task.createdAt).toLocaleString()} />
                  <Field label="Updated" value={new Date(task.updatedAt).toLocaleString()} />
                  {task.currentStep ? <Field label="Current step" value={task.currentStep} mono /> : null}
                  {task.jobId ? <Field label="Job" value={task.jobId} mono /> : null}
                  {task.parentTaskId ? <Field label="Parent task" value={task.parentTaskId} mono /> : null}
                  {task.subagentId ? <Field label="Subagent" value={task.subagentId} mono /> : null}
                </div>
                <Section title="Input">
                  <pre className="whitespace-pre-wrap font-mono text-xs text-muted-foreground">{task.input}</pre>
                </Section>
                {task.summary ? (
                  <Section title="Summary">
                    <pre className="whitespace-pre-wrap text-xs">{task.summary}</pre>
                  </Section>
                ) : null}
                {task.error ? (
                  <Section title="Error">
                    <pre className="whitespace-pre-wrap text-xs text-red-400">{task.error}</pre>
                  </Section>
                ) : null}
                {task.cost ? (
                  <Section title="Cost">
                    <div className="grid gap-2 text-xs sm:grid-cols-2">
                      <Field label="Provider" value={task.cost.provider} mono />
                      <Field label="Model" value={task.cost.model} mono />
                      {typeof task.cost.inputTokens === "number" ? (
                        <Field label="Input tokens" value={task.cost.inputTokens.toLocaleString()} mono />
                      ) : null}
                      {typeof task.cost.outputTokens === "number" ? (
                        <Field label="Output tokens" value={task.cost.outputTokens.toLocaleString()} mono />
                      ) : null}
                      {typeof task.cost.totalTokens === "number" ? (
                        <Field label="Total tokens" value={task.cost.totalTokens.toLocaleString()} mono />
                      ) : null}
                      {typeof task.cost.estimatedUsd === "number" ? (
                        <Field label="Estimated USD" value={`$${task.cost.estimatedUsd.toFixed(4)}`} mono />
                      ) : null}
                    </div>
                  </Section>
                ) : null}
              </div>
            </ScrollArea>
          </TabsContent>
          <TabsContent value="related" className="flex-1 overflow-hidden">
            <ScrollArea className="h-full pr-3">
              <div className="space-y-4 pb-6">
                <Section title={`Approvals (${task.approvalIds.length})`}>
                  <IdList ids={task.approvalIds} hint="Open Permissions to act on these." />
                </Section>
                <Section title={`Memory changes (${task.memoryIds.length})`}>
                  <IdList ids={task.memoryIds} hint="Review on the Memory page." />
                </Section>
                <Section title={`Skills used (${task.skillIds.length})`}>
                  <IdList ids={task.skillIds} hint="Inspect on the Skills page." />
                </Section>
                <Section title={`Audit (${task.auditIds.length})`}>
                  <IdList ids={task.auditIds} hint="Cross-reference on the Activity page." />
                </Section>
              </div>
            </ScrollArea>
          </TabsContent>
          <TabsContent value="trace" className="flex-1 overflow-hidden">
            <ScrollArea className="h-full pr-3">
              <div className="space-y-2 pb-6">
                <p className="text-[11px] text-muted-foreground">{data.trace.length} entries · {task.tracePath}</p>
                <pre className="overflow-x-auto rounded-md border border-border bg-card/50 p-3 font-mono text-[11px] text-muted-foreground">
                  {JSON.stringify(data.trace, null, 2)}
                </pre>
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`truncate ${mono ? "font-mono" : ""}`}>{value}</p>
    </div>
  );
}

function IdList({ ids, hint }: { ids: string[]; hint: string }) {
  if (ids.length === 0) return <p className="text-xs text-muted-foreground">None.</p>;
  return (
    <>
      <ul className="space-y-1">
        {ids.map((id) => (
          <li key={id} className="rounded-md border border-border bg-card/50 px-2 py-1 font-mono text-[11px] text-muted-foreground">
            {id}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[10px] text-muted-foreground">{hint}</p>
    </>
  );
}
