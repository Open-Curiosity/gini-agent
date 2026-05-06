"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader, EmptyState } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";
import { useInvalidate, useJobRuns, useJobs } from "@/lib/queries";
import type { JobRecord, JobRunRecord } from "@/lib/types";

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
      <div className="flex flex-1 gap-4 overflow-hidden p-6">
        <div className="flex w-96 flex-col gap-2 overflow-auto">
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

        <div className="flex-1 overflow-auto">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Run history {selected ? "" : "(all)"}</CardTitle>
              <CardDescription>{selected ?? "Select a job to filter"}</CardDescription>
            </CardHeader>
            <CardContent>
              {(runs.data ?? []).length === 0 ? (
                <EmptyState title="No runs yet" />
              ) : (
                <ul className="space-y-2">
                  {(runs.data ?? []).slice().reverse().map((run) => (
                    <li key={run.id} className="rounded-md border border-border bg-card/50 px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-mono text-[11px]">{run.id}</p>
                          <p className="text-[11px] text-muted-foreground">
                            {run.trigger} · attempt {run.attempt} · {new Date(run.createdAt).toLocaleString()}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <StatusPill value={run.status} />
                          <Button size="sm" variant="outline" disabled={replay.isPending} onClick={() => replay.mutate(run.id)}>Replay</Button>
                        </div>
                      </div>
                      {run.summary ? <p className="mt-1 text-xs">{run.summary}</p> : null}
                      {run.error ? <p className="mt-1 text-xs text-red-400">{run.error}</p> : null}
                      {run.taskId ? <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">task {run.taskId}</p> : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
