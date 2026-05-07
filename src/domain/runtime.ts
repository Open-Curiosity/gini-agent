import { existsSync, rmSync, writeFileSync } from "node:fs";
import type { RuntimeConfig } from "../types";
import { configPath, ensureDir, laneRoot } from "../paths";
import { readState, taskCounts } from "../state";
import { closeMemoryDb, getMemoryDb, memoryDbPath } from "../state/memory-db";
import { providerHealth } from "../provider";

export function status(config: RuntimeConfig) {
  const state = readState(config.lane);
  const missedJobs = state.jobs.filter((job) => job.status === "active" && new Date(job.nextRunAt).getTime() + job.intervalSeconds * 1000 < Date.now()).length;
  // Memory DB probe is best-effort: a fresh lane will have 0 units. We don't
  // open the DB here unless one already exists on disk to avoid creating an
  // empty memory.db side-effect from a read-only status call.
  const memoryUnits = countMemoryUnitsIfPresent(config);
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
    memoryUnits,
    provider: providerHealth(config)
  };
}

function countMemoryUnitsIfPresent(config: RuntimeConfig): number {
  // Skip the open if no DB exists yet — a fresh lane reports 0 units without
  // creating an empty memory.db as a side effect of a read-only status call.
  // Returning 0 on any error keeps `gini status` resilient; doctor surfaces
  // deeper diagnostics via probeMemoryDb.
  try {
    if (!existsSync(memoryDbPath(config.lane))) return 0;
    const db = getMemoryDb(config.lane);
    const row = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM memory_units")
      .get();
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

export function install(config: RuntimeConfig): void {
  // After resetLane removes the lane root, the directory is gone. Ensure it
  // before writing the config so reinstall is a clean idempotent operation.
  ensureDir(laneRoot(config.lane));
  writeFileSync(configPath(config.lane), `${JSON.stringify(config, null, 2)}\n`);
  readState(config.lane);
}

export function resetLane(config: RuntimeConfig): void {
  // Close the cached memory DB handle (if any) before removing the state
  // root so we release the WAL/SHM file descriptors. Without this, the
  // physical files would still be unlinked but a subsequent getMemoryDb()
  // could hand back the closed handle from the cache.
  closeMemoryDb(config.lane);
  rmSync(config.stateRoot, { recursive: true, force: true });
  install(config);
}
