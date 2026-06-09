// Default-model selection (see ADR model-first-selection.md).
//
// "Default model" is what a new chat starts with: new agents copy the
// default agent's provider/model at creation, and the default agent's own
// chat is the first thing a fresh install talks to. Writing only
// RuntimeConfig.provider is not enough — seedDefaultAgentFromConfig
// (src/state/store.ts) fills agent_default's override on boot, and that
// override shadows config.provider in resolveEffectiveContext forever
// after. So this write path updates BOTH layers:
//
//   1. config.provider via setSetupProvider — the instance fallback that
//      embeddings/reranker and override-less agents read. The partial
//      { provider, model } payload preserves stored transport config
//      (baseUrl/apiKeyEnv/awsRegion/extraBody/Azure routing) on a
//      same-provider save.
//   2. agent_default's providerName/model via setAgentProvider — the
//      override the default chat actually resolves through (audited as
//      agent.provider_set).
//
// Other agents are deliberately untouched: their provider/model pair is a
// per-agent override (ADR per-agent-provider-settings.md), copied — not
// linked — from the default agent at creation time.

import { setAgentProvider } from "../capabilities/agents";
import { readState } from "../state";
import { setSetupProvider, type SetSetupProviderResult } from "./setup-api";
import type { RuntimeConfig } from "../types";

// The default agent's id is "agent_default" on current instances and the
// pre-rename "profile_default" on legacy ones — the same pair of ids
// seedDefaultAgentFromConfig targets. Resolve id-first in that order.
const DEFAULT_AGENT_IDS = ["agent_default", "profile_default"] as const;

export async function setDefaultModel(
  config: RuntimeConfig,
  payload: Record<string, unknown>
): Promise<SetSetupProviderResult> {
  // Forward only the selection pair. This endpoint is selection-only;
  // credential/transport writes stay on POST /api/setup/provider.
  const result = await setSetupProvider(config, {
    provider: payload.provider,
    model: payload.model
  });
  if (!result.ok) return result;
  // setSetupProvider normalized and persisted the pair onto config.provider
  // (an omitted/blank model resolves to the provider's default there), so
  // mirror the persisted values rather than the raw payload. An instance
  // with no default agent row has nothing shadowing config.provider — skip.
  const agents = readState(config.instance).agents;
  const defaultAgent = DEFAULT_AGENT_IDS
    .map((id) => agents.find((agent) => agent.id === id))
    .find(Boolean);
  if (defaultAgent) {
    await setAgentProvider(config, defaultAgent.id, {
      providerName: config.provider.name,
      model: config.provider.model
    });
  }
  return result;
}
