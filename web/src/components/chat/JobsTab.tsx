"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/PageHeader";
import { JobList } from "@/app/jobs/_components/JobList";
import { JobDetail } from "@/app/jobs/_components/JobDetail";
import { RunList } from "@/app/jobs/_components/RunList";
import { CalendarView } from "@/app/jobs/_components/calendar/calendar-view";
import { adaptJob, adaptRun } from "@/app/jobs/_components/calendar/types";
import { api } from "@/lib/api";
import { useInvalidate, useJobRuns, useJobs } from "@/lib/queries";
import type { JobRecord, JobRunRecord } from "@runtime/types";

// Per-agent Jobs tab — design `pu4J9` / `rkBjV`. A List ⇆ Calendar toggle
// (top-right) switches between the split-pane list and the calendar.
// `useJobs`/`useJobRuns` are already scoped to the active agent, so both
// surfaces show only this agent's jobs and runs.
export function JobsTab() {
  const jobs = useJobs();
  const [selected, setSelected] = useState<string | null>(null);
  const runs = useJobRuns(selected ?? undefined);
  // The calendar needs every run for this agent (across its jobs), not just
  // the selected job's. `useJobRuns()` resolves to `/job-runs` and is scoped
  // to the active agent like `useJobs`, so it stays consistent with the list.
  const allRuns = useJobRuns();
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

  const calendarJobs = (jobs.data ?? []).map(adaptJob);
  const calendarRuns = (allRuns.data ?? []).map(adaptRun);
  const calendarLoading = jobs.isLoading || allRuns.isLoading;
  const calendarError = jobs.error?.message ?? allRuns.error?.message ?? null;
  const handleCalendarRefresh = async () => {
    await Promise.all([jobs.refetch(), allRuns.refetch()]);
  };

  return (
    <Tabs defaultValue="list" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 justify-end px-4 pt-4 md:px-6">
        <TabsList>
          <TabsTrigger value="list">List</TabsTrigger>
          <TabsTrigger value="calendar">Calendar</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="list" className="min-h-0 flex-1 overflow-hidden">
        <div className="flex h-full gap-4 overflow-hidden p-4 md:p-6">
          <div className="flex w-full shrink-0 flex-col gap-2 overflow-auto md:w-80">
            <JobList
              jobs={jobs.data ?? []}
              selected={selected}
              actionPending={action.isPending}
              onSelect={setSelected}
              onAction={(id, op) => action.mutate({ id, op })}
            />
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
                      <RunList
                        runs={runs.data ?? []}
                        replayPending={replay.isPending}
                        onReplay={(id) => replay.mutate(id)}
                      />
                    )}
                  </ScrollArea>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </TabsContent>
      <TabsContent value="calendar" className="min-h-0 flex-1 overflow-hidden">
        <div className="flex h-full flex-col overflow-hidden p-4 md:p-6">
          <Card className="flex h-full flex-col overflow-hidden">
            <CalendarView
              status={{ enabled: true }}
              jobs={calendarJobs}
              runs={calendarRuns}
              loading={calendarLoading}
              error={calendarError}
              onRefresh={handleCalendarRefresh}
              highlightJobId={null}
            />
          </Card>
        </div>
      </TabsContent>
    </Tabs>
  );
}
