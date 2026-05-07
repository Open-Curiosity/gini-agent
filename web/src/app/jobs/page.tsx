"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PageHeader, EmptyState } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";
import { useInvalidate, useJobRuns, useJobs } from "@/lib/queries";
import type { JobRecord, JobRunRecord, Task } from "@/lib/types";

export default function JobsPage() {
  const jobs = useJobs();
  const [selected, setSelected] = useState<string | null>(null);
  const runs = useJobRuns(selected ?? undefined);
  const invalidate = useInvalidate();

  const action = useMutation({
    mutationFn: ({ id, op }: { id: string; op: "run" | "pause" | "resume" }) =>
      api<JobRecord>(`/jobs/${id}/${op}`, { method: "POST" }),
    onSuccess: (_, vars) => {
      toast.success(`${vars.op}: ${vars.id}`);
      invalidate(["jobs", "jobRuns", "events"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const replay = useMutation({
    mutationFn: (runId: string) => api<JobRunRecord>(`/job-runs/${runId}/replay`, { method: "POST" }),
    onSuccess: () => invalidate(["jobs", "jobRuns", "events"])
  });

  return (
    <>
      <PageHeader title="Jobs" description="Scheduled prompts and scripts" />
      <div className="flex flex-1 flex-col gap-4 overflow-hidden p-4 md:flex-row md:p-6">
        <div className="flex w-full shrink-0 flex-col gap-2 overflow-auto md:w-96">
          {(jobs.data ?? []).length === 0 ? (
            <EmptyState title="No jobs" description="Add via `gini job add` for now." />
          ) : (
            (jobs.data ?? []).map((job) => (
              <Card
                key={job.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelected(job.id)}
                className={`cursor-pointer transition-colors ${selected === job.id ? "border-primary" : ""}`}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CardTitle className="line-clamp-1 text-sm">{job.name}</CardTitle>
                      <CardDescription className="font-mono text-[11px]">{job.id} · every {job.intervalSeconds}s</CardDescription>
                    </div>
                    <StatusPill value={job.status} />
                  </div>
                </CardHeader>
                <CardContent className="space-y-1 text-[11px] text-muted-foreground">
                  <p>last run {job.lastRunAt ? new Date(job.lastRunAt).toLocaleString() : "—"}</p>
                  <p>next {job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : "—"}</p>
                  <p>{job.runCount} runs · {job.missedRuns} missed</p>
                  <div className="flex gap-1.5 pt-1">
                    <Button size="sm" variant="outline" disabled={action.isPending} onClick={(event) => { event.stopPropagation(); action.mutate({ id: job.id, op: "run" }); }}>Run</Button>
                    {job.status === "active" ? (
                      <Button size="sm" variant="outline" disabled={action.isPending} onClick={(event) => { event.stopPropagation(); action.mutate({ id: job.id, op: "pause" }); }}>Pause</Button>
                    ) : (
                      <Button size="sm" variant="outline" disabled={action.isPending} onClick={(event) => { event.stopPropagation(); action.mutate({ id: job.id, op: "resume" }); }}>Resume</Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {selected ? (
            <JobDetail
              job={(jobs.data ?? []).find((j) => j.id === selected) ?? null}
              runs={runs.data ?? []}
              replayPending={replay.isPending}
              onReplay={(id) => replay.mutate(id)}
            />
          ) : (
            <Card className="flex flex-1 flex-col overflow-hidden">
              <CardHeader>
                <CardTitle className="text-sm">All run history</CardTitle>
                <CardDescription>Select a job to filter and inspect</CardDescription>
              </CardHeader>
              <CardContent className="flex-1 overflow-hidden">
                <ScrollArea className="h-full pr-3">
                  {(runs.data ?? []).length === 0 ? (
                    <EmptyState title="No runs yet" />
                  ) : (
                    <RunList runs={runs.data ?? []} replayPending={replay.isPending} onReplay={(id) => replay.mutate(id)} />
                  )}
                </ScrollArea>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function JobDetail({
  job,
  runs,
  replayPending,
  onReplay
}: {
  job: JobRecord | null;
  runs: JobRunRecord[];
  replayPending: boolean;
  onReplay: (id: string) => void;
}) {
  if (!job) return <EmptyState title="Job not found" />;
  return (
    <Card className="flex flex-1 flex-col overflow-hidden">
      <CardHeader>
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <CardTitle className="truncate text-base">{job.name}</CardTitle>
            <CardDescription className="font-mono text-[11px]">{job.id} · every {job.intervalSeconds}s</CardDescription>
          </div>
          <StatusPill value={job.status} />
        </div>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden">
        <Tabs defaultValue="overview" className="flex h-full flex-col overflow-hidden">
          <TabsList className="self-start">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="runs">Runs ({runs.length})</TabsTrigger>
            <TabsTrigger value="prompt">Prompt</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="flex-1 overflow-hidden">
            <ScrollArea className="h-full pr-3">
              <div className="space-y-4 pb-6">
                <div className="grid gap-2 text-xs sm:grid-cols-2">
                  <KV label="Last run" value={job.lastRunAt ? new Date(job.lastRunAt).toLocaleString() : "—"} />
                  <KV label="Next run" value={job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : "—"} />
                  <KV label="Last success" value={job.lastSuccessAt ? new Date(job.lastSuccessAt).toLocaleString() : "—"} />
                  <KV label="Last failure" value={job.lastFailureAt ? new Date(job.lastFailureAt).toLocaleString() : "—"} />
                  <KV label="Run count" value={String(job.runCount)} />
                  <KV label="Missed runs" value={String(job.missedRuns)} />
                  <KV label="Retry limit" value={String(job.retryLimit ?? "—")} />
                  <KV label="Timeout" value={`${job.timeoutSeconds ?? "—"}s`} />
                  {typeof job.costBudget === "number" ? <KV label="Cost budget" value={`$${job.costBudget.toFixed(2)}`} /> : null}
                </div>
                {(job.deliveryTargets?.length ?? 0) > 0 ? (
                  <Section title="Delivery targets">
                    <ul className="flex flex-wrap gap-1">
                      {job.deliveryTargets.map((target) => (
                        <li key={target} className="rounded-md border border-border bg-card/50 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                          {target}
                        </li>
                      ))}
                    </ul>
                  </Section>
                ) : null}
                {(job.context?.length ?? 0) > 0 ? (
                  <Section title="Context">
                    <ul className="flex flex-wrap gap-1">
                      {job.context.map((c) => (
                        <li key={c} className="rounded-md border border-border bg-card/50 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                          {c}
                        </li>
                      ))}
                    </ul>
                  </Section>
                ) : null}
                {job.lastError ? (
                  <Section title="Last error">
                    <pre className="whitespace-pre-wrap text-xs text-red-400">{job.lastError}</pre>
                  </Section>
                ) : null}
              </div>
            </ScrollArea>
          </TabsContent>
          <TabsContent value="runs" className="flex-1 overflow-hidden">
            <ScrollArea className="h-full pr-3">
              {runs.length === 0 ? (
                <EmptyState title="No runs yet" />
              ) : (
                <RunList runs={runs} replayPending={replayPending} onReplay={onReplay} />
              )}
            </ScrollArea>
          </TabsContent>
          <TabsContent value="prompt" className="flex-1 overflow-hidden">
            <ScrollArea className="h-full pr-3">
              <Section title="Prompt">
                <pre className="whitespace-pre-wrap rounded-md border border-border bg-card/50 p-3 font-mono text-xs">{job.prompt}</pre>
              </Section>
              {job.script ? (
                <div className="mt-4">
                  <Section title="Script">
                    <pre className="whitespace-pre-wrap rounded-md border border-border bg-card/50 p-3 font-mono text-xs">{job.script}</pre>
                  </Section>
                </div>
              ) : null}
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function RunList({
  runs,
  replayPending,
  onReplay
}: {
  runs: JobRunRecord[];
  replayPending: boolean;
  onReplay: (id: string) => void;
}) {
  return (
    <ul className="space-y-2 pb-6">
      {runs.slice().reverse().map((run) => (
        <li key={run.id} className="rounded-md border border-border bg-card/50 px-3 py-2">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <p className="font-mono text-[11px]">{run.id}</p>
              <p className="text-[11px] text-muted-foreground">
                {run.trigger} · attempt {run.attempt} · {new Date(run.createdAt).toLocaleString()}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <StatusPill value={run.status} />
              <Button size="sm" variant="outline" disabled={replayPending} onClick={() => onReplay(run.id)}>Replay</Button>
            </div>
          </div>
          {run.summary ? <p className="mt-1 text-xs">{run.summary}</p> : null}
          {run.error ? <p className="mt-1 text-xs text-red-400">{run.error}</p> : null}
          {run.taskId ? <RunTaskLink taskId={run.taskId} /> : null}
          {run.cost ? (
            <p className="mt-1 font-mono text-[10px] text-muted-foreground">
              cost: {run.cost.provider}/{run.cost.model}
              {typeof run.cost.totalTokens === "number" ? ` · ${run.cost.totalTokens.toLocaleString()} tokens` : ""}
              {typeof run.cost.estimatedUsd === "number" ? ` · $${run.cost.estimatedUsd.toFixed(4)}` : ""}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function RunTaskLink({ taskId }: { taskId: string }) {
  // Pulls the task summary so the run row links to a useful preview rather than
  // a bare id. We poll on the same cadence as the runs list so it self-refreshes
  // while a task moves from running → completed.
  const task = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => api<{ task: Task }>(`/tasks/${taskId}`),
    enabled: Boolean(taskId),
    refetchInterval: 5000
  });
  return (
    <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
      task {taskId}
      {task.data?.task?.status ? ` · ${task.data.task.status}` : ""}
    </p>
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

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="truncate font-mono text-xs">{value}</p>
    </div>
  );
}
