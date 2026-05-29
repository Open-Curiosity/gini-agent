import type { ConnectorRecord, ConnectorSecretRef, RuntimeConfig, RuntimeState, SkillRecord } from "../../types";
import { addAudit, appendLog, id, mutateState, now, readState, updateConnectorHealth } from "../../state";
import { deleteConnectorSecrets, readSecret, writeSecret } from "../../state/secrets";
import { syncProviderMcpServers } from "../mcp-sync";
import { redactSecretsInText } from "../mcp-http";
import { getProvider, listProviders } from "./registry";

export interface CreateConnectorInput {
  name: string;
  provider: string;
  scopes?: string[];
  secrets?: Record<string, string>;
  // Free-form metadata for the `generic` provider. Stored verbatim on the
  // record under `metadata.fields` so the Add Connector dialog can render
  // dynamic non-secret fields (base URLs, account ids) without provider-
  // specific code.
  metadata?: Record<string, unknown>;
}

// CRUD-created connectors always carry `source: "user"`. The detection
// job creates `source: "auto"` records directly on the state slab without
// going through this helper so the auto-create path keeps its own audit
// signal (`connector.auto_create`).

export interface UpdateConnectorInput {
  name?: string;
  scopes?: string[];
  status?: "configured" | "disabled" | "error";
  secrets?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export async function createConnector(config: RuntimeConfig, input: CreateConnectorInput): Promise<ConnectorRecord> {
  const provider = String(input.provider || "").trim();
  const name = String(input.name || "").trim();
  if (!provider) throw new Error("Invalid input: provider is required.");
  if (!name) throw new Error("Invalid input: name is required.");
  const module = getProvider(provider);
  if (!module) throw new Error(`Unknown provider: ${provider}. Use one of ${listProviders().map((p) => p.id).join(", ")} or "generic".`);
  const connectorId = id("id");
  const secretRefs: ConnectorSecretRef[] = [];
  for (const [purpose, value] of Object.entries(input.secrets ?? {})) {
    if (typeof value !== "string" || value.length === 0) continue;
    secretRefs.push(writeSecret(config.instance, connectorId, purpose, value));
  }
  return mutateState(config.instance, (state) => {
    const at = now();
    const connector: ConnectorRecord = {
      id: connectorId,
      instance: state.instance,
      name,
      provider,
      status: "configured",
      scopes: Array.isArray(input.scopes) ? input.scopes.map(String) : [],
      secretRefs,
      createdAt: at,
      updatedAt: at,
      health: "unknown",
      metadata: input.metadata,
      source: "user"
    };
    state.connectors.unshift(connector);
    // For providers without a probe (demo, generic, claude-code, codex)
    // there is no remote check that could refute the configured-status
    // assumption, so the synchronous health-set is honest. For probe-based
    // providers (linear), seeding `healthy` from `status === "configured"`
    // would lie until the next reprobe — leave them at `health: "unknown"`
    // so the activation gate (which treats unknown-with-probe as inactive)
    // waits for the first real probe before surfacing dependent skills.
    if (!module.probe) {
      updateConnectorHealth(connector);
    }
    // Connectors live at the instance level — they're shared across
    // every agent, so the create row isn't per-agent activity.
    addAudit(
      state,
      {
        actor: "user",
        action: "connector.create",
        target: connector.id,
        risk: "medium",
        evidence: {
          provider: connector.provider,
          name: connector.name,
          scopes: connector.scopes,
          purposes: secretRefs.map((ref) => ref.purpose)
        }
      },
      { system: true }
    );
    return connector;
  });
}

export async function updateConnector(
  config: RuntimeConfig,
  connectorId: string,
  input: UpdateConnectorInput
): Promise<ConnectorRecord> {
  const newSecrets = input.secrets ?? {};
  const wroteRefs: ConnectorSecretRef[] = [];
  for (const [purpose, value] of Object.entries(newSecrets)) {
    if (typeof value !== "string" || value.length === 0) continue;
    wroteRefs.push(writeSecret(config.instance, connectorId, purpose, value));
  }
  return mutateState(config.instance, (state) => {
    const connector = state.connectors.find((candidate) => candidate.id === connectorId);
    if (!connector) throw new Error(`Connector not found: ${connectorId}`);
    if (typeof input.name === "string") connector.name = input.name.trim() || connector.name;
    if (Array.isArray(input.scopes)) connector.scopes = input.scopes.map(String);
    if (input.status) connector.status = input.status;
    if (input.metadata) connector.metadata = { ...(connector.metadata ?? {}), ...input.metadata };
    for (const ref of wroteRefs) {
      const existing = connector.secretRefs.find((candidate) => candidate.purpose === ref.purpose);
      if (existing) existing.path = ref.path;
      else connector.secretRefs.push(ref);
    }
    connector.updatedAt = now();
    addAudit(
      state,
      {
        actor: "user",
        action: wroteRefs.length > 0 ? "connector.rotate" : "connector.update",
        target: connector.id,
        risk: "medium",
        evidence: {
          provider: connector.provider,
          rotatedPurposes: wroteRefs.map((ref) => ref.purpose)
        }
      },
      { system: true }
    );
    return connector;
  });
}

export async function deleteConnector(config: RuntimeConfig, connectorId: string): Promise<{ id: string; tombstoned?: boolean }> {
  // Read the source up-front so we can decide whether to physically wipe
  // the encrypted secrets. Auto-source connectors don't carry secrets
  // today (claude-code/codex are presence-only), but the wipe is still
  // safe to skip — the tombstone path leaves the record in place so a
  // future "rotate" or "edit" could rebuild it.
  const initial = readState(config.instance).connectors.find((c) => c.id === connectorId);
  if (!initial) throw new Error(`Connector not found: ${connectorId}`);
  const isAuto = initial.source === "auto";

  if (!isAuto) {
    deleteConnectorSecrets(config.instance, connectorId);
  }

  return mutateState(config.instance, (state) => {
    const index = state.connectors.findIndex((candidate) => candidate.id === connectorId);
    if (index < 0) throw new Error(`Connector not found: ${connectorId}`);
    if (isAuto) {
      // Tombstone — keep the record around with `status: "disabled"` so
      // the detection job (which skips disabled rows) doesn't immediately
      // re-create the connector after the user explicitly disconnected it.
      const connector = state.connectors[index]!;
      connector.status = "disabled";
      connector.health = "unknown";
      connector.message = undefined;
      connector.updatedAt = now();
      addAudit(
        state,
        {
          actor: "user",
          action: "connector.disable",
          target: connectorId,
          risk: "medium",
          evidence: { provider: connector.provider, name: connector.name, source: connector.source }
        },
        { system: true }
      );
      return { id: connectorId, tombstoned: true };
    }
    const [connector] = state.connectors.splice(index, 1);
    addAudit(
      state,
      {
        actor: "user",
        action: "connector.delete",
        target: connectorId,
        risk: "medium",
        evidence: { provider: connector?.provider, name: connector?.name }
      },
      { system: true }
    );
    return { id: connectorId };
  });
}

// Resolve a single secret value for a connector, emitting an audit event
// that records the purpose and whether resolution succeeded — never the
// value itself. Callers that need to pass a secret into a subprocess
// should fetch it through here so the audit trail is consistent.
// When `taskId` is supplied, the resolution audit attributes to the
// owning agent of that task; callers without a task context (health
// probes, management UI) fall through to a system-level audit.
export async function resolveConnectorSecret(
  config: RuntimeConfig,
  connectorId: string,
  purpose: string,
  taskId?: string
): Promise<string | undefined> {
  const state = readState(config.instance);
  const connector = state.connectors.find((candidate) => candidate.id === connectorId);
  if (!connector) throw new Error(`Connector not found: ${connectorId}`);
  const ref = connector.secretRefs.find((candidate) => candidate.purpose === purpose);
  let value: string | undefined;
  let ok = false;
  try {
    if (ref) {
      value = readSecret(config.instance, ref);
      ok = true;
    }
  } finally {
    await mutateState(config.instance, (mutating) => {
      addAudit(
        mutating,
        {
          actor: "runtime",
          action: "connector.secret.use",
          target: connectorId,
          risk: "low",
          taskId,
          evidence: { provider: connector.provider, purpose, resolved: ok }
        },
        taskId ? { taskId } : { system: true }
      );
    });
  }
  return value;
}

// Per-provider health probe dispatch. Probes are optional per ADR connector-provider-spec-compliance.md: a
// provider without a `probe` falls back to a configured-status check (no
// remote system to query). Connector records that reference an unknown
// provider land at `unhealthy` with a surfaced message so the activation
// gate sees the failure.
export async function checkConnector(config: RuntimeConfig, connectorId: string): Promise<ConnectorRecord> {
  const initial = readState(config.instance).connectors.find((candidate) => candidate.id === connectorId);
  if (!initial) throw new Error(`Connector not found: ${connectorId}`);

  const module = getProvider(initial.provider);
  let probeMessage: string | undefined;
  let probeHealth: "healthy" | "unhealthy" | "unknown" = initial.health;
  let probed = false;

  if (!module) {
    probeHealth = "unhealthy";
    probeMessage = `Unknown provider: ${initial.provider}.`;
    probed = true;
  } else if (module.probe) {
    probed = true;
    try {
      const result = await module.probe({
        config,
        connectorId,
        resolveSecret: (purpose) => resolveConnectorSecret(config, connectorId, purpose),
        metadata: initial.metadata ?? {}
      });
      probeHealth = result.ok ? "healthy" : "unhealthy";
      probeMessage = result.message;
    } catch (error) {
      probeHealth = "unhealthy";
      probeMessage = error instanceof Error ? error.message : String(error);
    }
  } else {
    // Presence-only provider (e.g. apple-notes, generic with no static check).
    // Default to healthy iff the record is configured — there is no remote
    // system to query.
    probeHealth = initial.status === "configured" ? "healthy" : "unhealthy";
    probeMessage = `Provider ${initial.provider} has no remote probe; presence-only.`;
  }

  const result = await mutateState(config.instance, (state) => {
    const connector = state.connectors.find((candidate) => candidate.id === connectorId);
    if (!connector) throw new Error(`Connector not found: ${connectorId}`);
    connector.lastHealthAt = now();
    connector.health = probeHealth;
    connector.message = probeMessage;
    connector.updatedAt = now();
    addAudit(
      state,
      {
        actor: "runtime",
        action: "connector.health",
        target: connectorId,
        risk: "low",
        evidence: { provider: connector.provider, health: connector.health, probed }
      },
      { system: true }
    );
    return connector;
  });
  // After a successful health write, materialize any provider-declared
  // MCP server record so `mcp_call(server: "<provider>")` resolves. Safe
  // to call on every probe — the sync is idempotent and skips providers
  // whose MCP entry already exists.
  if (result.health === "healthy") {
    try {
      await syncProviderMcpServers(config);
    } catch (error) {
      // Best-effort. A failure here doesn't unwind the health update —
      // the connector is still usable for env-based flows. But we MUST
      // make the failure observable so a regression isn't silent:
      // operators see `mcp.auto_register_failed` in the audit log and
      // can diagnose without re-running the probe locally.
      const message = redactSecretsInText(error instanceof Error ? error.message : String(error));
      appendLog(config.instance, "mcp.auto_register.error", {
        connectorId,
        provider: result.provider,
        error: message
      });
      await mutateState(config.instance, (state) => {
        addAudit(
          state,
          {
            actor: "runtime",
            action: "mcp.auto_register_failed",
            target: connectorId,
            risk: "low",
            evidence: { provider: result.provider, error: message }
          },
          { system: true }
        );
      });
    }
  }
  return result;
}

// A skill is active iff every required connector is satisfied by a
// configured + healthy ConnectorRecord of the matching provider. The agent
// loop filters inactive skills out of its available-skills set; the UI
// still shows them so users can see what's missing.
//
// Both branches require `status === "configured"`. A `disabled` connector
// is one the user explicitly turned off — even if a stale health probe
// still says "healthy", we should not let it satisfy a skill. An `error`
// status means setup failed and the connector isn't usable.
//
// `health: "unknown"` is treated as active when the matching provider has
// no probe (we have no failing signal). It's treated as inactive when the
// provider declares a probe but hasn't run yet — to avoid surfacing skills
// before their first probe.
export function isSkillActive(state: RuntimeState, skill: SkillRecord): boolean {
  if (skill.validationStatus === "unsupported") return false;
  const required = skill.requiredConnectors ?? [];
  if (required.length === 0) return true;
  for (const requirement of required) {
    const module = getProvider(requirement.provider);
    const hasProbe = Boolean(module?.probe);
    const match = state.connectors.find((candidate) => {
      if (candidate.provider !== requirement.provider) return false;
      if (candidate.status !== "configured") return false;
      if (candidate.health === "healthy") return true;
      if (!hasProbe && candidate.health === "unknown") return true;
      return false;
    });
    if (!match) return false;
  }
  return true;
}

// Derive env var → (provider, purpose) mappings at runtime from each
// registered provider's `envBindings`. This replaces the pre-ADR-connector-provider-spec-compliance.md
// hardcoded global map. Callers can ask "which env vars do these providers
// expose, and which purpose holds the secret for each?" without
// per-provider knowledge.
export function envBindingsForProviders(providers: string[]): Record<string, { provider: string; purpose: string }> {
  const result: Record<string, { provider: string; purpose: string }> = {};
  for (const providerId of providers) {
    const module = getProvider(providerId);
    if (!module?.secrets?.envBindings) continue;
    for (const [envName, purpose] of Object.entries(module.secrets.envBindings)) {
      result[envName] = { provider: providerId, purpose };
    }
  }
  return result;
}

// NOTE: `resolveActiveSkillsEnv` (the aggregate-across-every-active-skill
// helper) was removed as part of the ENG-1613 env-containment fix. It was
// the leak path: every terminal_exec invocation got every active skill's
// connector env, so an `attachments` helper script saw GitHub, Notion,
// Linear, Google secrets just because those skills were enabled. The new
// model: terminal_exec accepts an optional `skill` arg, and only that
// skill's `resolveSkillEnv` is injected via `resolveSkillEnvByName` below.
// Without a skill arg, no connector env enters the spawn. Callers that
// previously relied on aggregation must now name the skill they're
// operating under.

// Resolve env vars for ONE named skill, or empty when no skill context is
// supplied / the skill doesn't exist / the skill is not enabled. Unknown
// skill names silently produce empty env rather than erroring — the
// command itself usually still works without the connector env, and the
// audit row captures the requested skill name either way.
export async function resolveSkillEnvByName(
  config: RuntimeConfig,
  skillName: string | undefined,
  taskId?: string
): Promise<Record<string, string>> {
  if (!skillName) return {};
  const state = readState(config.instance);
  const skill = state.skills.find((s) => s.name === skillName && s.status === "enabled");
  if (!skill) return {};
  return resolveSkillEnv(config, skill, taskId);
}

export async function resolveSkillEnv(
  config: RuntimeConfig,
  skill: SkillRecord,
  taskId?: string
): Promise<Record<string, string>> {
  const envNames = skill.prerequisites?.env ?? [];
  if (envNames.length === 0) return {};
  const required = skill.requiredConnectors ?? [];
  if (required.length === 0) return {};
  const providers = required.map((r) => r.provider);
  const bindings = envBindingsForProviders(providers);
  const state = readState(config.instance);
  const out: Record<string, string> = {};
  for (const envName of envNames) {
    const binding = bindings[envName];
    if (!binding) continue;
    // Same status guard as isSkillActive: a `disabled` or `error` record
    // with a stale `health: "healthy"` from a prior probe must not leak
    // its secret into the spawn env.
    const connector = state.connectors.find(
      (candidate) =>
        candidate.provider === binding.provider
        && candidate.status === "configured"
        && candidate.health === "healthy"
    );
    if (!connector) continue;
    const value = await resolveConnectorSecret(config, connector.id, binding.purpose, taskId);
    if (value) out[envName] = value;
  }
  return out;
}
