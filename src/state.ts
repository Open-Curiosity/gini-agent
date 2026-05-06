import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type {
  Approval,
  AuditEvent,
  ConnectorRecord,
  DeviceStatus,
  ImprovementProposal,
  JobRecord,
  Lane,
  MemoryRecord,
  PairedDevice,
  PairingCode,
  PairingStatus,
  PromotionProposal,
  RuntimeState,
  SkillRecord,
  SnapshotRecord,
  Task,
  TraceRecord
} from "./types";
import { ensureDir, laneRoot, logDir, statePath, traceDir } from "./paths";

export function now(): string {
  return new Date().toISOString();
}

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

export function createEmptyState(lane: Lane): RuntimeState {
  const at = now();
  return {
    version: 1,
    lane,
    createdAt: at,
    updatedAt: at,
    tasks: [],
    approvals: [],
    audit: [],
    memories: [],
    skills: [],
    jobs: [],
    connectors: [
      {
        id: "conn_demo",
        lane,
        name: "Demo Connector",
        kind: "demo",
        status: "configured",
        scopes: ["demo:read"],
        createdAt: at,
        updatedAt: at,
        health: "unknown"
      }
    ],
    improvements: [],
    pairingCodes: [],
    devices: [],
    promotions: [],
    snapshots: []
  };
}

export function readState(lane: Lane): RuntimeState {
  ensureDir(laneRoot(lane));
  const path = statePath(lane);
  if (!existsSync(path)) {
    const state = createEmptyState(lane);
    writeState(lane, state);
    return state;
  }
  const state = JSON.parse(readFileSync(path, "utf8")) as RuntimeState;
  return normalizeState(lane, state);
}

export function writeState(lane: Lane, state: RuntimeState): void {
  ensureDir(laneRoot(lane));
  state.updatedAt = now();
  const path = statePath(lane);
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tempPath, path);
}

export function mutateState<T>(lane: Lane, fn: (state: RuntimeState) => T): T {
  const state = readState(lane);
  const result = fn(state);
  writeState(lane, state);
  return result;
}

export function appendTrace(lane: Lane, taskId: string, record: Omit<TraceRecord, "id" | "taskId" | "lane" | "at">): TraceRecord {
  ensureDir(traceDir(lane));
  const trace: TraceRecord = {
    id: id("trace"),
    taskId,
    lane,
    at: now(),
    ...record
  };
  const path = tracePath(lane, taskId);
  const line = `${JSON.stringify(trace)}\n`;
  writeFileSync(path, line, { flag: "a" });
  return trace;
}

export function readTrace(lane: Lane, taskId: string): TraceRecord[] {
  const path = tracePath(lane, taskId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TraceRecord);
}

export function tracePath(lane: Lane, taskId: string): string {
  return join(traceDir(lane), `${taskId}.jsonl`);
}

export function appendLog(lane: Lane, message: string, data?: Record<string, unknown>): void {
  ensureDir(logDir(lane));
  writeFileSync(
    join(logDir(lane), "runtime.jsonl"),
    `${JSON.stringify({ at: now(), lane, message, data })}\n`,
    { flag: "a" }
  );
}

export function taskCounts(tasks: Task[]): Record<Task["status"], number> {
  return {
    queued: tasks.filter((task) => task.status === "queued").length,
    running: tasks.filter((task) => task.status === "running").length,
    waiting_approval: tasks.filter((task) => task.status === "waiting_approval").length,
    completed: tasks.filter((task) => task.status === "completed").length,
    failed: tasks.filter((task) => task.status === "failed").length,
    cancelled: tasks.filter((task) => task.status === "cancelled").length
  };
}

export function addAudit(state: RuntimeState, event: Omit<AuditEvent, "id" | "lane" | "at">): AuditEvent {
  const audit: AuditEvent = {
    id: id("audit"),
    lane: state.lane,
    at: now(),
    ...event
  };
  state.audit.unshift(audit);
  return audit;
}

export function upsertTask(state: RuntimeState, task: Task): Task {
  const index = state.tasks.findIndex((existing) => existing.id === task.id);
  if (index >= 0) state.tasks[index] = task;
  else state.tasks.unshift(task);
  return task;
}

export function createTask(lane: Lane, input: string, jobId?: string): Task {
  const at = now();
  const taskId = id("task");
  return {
    id: taskId,
    title: input.slice(0, 80) || "Untitled task",
    input,
    status: "queued",
    lane,
    createdAt: at,
    updatedAt: at,
    tracePath: tracePath(lane, taskId),
    auditIds: [],
    approvalIds: [],
    memoryIds: [],
    skillIds: [],
    jobId
  };
}

export function createApproval(state: RuntimeState, approval: Omit<Approval, "id" | "lane" | "status" | "createdAt" | "updatedAt">): Approval {
  const at = now();
  const item: Approval = {
    id: id("approval"),
    lane: state.lane,
    status: "pending",
    createdAt: at,
    updatedAt: at,
    ...approval
  };
  state.approvals.unshift(item);
  addAudit(state, {
    actor: "runtime",
    action: "approval.requested",
    target: item.target,
    risk: item.risk,
    taskId: item.taskId,
    approvalId: item.id,
    evidence: { action: item.action, reason: item.reason }
  });
  return item;
}

export function createMemory(state: RuntimeState, memory: Omit<MemoryRecord, "id" | "lane" | "createdAt" | "updatedAt">): MemoryRecord {
  const at = now();
  const item: MemoryRecord = {
    id: id("mem"),
    lane: state.lane,
    createdAt: at,
    updatedAt: at,
    ...memory
  };
  state.memories.unshift(item);
  return item;
}

export function createSkill(state: RuntimeState, skill: Omit<SkillRecord, "id" | "lane" | "createdAt" | "updatedAt" | "version">): SkillRecord {
  const at = now();
  const item: SkillRecord = {
    id: id("skill"),
    lane: state.lane,
    createdAt: at,
    updatedAt: at,
    version: 1,
    ...skill
  };
  state.skills.unshift(item);
  return item;
}

export function createJob(state: RuntimeState, job: Omit<JobRecord, "id" | "lane" | "createdAt" | "updatedAt" | "status" | "lastRunAt" | "lastSuccessAt" | "lastFailureAt" | "lastError" | "runCount" | "missedRuns" | "taskIds">): JobRecord {
  const at = now();
  const item: JobRecord = {
    id: id("job"),
    lane: state.lane,
    createdAt: at,
    updatedAt: at,
    status: "active",
    runCount: 0,
    missedRuns: 0,
    taskIds: [],
    ...job
  };
  state.jobs.unshift(item);
  return item;
}

export function createImprovementProposal(
  state: RuntimeState,
  proposal: Omit<ImprovementProposal, "id" | "lane" | "status" | "createdAt" | "updatedAt">
): ImprovementProposal {
  const at = now();
  const item: ImprovementProposal = {
    id: id("impr"),
    lane: state.lane,
    status: "proposed",
    createdAt: at,
    updatedAt: at,
    ...proposal
  };
  state.improvements.unshift(item);
  addAudit(state, {
    actor: "agent",
    action: "improvement.proposed",
    target: item.id,
    risk: "medium",
    taskId: item.sourceTaskId,
    evidence: { kind: item.kind, sourceTraceIds: item.sourceTraceIds }
  });
  return item;
}

export function createPairingCode(state: RuntimeState, ttlSeconds = 600): { pairing: PairingCode; code: string } {
  const at = now();
  const code = randomPairingCode();
  const pairing: PairingCode = {
    id: id("pair"),
    lane: state.lane,
    codeHash: hashSecret(code),
    status: "pending",
    createdAt: at,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString()
  };
  state.pairingCodes.unshift(pairing);
  addAudit(state, {
    actor: "user",
    action: "pairing.created",
    target: pairing.id,
    risk: "medium",
    evidence: { expiresAt: pairing.expiresAt }
  });
  return { pairing, code };
}

export function claimPairingCode(state: RuntimeState, code: string, deviceName: string): { device: PairedDevice; token: string } {
  expirePairingCodes(state);
  const codeHash = hashSecret(code);
  const pairing = state.pairingCodes.find((item) => item.codeHash === codeHash && item.status === "pending");
  if (!pairing) throw new Error("Pairing code is invalid or expired.");

  const at = now();
  const token = `gini_device_${crypto.randomUUID().replaceAll("-", "")}`;
  const device: PairedDevice = {
    id: id("device"),
    lane: state.lane,
    name: deviceName.trim() || "Unnamed device",
    tokenHash: hashSecret(token),
    status: "active",
    scopes: ["tasks:read", "tasks:write", "approvals:write", "state:read"],
    createdAt: at,
    updatedAt: at
  };
  pairing.status = "claimed";
  pairing.claimedAt = at;
  pairing.claimedByDeviceId = device.id;
  state.devices.unshift(device);
  addAudit(state, {
    actor: "user",
    action: "device.paired",
    target: device.id,
    risk: "medium",
    evidence: { pairingId: pairing.id, name: device.name, scopes: device.scopes }
  });
  return { device, token };
}

export function revokeDevice(state: RuntimeState, deviceId: string): PairedDevice {
  const device = state.devices.find((item) => item.id === deviceId);
  if (!device) throw new Error(`Device not found: ${deviceId}`);
  device.status = "revoked" satisfies DeviceStatus;
  device.updatedAt = now();
  device.revokedAt = device.updatedAt;
  addAudit(state, {
    actor: "user",
    action: "device.revoked",
    target: device.id,
    risk: "medium",
    evidence: { name: device.name }
  });
  return device;
}

export function findActiveDeviceByToken(state: RuntimeState, token: string): PairedDevice | undefined {
  const tokenHash = hashSecret(token);
  const device = state.devices.find((item) => item.tokenHash === tokenHash && item.status === "active");
  if (device) {
    device.lastSeenAt = now();
    device.updatedAt = device.lastSeenAt;
  }
  return device;
}

export function createPromotionProposal(
  state: RuntimeState,
  proposal: Omit<PromotionProposal, "id" | "lane" | "status" | "createdAt" | "updatedAt">
): PromotionProposal {
  const at = now();
  const item: PromotionProposal = {
    id: id("promo"),
    lane: state.lane,
    status: "proposed",
    createdAt: at,
    updatedAt: at,
    ...proposal
  };
  state.promotions.unshift(item);
  addAudit(state, {
    actor: "user",
    action: "promotion.proposed",
    target: item.id,
    risk: "medium",
    evidence: { candidateRef: item.candidateRef, evidencePath: item.evidencePath }
  });
  return item;
}

export function decidePromotion(state: RuntimeState, promotionId: string, decision: "approve" | "reject"): PromotionProposal {
  const promotion = state.promotions.find((item) => item.id === promotionId);
  if (!promotion) throw new Error(`Promotion proposal not found: ${promotionId}`);
  if (promotion.status !== "proposed") throw new Error(`Promotion proposal is already ${promotion.status}`);
  promotion.status = decision === "approve" ? "approved" : "rejected";
  promotion.decidedAt = now();
  promotion.updatedAt = promotion.decidedAt;
  addAudit(state, {
    actor: "user",
    action: `promotion.${promotion.status}`,
    target: promotion.id,
    risk: "medium",
    evidence: { candidateRef: promotion.candidateRef }
  });
  return promotion;
}

export function createSnapshotRecord(
  state: RuntimeState,
  snapshot: Omit<SnapshotRecord, "id" | "lane" | "createdAt" | "taskCount" | "auditCount">
): SnapshotRecord {
  const item: SnapshotRecord = {
    id: id("snap"),
    lane: state.lane,
    createdAt: now(),
    taskCount: state.tasks.length,
    auditCount: state.audit.length,
    ...snapshot
  };
  state.snapshots.unshift(item);
  addAudit(state, {
    actor: "user",
    action: "snapshot.created",
    target: item.id,
    risk: "medium",
    evidence: { path: item.path, reason: item.reason }
  });
  return item;
}

export function updateConnectorHealth(connector: ConnectorRecord): ConnectorRecord {
  connector.lastHealthAt = now();
  connector.health = connector.status === "configured" ? "healthy" : "unhealthy";
  connector.message = connector.kind === "demo" ? "Demo connector is available without secrets." : connector.message;
  connector.updatedAt = now();
  return connector;
}

export function assertInsideWorkspace(workspaceRoot: string, targetPath: string): string {
  const workspace = resolve(workspaceRoot);
  const target = resolve(workspaceRoot, targetPath);
  const rel = relative(workspace, target);
  if (rel.startsWith("..")) {
    throw new Error(`Path is outside workspace: ${targetPath}`);
  }
  return target;
}

function normalizeState(lane: Lane, state: RuntimeState): RuntimeState {
  state.lane = lane;
  state.improvements ??= [];
  state.connectors ??= [];
  state.tasks ??= [];
  state.approvals ??= [];
  state.audit ??= [];
  state.memories ??= [];
  state.skills ??= [];
  state.jobs ??= [];
  state.pairingCodes ??= [];
  state.devices ??= [];
  state.promotions ??= [];
  state.snapshots ??= [];
  expirePairingCodes(state);
  return state;
}

function expirePairingCodes(state: RuntimeState): void {
  const at = Date.now();
  for (const pairing of state.pairingCodes) {
    if (pairing.status === "pending" && new Date(pairing.expiresAt).getTime() <= at) {
      pairing.status = "expired" satisfies PairingStatus;
    }
  }
}

export function hashSecret(value: string): string {
  const digest = new Bun.CryptoHasher("sha256").update(value).digest("hex");
  return `sha256:${digest}`;
}

function randomPairingCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map((value) => String(value % 10))
    .join("")
    .replace(/^(.{3})(.{3})$/, "$1-$2");
}
