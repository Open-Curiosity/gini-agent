export type TaskStatus = "queued" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";
export type ApprovalStatus = "pending" | "approved" | "denied";
export type RiskLevel = "low" | "medium" | "high";
export type MemoryStatus = "proposed" | "active" | "archived" | "rejected" | "conflicted";
export type SkillStatus = "draft" | "trusted" | "disabled" | "archived";
export type JobStatus = "active" | "paused" | "failed";
export type ImprovementStatus = "proposed" | "approved" | "rejected" | "applied";
export type ImprovementKind = "memory" | "skill" | "job";
export type ProviderName = "echo" | "openai" | "codex" | "openrouter" | "local";

export interface CostRecord {
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedUsd?: number;
}

export interface Task {
  id: string;
  title: string;
  input: string;
  status: TaskStatus;
  lane: string;
  createdAt: string;
  updatedAt: string;
  currentStep?: string;
  summary?: string;
  error?: string;
  tracePath: string;
  auditIds: string[];
  approvalIds: string[];
  memoryIds: string[];
  skillIds: string[];
  jobId?: string;
  parentTaskId?: string;
  subagentId?: string;
  cost?: CostRecord;
}

export interface Approval {
  id: string;
  status: ApprovalStatus;
  createdAt: string;
  updatedAt: string;
  taskId?: string;
  action: "file.write" | "file.patch" | "terminal.exec" | "memory.activate" | "skill.trust" | "connector.enable";
  target: string;
  risk: RiskLevel;
  reason: string;
  payload: Record<string, unknown>;
}

export interface MemoryRecord {
  id: string;
  content: string;
  scope: "user" | "project" | "device" | "temporary";
  sourceTaskId?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  confidence: number;
  status: MemoryStatus;
  sensitivity: "normal" | "sensitive";
  provenance: string;
}

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  trigger: string;
  steps: string[];
  status: SkillStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  successCount: number;
  failureCount: number;
  lastUsedAt?: string;
  sourceTaskId?: string;
  tests: string[];
  previousVersions: Array<{ version: number; updatedAt: string; description: string; trigger: string; steps: string[] }>;
}

export interface JobRecord {
  id: string;
  name: string;
  prompt: string;
  script?: string;
  intervalSeconds: number;
  status: JobStatus;
  deliveryTargets: string[];
  context: string[];
  retryLimit: number;
  timeoutSeconds: number;
  costBudget?: number;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  nextRunAt: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastError?: string;
  runCount: number;
  missedRuns: number;
  taskIds: string[];
  runIds: string[];
}

export interface JobRunRecord {
  id: string;
  jobId: string;
  status: "running" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  taskId?: string;
  attempt: number;
  trigger: "schedule" | "manual" | "replay";
  summary?: string;
  error?: string;
  cost?: CostRecord;
}

export interface ConnectorRecord {
  id: string;
  name: string;
  kind: string;
  status: "configured" | "disabled" | "error";
  scopes: string[];
  createdAt: string;
  updatedAt: string;
  lastHealthAt?: string;
  health: "unknown" | "healthy" | "unhealthy";
  message?: string;
}

export interface RuntimeStatus {
  ok: boolean;
  lane: string;
  port: number;
  taskCounts: Record<TaskStatus, number>;
  pendingApprovals: number;
  activeJobs: number;
  missedJobs: number;
  connectors: number;
}

// Mirrors src/types.ts RuntimeEventKind. Kept in sync with useRuntimeStream's
// EVENT_KINDS list — both are dispatched by the runtime as named SSE events.
export type RuntimeEventKind =
  | "task"
  | "approval"
  | "job"
  | "memory"
  | "skill"
  | "connector"
  | "mcp"
  | "messaging"
  | "provider"
  | "runtime"
  | "notification";

export interface RuntimeEvent {
  id: string;
  at: string;
  kind: RuntimeEventKind | string;
  action: string;
  target: string;
  taskId?: string;
  jobId?: string;
  risk: RiskLevel;
  summary: string;
  data?: Record<string, unknown>;
}

export interface AuditEvent {
  id: string;
  at: string;
  actor: "user" | "runtime" | "agent" | "system";
  action: string;
  target: string;
  risk: RiskLevel;
  taskId?: string;
  approvalId?: string;
  evidence?: Record<string, unknown>;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageIds: string[];
  taskIds: string[];
  summary?: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  taskId?: string;
}

export interface ImprovementProposal {
  id: string;
  kind: ImprovementKind;
  status: ImprovementStatus;
  title: string;
  rationale: string;
  sourceTaskId?: string;
  sourceTraceIds: string[];
  payload: Record<string, unknown>;
  appliedTargetId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PairedDevice {
  id: string;
  name: string;
  status: "active" | "revoked";
  scopes: string[];
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string;
}

export interface RuntimeStateSnapshot {
  lane: string;
  tasks: Task[];
  approvals: Approval[];
  audit: AuditEvent[];
  memories: MemoryRecord[];
  skills: SkillRecord[];
  jobs: JobRecord[];
  connectors: ConnectorRecord[];
  improvements: ImprovementProposal[];
  devices: PairedDevice[];
  promotions: Array<{ id: string; status: string; candidateRef: string; summary: string; rollbackPlan: string; evidencePath?: string; createdAt: string }>;
  toolsets: unknown[];
  subagents: unknown[];
  mcpServers: unknown[];
  messagingBridges: unknown[];
  messagingMessages: unknown[];
  importReports: unknown[];
  profiles: unknown[];
  activeProfileId?: string;
  relays: unknown[];
  notifications: unknown[];
  events: RuntimeEvent[];
  jobRuns: JobRunRecord[];
  chatSessions: ChatSession[];
  chatMessages: ChatMessage[];
  snapshots: unknown[];
}

export interface ParityCheck {
  id: string;
  label: string;
  status: "pass" | "partial" | "missing";
  evidence: string[];
  requiredForV1: boolean;
}

export interface ReadinessResult {
  ok: boolean;
  generatedAt: string;
  checks: Array<{ id: string; label: string; status: "pass" | "partial" | "missing"; evidence: string[]; requiredForV1: boolean }>;
}
