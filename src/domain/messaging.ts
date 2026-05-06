import type { RuntimeConfig } from "../types";
import { addAudit, createMessagingBridgeRecord, mutateState, now } from "../state";

export function addMessagingBridge(config: RuntimeConfig, input: Record<string, unknown>) {
  const name = String(input.name ?? "");
  const kind = String(input.kind ?? "demo");
  if (!name) throw new Error("Messaging bridge name is required.");
  return mutateState(config.lane, (state) => createMessagingBridgeRecord(state, {
    name,
    kind,
    deliveryTargets: Array.isArray(input.deliveryTargets) ? input.deliveryTargets.map(String) : []
  }));
}

export function checkMessagingBridge(config: RuntimeConfig, idOrName: string) {
  return mutateState(config.lane, (state) => {
    const bridge = state.messagingBridges.find((item) => item.id === idOrName || item.name === idOrName);
    if (!bridge) throw new Error(`Messaging bridge not found: ${idOrName}`);
    bridge.lastHealthAt = now();
    bridge.message = bridge.kind === "demo"
      ? "Demo messaging bridge is available for local notifications."
      : "Bridge record is configured. Live platform delivery is deferred until the messaging transport slice.";
    bridge.updatedAt = bridge.lastHealthAt;
    addAudit(state, {
      actor: "runtime",
      action: "messaging.health",
      target: bridge.id,
      risk: "low",
      evidence: { kind: bridge.kind, status: bridge.status }
    });
    return bridge;
  });
}

export function disableMessagingBridge(config: RuntimeConfig, idOrName: string) {
  return mutateState(config.lane, (state) => {
    const bridge = state.messagingBridges.find((item) => item.id === idOrName || item.name === idOrName);
    if (!bridge) throw new Error(`Messaging bridge not found: ${idOrName}`);
    bridge.status = "disabled";
    bridge.updatedAt = now();
    addAudit(state, { actor: "user", action: "messaging.disabled", target: bridge.id, risk: "medium" });
    return bridge;
  });
}
