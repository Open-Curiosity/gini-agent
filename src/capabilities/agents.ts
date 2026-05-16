import type { RuntimeConfig } from "../types";
import {
  activateAgent,
  bankIdForAgent,
  createAgentRecord,
  deleteBankAndUnits,
  ensureAgentBank,
  mutateState,
  now,
  readState
} from "../state";
import { addAudit } from "../state/audit";
import { restartPoller } from "../integrations/messaging/telegram-registry";

export function listAgents(config: RuntimeConfig) {
  const state = readState(config.instance);
  return { activeAgentId: state.activeAgentId, agents: state.agents };
}

export async function createAgent(config: RuntimeConfig, input: Record<string, unknown>) {
  const name = String(input.name ?? "");
  if (!name) throw new Error("Agent name is required.");
  const record = await mutateState(config.instance, (state) => {
    // Config (provider, toolsets, memory scopes, messaging targets) is
    // copied from the default agent when the caller doesn't supply it.
    // The CLI doesn't pass these — without this fallback, new agents
    // ended up with undefined provider fields and silently fell through
    // to config.provider at runtime, contradicting the "agent owns
    // provider" design.
    //
    // Memory and hindsight content is NOT copied: agents start empty.
    // Only the *config* is inherited from the default agent.
    const defaultAgent = state.agents.find((agent) => agent.id === "agent_default");
    return createAgentRecord(state, {
      name,
      providerName: typeof input.providerName === "string"
        ? input.providerName as never
        : defaultAgent?.providerName,
      model: typeof input.model === "string"
        ? input.model
        : defaultAgent?.model,
      toolsets: Array.isArray(input.toolsets)
        ? input.toolsets.map(String)
        : (defaultAgent?.toolsets ?? ["file", "terminal", "memory", "session_search"]),
      messagingTargets: Array.isArray(input.messagingTargets)
        ? input.messagingTargets.map(String)
        : (defaultAgent?.messagingTargets ?? [])
    });
  });
  // Phase C — eagerly create the per-agent bank so the new agent starts
  // with an *empty* memory pool. Config copied at creation, content NOT:
  // there's no copying of memories or hindsight units from the default
  // agent or any other agent.
  ensureAgentBank(config.instance, record.id);
  return record;
}

export async function useAgent(config: RuntimeConfig, idOrName: string) {
  return mutateState(config.instance, (state) => activateAgent(state, idOrName));
}

// Hard-deletes an agent and cascades cleanup across its memory pools.
// Guards:
//   - The default agent (`agent_default`) cannot be deleted.
//   - The active agent cannot be deleted — the caller must switch first.
//   - Unknown agent id/name throws (mapped to 404 by the HTTP layer).
// Cascade:
//   - Per-agent Hindsight bank (`bank_${agentId}`) + all units in it.
//   - Legacy MemoryRecord rows where `agentId === <deletedAgentId>` are
//     hard-deleted. The owning agent is going away, so archiving them
//     serves no purpose.
//   - Telegram allowlist entries that pin this agent are dropped from
//     every bridge so a future inbound from those users no longer
//     stamps the stale agent id onto a Task (which would silently fall
//     back to the instance default per ADR agent-memory-isolation.md).
//   - The agent row is removed from `state.agents`.
// Returns counts so callers/tests can verify the cascade scope. A single
// audit event records the deletion + cleanup counts.
export async function deleteAgent(
  config: RuntimeConfig,
  idOrName: string
): Promise<{ ok: true; id: string; memoriesArchived: number; unitsDeleted: number; bankDeleted: boolean }> {
  const result = await mutateState(config.instance, (state) => {
    const agent = state.agents.find((item) => item.id === idOrName || item.name === idOrName);
    if (!agent) throw new Error(`Agent not found: ${idOrName}`);
    if (agent.id === "agent_default") {
      throw new Error("Cannot delete the default agent.");
    }
    if (state.activeAgentId === agent.id) {
      throw new Error("Cannot delete the active agent; switch to another agent first.");
    }
    const memoriesBefore = state.memories.length;
    state.memories = state.memories.filter((memory) => memory.agentId !== agent.id);
    const memoriesArchived = memoriesBefore - state.memories.length;

    // Telegram allowlist cascade. Walk every bridge with a telegram
    // config and drop entries that pinned the agent we're deleting.
    // Track affected bridge ids so we can restart their pollers below
    // (the poller re-reads the live allowlist each iteration, but a
    // restart makes the change observable in tests immediately).
    let messagingAllowlistEntriesRemoved = 0;
    const affectedBridgeIds: string[] = [];
    for (const bridge of state.messagingBridges) {
      if (bridge.kind !== "telegram" || !bridge.telegram) continue;
      const before = bridge.telegram.allowlist.length;
      bridge.telegram.allowlist = bridge.telegram.allowlist.filter(
        (entry) => entry.agentId !== agent.id
      );
      const removed = before - bridge.telegram.allowlist.length;
      if (removed > 0) {
        messagingAllowlistEntriesRemoved += removed;
        affectedBridgeIds.push(bridge.id);
        bridge.updatedAt = now();
      }
    }

    state.agents = state.agents.filter((item) => item.id !== agent.id);
    return {
      id: agent.id,
      name: agent.name,
      memoriesArchived,
      messagingAllowlistEntriesRemoved,
      affectedBridgeIds
    };
  });

  // Drop the per-agent Hindsight bank + its units outside the JSON state
  // transaction. SQLite is the source of truth for hindsight, so a single
  // BEGIN/COMMIT block there is the only consistency boundary we need.
  const { unitsDeleted, bankDeleted } = deleteBankAndUnits(
    config.instance,
    bankIdForAgent(result.id)
  );

  // Restart pollers for bridges whose allowlist was modified so the
  // in-memory poller state matches the persisted allowlist. The
  // resolveTelegramConnector guard inside the poller still re-reads on
  // each iteration, so this is belt-and-braces — the more meaningful
  // protection is the layered re-validation at inbound time.
  for (const bridgeId of result.affectedBridgeIds) {
    await restartPoller(config, bridgeId);
  }

  // Single audit event covering the whole cascade. Routed through a
  // follow-up mutateState so the cleanup counts are visible alongside
  // hindsight bookkeeping; the agent removal itself is already logged by
  // the state mutation above via state.agents membership change.
  await mutateState(config.instance, (state) => {
    addAudit(state, {
      actor: "user",
      action: "agent.deleted",
      target: result.id,
      risk: "medium",
      evidence: {
        name: result.name,
        memoriesArchived: result.memoriesArchived,
        unitsDeleted,
        bankDeleted,
        messagingAllowlistEntriesRemoved: result.messagingAllowlistEntriesRemoved,
        affectedBridgeIds: result.affectedBridgeIds
      }
    });
    return result.id;
  });

  return {
    ok: true,
    id: result.id,
    memoriesArchived: result.memoriesArchived,
    unitsDeleted,
    bankDeleted
  };
}
