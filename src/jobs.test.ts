// Cron lifecycle tests. Pairs with src/http.test.ts (kept untouched) — same
// helpers, separate file to keep concerns siloed.
//
// What these cover (Plan B from the cron-hardening context):
// - paused jobs are not picked up by the scheduler tick
// - drift-free nextRunAt advance + missedRuns increment
// - overlap protection: a second scheduled run is skipped while the first
//   is still in-flight
// - prompt-job runs finalize asynchronously when the spawned task settles
// - manual run does not implicitly resume a paused job
// - removeJob cascade-deletes the JobRunRecords
// - replay against a removed job returns 404
// - intervalSeconds validation surfaces 400

import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createHandler } from "./http";
import { runDueJobs, runJobNow } from "./jobs";
import { mutateState, readState } from "./state";
import type { RuntimeConfig } from "./types";

describe("cron lifecycle", () => {
  test("scheduler skips paused jobs even when they're due", async () => {
    const config = testConfig("jobs-paused");
    const handler = createHandler(config);

    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "paused job", script: "echo ok", intervalSeconds: 1 })
    });
    await call(handler, config, `/api/jobs/${job.id}/pause`, { method: "POST" });

    // Force the job to be due in the past so the only thing keeping it
    // from running is its paused status.
    await mutateState(config.instance, (state) => {
      const item = state.jobs.find((candidate) => candidate.id === job.id);
      if (!item) throw new Error("setup: job missing");
      item.nextRunAt = new Date(Date.now() - 5_000).toISOString();
    });

    await runDueJobs(config);
    const runs = readState(config.instance).jobRuns.filter((run) => run.jobId === job.id);
    expect(runs).toHaveLength(0);
  });

  test("runDueJobs advances nextRunAt drift-free and increments missedRuns", async () => {
    const config = testConfig("jobs-drift");
    const handler = createHandler(config);

    // intervalSeconds=10, set nextRunAt 25s in the past => the loop should
    // consume one interval (the run we claim) and skip 2 more, landing on
    // 5s in the future (3 total advances from -25 = +5). missedRuns counts
    // the *extra* skipped intervals (the consumed one is not a "miss").
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "drift job", script: "true", intervalSeconds: 10 })
    });
    const setupNow = Date.now();
    const dueAt = setupNow - 25_000;
    await mutateState(config.instance, (state) => {
      const item = state.jobs.find((candidate) => candidate.id === job.id);
      if (!item) throw new Error("setup: job missing");
      item.nextRunAt = new Date(dueAt).toISOString();
    });

    await runDueJobs(config);

    const after = readState(config.instance);
    const updated = after.jobs.find((candidate) => candidate.id === job.id)!;
    const runs = after.jobRuns.filter((run) => run.jobId === job.id);
    expect(runs).toHaveLength(1);
    // The advance loop walks: dueAt + 10s = -15s (still due, miss), -15 + 10
    // = -5s (still due, miss), -5 + 10 = +5s (future, stop). So missedRuns
    // should jump by 2 (the two extra advances).
    expect(updated.missedRuns).toBe(2);
    const newNextMs = new Date(updated.nextRunAt).getTime();
    expect(newNextMs).toBeGreaterThan(setupNow);
    // Sanity: the new nextRunAt must be on the original cadence — i.e.
    // (newNext - originalDue) is a positive multiple of the interval.
    const stepMs = 10_000;
    const delta = newNextMs - dueAt;
    expect(delta % stepMs).toBe(0);
    expect(delta / stepMs).toBe(3);
  });

  test("overlap protection: a second scheduled run is skipped while the first is in flight", async () => {
    const config = testConfig("jobs-overlap");
    const handler = createHandler(config);

    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      // sleep 1 keeps the first run "running" while we try to claim a
      // second one. A bare `sleep 1` is enough on any Bun-supported host.
      body: JSON.stringify({ name: "overlap job", script: "sleep 1", intervalSeconds: 60, timeoutSeconds: 5 })
    });

    // Inject a fake running JobRunRecord directly so we don't have to race
    // a real `sleep 1`. The runJobNow with trigger=schedule must observe
    // the in-flight run and refuse to start a second one.
    await mutateState(config.instance, (state) => {
      state.jobRuns.unshift({
        id: "jobrun_overlap_test",
        instance: state.instance,
        jobId: job.id,
        status: "running",
        attempt: 1,
        trigger: "schedule",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    });

    const result = await runJobNow(config, job.id, "schedule");
    expect(result).toBeUndefined();
    const runs = readState(config.instance).jobRuns.filter((run) => run.jobId === job.id);
    // Still just the one fake "running" run we injected — no new run.
    expect(runs.filter((run) => run.id !== "jobrun_overlap_test")).toHaveLength(0);
    // And the runtime audited the skip.
    const audit = readState(config.instance).audit.find((event) => event.action === "job.run.skipped_overlap" && event.target === job.id);
    expect(audit).toBeDefined();
  });

  test("prompt-job run finalizes asynchronously when the task settles", async () => {
    const config = testConfig("jobs-async-prompt");
    const handler = createHandler(config);

    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "prompt job", prompt: "summarize today", intervalSeconds: 60 })
    });
    const result = await call(handler, config, `/api/jobs/${job.id}/run`, { method: "POST" });
    expect(result.taskId).toBeString();
    expect(result.runId).toBeString();

    // Run should be `running` immediately after submitTask returns — the
    // finalize step waits for the spawned task to settle.
    const inFlight = readState(config.instance).jobRuns.find((run) => run.id === result.runId);
    expect(inFlight?.status).toBe("running");
    expect(inFlight?.taskId).toBe(result.taskId);

    await waitForTask(handler, config, result.taskId);
    // Give the finalize hook a beat to land — runTask awaits the
    // finalizer before returning, but the task watcher polls on its own.
    await waitFor(() => readState(config.instance).jobRuns.find((run) => run.id === result.runId)?.status === "completed", 2_000);

    const settled = readState(config.instance).jobRuns.find((run) => run.id === result.runId);
    expect(settled?.status).toBe("completed");
    const settledJob = readState(config.instance).jobs.find((candidate) => candidate.id === job.id);
    expect(settledJob?.lastSuccessAt).toBeString();
  });

  test("manual run does not resume a paused job", async () => {
    const config = testConfig("jobs-manual-paused");
    const handler = createHandler(config);

    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "paused-manual", script: "echo manual", intervalSeconds: 60 })
    });
    await call(handler, config, `/api/jobs/${job.id}/pause`, { method: "POST" });
    const result = await call(handler, config, `/api/jobs/${job.id}/run`, { method: "POST" });
    expect(result.exitCode).toBe(0);

    const after = readState(config.instance).jobs.find((candidate) => candidate.id === job.id);
    expect(after?.status).toBe("paused");
  });

  test("removeJob cascades JobRunRecord deletion", async () => {
    const config = testConfig("jobs-remove-cascade");
    const handler = createHandler(config);

    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "cascade", script: "echo cascade", intervalSeconds: 60 })
    });
    const runResult = await call(handler, config, `/api/jobs/${job.id}/run`, { method: "POST" });
    expect(runResult.exitCode).toBe(0);

    // Sanity: a run exists.
    const beforeRuns = readState(config.instance).jobRuns.filter((run) => run.jobId === job.id);
    expect(beforeRuns.length).toBeGreaterThanOrEqual(1);

    await call(handler, config, `/api/jobs/${job.id}`, { method: "DELETE" });

    const afterRuns = readState(config.instance).jobRuns.filter((run) => run.jobId === job.id);
    expect(afterRuns).toHaveLength(0);
    // The /api/job-runs listing also shouldn't include them.
    const allRuns = await call(handler, config, "/api/job-runs");
    expect(allRuns.filter((run: { jobId: string }) => run.jobId === job.id)).toHaveLength(0);
  });

  test("replay after the underlying job was removed returns 404", async () => {
    const config = testConfig("jobs-replay-404");
    const handler = createHandler(config);

    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "replay-404", script: "echo gone", intervalSeconds: 60 })
    });
    const runResult = await call(handler, config, `/api/jobs/${job.id}/run`, { method: "POST" });
    // Capture the runId before we cascade-delete, then resurrect it as a
    // dangling row (state migrated from an older version had this shape).
    const runId = runResult.runId;
    expect(runId).toBeString();

    await call(handler, config, `/api/jobs/${job.id}`, { method: "DELETE" });

    // After removeJob the run is gone — but to test the "job vanished"
    // path of replayJobRun specifically, we re-insert a dangling run
    // record pointing at the removed job. This simulates older data
    // shapes (cron-hardening context says this used to be possible).
    await mutateState(config.instance, (state) => {
      state.jobRuns.unshift({
        id: runId,
        instance: state.instance,
        jobId: job.id,
        status: "completed",
        attempt: 1,
        trigger: "schedule",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    });

    const response = await rawCall(handler, config, `/api/job-runs/${runId}/replay`, { method: "POST" });
    expect(response.status).toBe(404);
  });

  test("invalid intervalSeconds returns 400", async () => {
    const config = testConfig("jobs-validation");
    const handler = createHandler(config);

    const negative = await rawCall(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "bad", intervalSeconds: -5 })
    });
    expect(negative.status).toBe(400);

    const nan = await rawCall(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "bad", intervalSeconds: Number.NaN })
    });
    // JSON.stringify turns NaN into null, which Number(...) rejects via
    // the assertPositiveInt validator. Either way we expect 400.
    expect(nan.status).toBe(400);
  });
});

async function call(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, path: string, init: RequestInit = {}) {
  return callWithToken(handler, config, config.token, path, init);
}

async function callWithToken(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, token: string, path: string, init: RequestInit = {}) {
  const response = await rawCall(handler, config, path, init, token);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}

async function rawCall(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, path: string, init: RequestInit = {}, token?: string) {
  const auth = token ?? config.token;
  const response = await handler(new Request(`http://127.0.0.1:${config.port}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${auth}`, ...(init.headers ?? {}) }
  }));
  return response;
}

function testConfig(instance: string): RuntimeConfig {
  const root = "/tmp/gini-jobs-tests";
  process.env.GINI_STATE_ROOT = root;
  process.env.GINI_LOG_ROOT = `${root}-logs`;
  rmSync(`${root}/instances/${instance}`, { recursive: true, force: true });
  return {
    instance,
    port: 7338,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: `${root}/instances/${instance}`,
    logRoot: `${root}-logs/${instance}`
  };
}

async function waitForTask(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, taskId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const detail = await call(handler, config, `/api/tasks/${taskId}`);
    if (["completed", "failed", "waiting_approval", "cancelled"].includes(detail.task.status)) return detail;
    await Bun.sleep(10);
  }
  throw new Error(`Task did not settle: ${taskId}`);
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  if (!predicate()) throw new Error("waitFor: predicate never became true");
}
