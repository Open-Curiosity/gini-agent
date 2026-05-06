import { submitTask } from "../agent";
import type { RuntimeConfig } from "../types";
import { addAudit, appendTrace, createJob, mutateState, now } from "../state";

export function createScheduledJob(config: RuntimeConfig, input: Record<string, unknown>) {
  const intervalSeconds = Math.max(1, Number(input.intervalSeconds ?? 60));
  return mutateState(config.lane, (state) => createJob(state, {
    name: String(input.name ?? "Untitled job"),
    prompt: String(input.prompt ?? ""),
    intervalSeconds,
    nextRunAt: new Date(Date.now() + intervalSeconds * 1000).toISOString()
  }));
}

export function runDueJobs(config: RuntimeConfig): void {
  const due = mutateState(config.lane, (state) => {
    const dateNow = Date.now();
    return state.jobs.filter((job) => job.status === "active" && new Date(job.nextRunAt).getTime() <= dateNow);
  });
  for (const job of due) runJobNow(config, job.id);
}

export function runJobNow(config: RuntimeConfig, jobId: string) {
  const job = mutateState(config.lane, (state) => {
    const item = state.jobs.find((candidate) => candidate.id === jobId);
    if (!item) throw new Error(`Job not found: ${jobId}`);
    item.lastRunAt = now();
    item.runCount += 1;
    item.nextRunAt = new Date(Date.now() + item.intervalSeconds * 1000).toISOString();
    item.updatedAt = now();
    return item;
  });
  const task = submitTask(config, job.prompt, job.id);
  mutateState(config.lane, (state) => {
    const item = state.jobs.find((candidate) => candidate.id === job.id);
    if (!item) return;
    item.taskIds.unshift(task.id);
    item.lastSuccessAt = now();
    item.lastError = undefined;
    item.status = "active";
  });
  appendTrace(config.lane, task.id, { type: "job", message: "Job spawned task", data: { jobId } });
  return { jobId, taskId: task.id };
}

export function updateJobStatus(config: RuntimeConfig, jobId: string, statusValue: "active" | "paused") {
  return mutateState(config.lane, (state) => {
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    job.status = statusValue;
    job.updatedAt = now();
    addAudit(state, {
      actor: "user",
      action: `job.${statusValue}`,
      target: jobId,
      risk: "low"
    });
    return job;
  });
}
