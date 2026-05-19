import type { AuditEvent, RuntimeEvent, RuntimeState } from "../types";
import { id, now } from "./ids";

// Infer the originating agent from a record linked to the event/audit row.
// Order of fallback: explicit caller value -> task.agentId -> the runtime's
// currently active agent. Returns undefined when no source resolves, which
// preserves the "system / unattributable" case.
function inferAgentId(
  state: RuntimeState,
  explicit: string | undefined,
  taskId: string | undefined
): string | undefined {
  if (explicit) return explicit;
  if (taskId) {
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (task?.agentId) return task.agentId;
  }
  return state.activeAgentId;
}

export function appendEvent(
  state: RuntimeState,
  event: Omit<RuntimeEvent, "id" | "instance" | "at">
): RuntimeEvent {
  const item: RuntimeEvent = {
    id: id("event"),
    instance: state.instance,
    at: now(),
    ...event,
    agentId: inferAgentId(state, event.agentId, event.taskId)
  };
  state.events.unshift(item);
  state.events = state.events.slice(0, 1000);
  return item;
}

export function addAudit(
  state: RuntimeState,
  event: Omit<AuditEvent, "id" | "instance" | "at">
): AuditEvent {
  const audit: AuditEvent = {
    id: id("audit"),
    instance: state.instance,
    at: now(),
    ...event,
    agentId: inferAgentId(state, event.agentId, event.taskId)
  };
  state.audit.unshift(audit);
  appendEvent(state, {
    kind: "runtime",
    action: audit.action,
    target: audit.target,
    taskId: audit.taskId,
    runId: audit.runId,
    risk: audit.risk,
    summary: audit.action,
    data: audit.evidence,
    agentId: audit.agentId
  });
  return audit;
}
