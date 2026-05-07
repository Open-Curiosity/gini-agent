import type { AuditEvent, RuntimeEvent, RuntimeState } from "../types";
import { id, now } from "./ids";

export function appendEvent(
  state: RuntimeState,
  event: Omit<RuntimeEvent, "id" | "lane" | "at">
): RuntimeEvent {
  const item: RuntimeEvent = {
    id: id("event"),
    lane: state.lane,
    at: now(),
    ...event
  };
  state.events.unshift(item);
  state.events = state.events.slice(0, 1000);
  return item;
}

export function addAudit(
  state: RuntimeState,
  event: Omit<AuditEvent, "id" | "lane" | "at">
): AuditEvent {
  const audit: AuditEvent = {
    id: id("audit"),
    lane: state.lane,
    at: now(),
    ...event
  };
  state.audit.unshift(audit);
  appendEvent(state, {
    kind: "runtime",
    action: audit.action,
    target: audit.target,
    taskId: audit.taskId,
    risk: audit.risk,
    summary: audit.action,
    data: audit.evidence
  });
  return audit;
}
