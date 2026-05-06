import type { RuntimeConfig } from "../types";
import { addAudit, createMemory, mutateState, now } from "../state";

export function createMemoryFromInput(config: RuntimeConfig, input: Record<string, unknown>) {
  return mutateState(config.lane, (state) => createMemory(state, {
    content: String(input.content ?? ""),
    scope: "project",
    confidence: 1,
    status: String(input.status ?? "active") === "proposed" ? "proposed" : "active",
    sensitivity: "normal",
    provenance: "Created by user"
  }));
}

export function updateMemory(config: RuntimeConfig, memoryId: string, statusValue: "active" | "rejected") {
  return mutateState(config.lane, (state) => {
    const memory = state.memories.find((candidate) => candidate.id === memoryId);
    if (!memory) throw new Error(`Memory not found: ${memoryId}`);
    memory.status = statusValue;
    memory.updatedAt = now();
    addAudit(state, {
      actor: "user",
      action: `memory.${statusValue === "active" ? "approved" : "rejected"}`,
      target: memoryId,
      risk: "medium",
      taskId: memory.sourceTaskId
    });
    return memory;
  });
}
