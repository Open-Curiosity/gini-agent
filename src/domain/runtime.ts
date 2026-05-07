import { rmSync, writeFileSync } from "node:fs";
import type { RuntimeConfig } from "../types";
import { configPath } from "../paths";
import { readState, taskCounts } from "../state";
import { providerHealth } from "../provider";

export function status(config: RuntimeConfig) {
  const state = readState(config.lane);
  const missedJobs = state.jobs.filter((job) => job.status === "active" && new Date(job.nextRunAt).getTime() + job.intervalSeconds * 1000 < Date.now()).length;
  return {
    ok: true,
    lane: config.lane,
    port: config.port,
    stateRoot: config.stateRoot,
    workspaceRoot: config.workspaceRoot,
    pid: process.pid,
    taskCounts: taskCounts(state.tasks),
    pendingApprovals: state.approvals.filter((approval) => approval.status === "pending").length,
    activeJobs: state.jobs.filter((job) => job.status === "active").length,
    missedJobs,
    connectors: state.connectors.length,
    provider: providerHealth(config)
  };
}

export function install(config: RuntimeConfig): void {
  writeFileSync(configPath(config.lane), `${JSON.stringify(config, null, 2)}\n`);
  readState(config.lane);
}

export function resetLane(config: RuntimeConfig): void {
  rmSync(config.stateRoot, { recursive: true, force: true });
  install(config);
}
