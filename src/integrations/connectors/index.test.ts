import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createEmptyState, mutateState } from "../../state";
import { writeSecret } from "../../state/secrets";
import type { ConnectorRecord, SkillRecord } from "../../types";
import { bindingsForCredentials, isSkillActive, resolveSkillEnv } from "./index";

const ROOT = "/tmp/gini-connectors-unit";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function newSkill(overrides: Partial<SkillRecord>): SkillRecord {
  return {
    id: "skill_test",
    instance: "dev",
    name: "test",
    description: "",
    trigger: "",
    steps: [],
    requiredTools: [],
    requiredPermissions: [],
    status: "enabled",
    version: 1,
    createdAt: "",
    updatedAt: "",
    tests: [],
    successCount: 0,
    failureCount: 0,
    previousVersions: [],
    body: "",
    ...overrides
  };
}

function newConnector(overrides: Partial<ConnectorRecord>): ConnectorRecord {
  return {
    id: "id_test",
    instance: "dev",
    name: "test",
    provider: "linear",
    status: "configured",
    scopes: [],
    secretRefs: [],
    createdAt: "",
    updatedAt: "",
    health: "healthy",
    ...overrides
  };
}

describe("isSkillActive", () => {
  test("returns true when the skill has no required connectors", () => {
    const state = createEmptyState("dev");
    state.connectors = [];
    const skill = newSkill({ requiredConnectors: [] });
    expect(isSkillActive(state, skill)).toBe(true);
  });

  test("returns true when every required provider has a healthy connector", () => {
    const state = createEmptyState("dev");
    state.connectors = [newConnector({ provider: "linear", health: "healthy" })];
    const skill = newSkill({ requiredConnectors: [{ provider: "linear" }] });
    expect(isSkillActive(state, skill)).toBe(true);
  });

  test("returns false when the matching connector is unhealthy", () => {
    const state = createEmptyState("dev");
    state.connectors = [newConnector({ provider: "linear", health: "unhealthy" })];
    const skill = newSkill({ requiredConnectors: [{ provider: "linear" }] });
    expect(isSkillActive(state, skill)).toBe(false);
  });

  test("returns false when no connector of the required provider exists", () => {
    const state = createEmptyState("dev");
    state.connectors = [newConnector({ provider: "github", health: "healthy" })];
    const skill = newSkill({ requiredConnectors: [{ provider: "linear" }] });
    expect(isSkillActive(state, skill)).toBe(false);
  });

  test("returns false when a skill is marked unsupported", () => {
    const state = createEmptyState("dev");
    state.connectors = [newConnector({ provider: "linear", health: "healthy" })];
    const skill = newSkill({
      requiredConnectors: [{ provider: "linear" }],
      validationStatus: "unsupported",
      validationMessage: "Unknown provider in source"
    });
    expect(isSkillActive(state, skill)).toBe(false);
  });

  test("treats unknown health as inactive when the provider has a probe", () => {
    const state = createEmptyState("dev");
    // Linear has a probe; an unprobed connector should not satisfy the gate.
    state.connectors = [newConnector({ provider: "linear", health: "unknown" })];
    const skill = newSkill({ requiredConnectors: [{ provider: "linear" }] });
    expect(isSkillActive(state, skill)).toBe(false);
  });

  test("treats unknown health as active when the provider has no probe", () => {
    const state = createEmptyState("dev");
    // The "demo" provider declares no probe — presence is enough.
    state.connectors = [newConnector({ provider: "demo", health: "unknown" })];
    const skill = newSkill({ requiredConnectors: [{ provider: "demo" }] });
    expect(isSkillActive(state, skill)).toBe(true);
  });

  test("disabled connector with healthy probe does NOT satisfy a skill", () => {
    // The user explicitly turned this connector off. A stale `health:
    // "healthy"` from before they disabled it (or a probe job that ran
    // anyway) must not let dependent skills activate behind their back.
    const state = createEmptyState("dev");
    state.connectors = [newConnector({ provider: "linear", status: "disabled", health: "healthy" })];
    const skill = newSkill({ requiredConnectors: [{ provider: "linear" }] });
    expect(isSkillActive(state, skill)).toBe(false);
  });

  test("error-status connector does NOT satisfy a skill even if a probe later returns healthy", () => {
    const state = createEmptyState("dev");
    state.connectors = [newConnector({ provider: "linear", status: "error", health: "healthy" })];
    const skill = newSkill({ requiredConnectors: [{ provider: "linear" }] });
    expect(isSkillActive(state, skill)).toBe(false);
  });

  test("disabled connector does NOT satisfy a no-probe provider either", () => {
    const state = createEmptyState("dev");
    state.connectors = [newConnector({ provider: "demo", status: "disabled", health: "unknown" })];
    const skill = newSkill({ requiredConnectors: [{ provider: "demo" }] });
    expect(isSkillActive(state, skill)).toBe(false);
  });
});

describe("resolveSkillEnv", () => {
  // resolveSkillEnv resolves prerequisites.env for a skill by finding a
  // matching connector and reading its secret. The find predicate must
  // mirror the isSkillActive guard — otherwise a disabled or error-status
  // connector with a stale `health: "healthy"` could leak its secret into
  // a terminal_exec spawn even though the activation gate excludes the
  // skill.

  test("disabled connector with healthy probe does NOT inject its secret", async () => {
    const instance = "resolve-disabled";
    const config = {
      instance,
      port: 0,
      token: "t",
      provider: { name: "echo" as const, model: "echo" },
      workspaceRoot: `${ROOT}/${instance}/workspace`,
      stateRoot: `${ROOT}/${instance}`,
      logRoot: `${ROOT}/${instance}/logs`
    };
    const ref = writeSecret(instance, "id_disabled", "token", "leaked-token");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_disabled",
        instance,
        provider: "linear",
        status: "disabled",
        health: "healthy",
        secretRefs: [ref]
      }));
    });
    const skill = newSkill({
      source: "bundled",
      requiredConnectors: [{ provider: "linear" }],
      prerequisites: { env: ["LINEAR_API_KEY"] }
    });
    const env = await resolveSkillEnv(config, skill);
    expect(env).toEqual({});
  });

  test("configured + healthy connector DOES inject its secret (regression)", async () => {
    const instance = "resolve-configured";
    const config = {
      instance,
      port: 0,
      token: "t",
      provider: { name: "echo" as const, model: "echo" },
      workspaceRoot: `${ROOT}/${instance}/workspace`,
      stateRoot: `${ROOT}/${instance}`,
      logRoot: `${ROOT}/${instance}/logs`
    };
    const ref = writeSecret(instance, "id_ok", "token", "real-token");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_ok",
        instance,
        provider: "linear",
        status: "configured",
        health: "healthy",
        secretRefs: [ref]
      }));
    });
    const skill = newSkill({
      source: "bundled",
      requiredConnectors: [{ provider: "linear" }],
      prerequisites: { env: ["LINEAR_API_KEY"] }
    });
    const env = await resolveSkillEnv(config, skill);
    expect(env).toEqual({ LINEAR_API_KEY: "real-token" });
  });

  // The `generic` provider has no static envBindings, so a user-supplied
  // key resolves by treating each generic connector's secret field name as
  // its own env binding (verbatim match against the declared
  // prerequisites.env name).

  test("generic connector injects a secret named like the declared env var", async () => {
    const instance = "resolve-generic";
    const config = {
      instance,
      port: 0,
      token: "t",
      provider: { name: "echo" as const, model: "echo" },
      workspaceRoot: `${ROOT}/${instance}/workspace`,
      stateRoot: `${ROOT}/${instance}`,
      logRoot: `${ROOT}/${instance}/logs`
    };
    const ref = writeSecret(instance, "id_generic", "MY_API_KEY", "generic-real");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_generic",
        instance,
        provider: "generic",
        status: "configured",
        health: "healthy",
        secretRefs: [ref]
      }));
    });
    const skill = newSkill({
      source: "bundled",
      requiredConnectors: [{ provider: "generic" }],
      prerequisites: { env: ["MY_API_KEY"] }
    });
    const env = await resolveSkillEnv(config, skill);
    expect(env).toEqual({ MY_API_KEY: "generic-real" });
  });

  test("generic secret fields NOT in prerequisites.env do not leak into the env", async () => {
    const instance = "resolve-generic-extra";
    const config = {
      instance,
      port: 0,
      token: "t",
      provider: { name: "echo" as const, model: "echo" },
      workspaceRoot: `${ROOT}/${instance}/workspace`,
      stateRoot: `${ROOT}/${instance}`,
      logRoot: `${ROOT}/${instance}/logs`
    };
    const wanted = writeSecret(instance, "id_generic", "MY_API_KEY", "generic-real");
    const extra = writeSecret(instance, "id_generic", "OTHER_SECRET", "should-not-appear");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_generic",
        instance,
        provider: "generic",
        status: "configured",
        health: "healthy",
        secretRefs: [wanted, extra]
      }));
    });
    const skill = newSkill({
      source: "bundled",
      requiredConnectors: [{ provider: "generic" }],
      prerequisites: { env: ["MY_API_KEY"] }
    });
    const env = await resolveSkillEnv(config, skill);
    expect(env).toEqual({ MY_API_KEY: "generic-real" });
    expect(env).not.toHaveProperty("OTHER_SECRET");
  });

  test("disabled generic connector does NOT inject its secret", async () => {
    const instance = "resolve-generic-disabled";
    const config = {
      instance,
      port: 0,
      token: "t",
      provider: { name: "echo" as const, model: "echo" },
      workspaceRoot: `${ROOT}/${instance}/workspace`,
      stateRoot: `${ROOT}/${instance}`,
      logRoot: `${ROOT}/${instance}/logs`
    };
    const ref = writeSecret(instance, "id_generic", "MY_API_KEY", "generic-real");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_generic",
        instance,
        provider: "generic",
        status: "disabled",
        health: "healthy",
        secretRefs: [ref]
      }));
    });
    const skill = newSkill({
      source: "bundled",
      requiredConnectors: [{ provider: "generic" }],
      prerequisites: { env: ["MY_API_KEY"] }
    });
    const env = await resolveSkillEnv(config, skill);
    expect(env).toEqual({});
  });

  test("two generic connectors with the same secret field name skip that env var (fail safe), leaving others unaffected", async () => {
    const instance = "resolve-generic-ambiguous";
    const config = {
      instance,
      port: 0,
      token: "t",
      provider: { name: "echo" as const, model: "echo" },
      workspaceRoot: `${ROOT}/${instance}/workspace`,
      stateRoot: `${ROOT}/${instance}`,
      logRoot: `${ROOT}/${instance}/logs`
    };
    // Two healthy generic connectors both store MY_API_KEY — ambiguous, must
    // resolve to nothing. A second, unambiguous field (OTHER_KEY) still works.
    const dupA = writeSecret(instance, "id_generic_a", "MY_API_KEY", "value-a");
    const dupB = writeSecret(instance, "id_generic_b", "MY_API_KEY", "value-b");
    const other = writeSecret(instance, "id_generic_b", "OTHER_KEY", "other-real");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_generic_a",
        instance,
        provider: "generic",
        status: "configured",
        health: "healthy",
        secretRefs: [dupA]
      }));
      state.connectors.push(newConnector({
        id: "id_generic_b",
        instance,
        provider: "generic",
        status: "configured",
        health: "healthy",
        secretRefs: [dupB, other]
      }));
    });
    const skill = newSkill({
      source: "bundled",
      requiredConnectors: [{ provider: "generic" }],
      prerequisites: { env: ["MY_API_KEY", "OTHER_KEY"] }
    });
    const env = await resolveSkillEnv(config, skill);
    expect(env).toEqual({ OTHER_KEY: "other-real" });
    expect(env).not.toHaveProperty("MY_API_KEY");
  });

  // Per-(skill, connector) consent gate (ADR skill-connector-consent.md). A
  // non-bundled skill receives a credentialed connector's env only after the
  // user grants that provider; bundled skills are auto-granted.

  test("ungranted non-bundled skill does NOT inject even with a healthy connector", async () => {
    const instance = "resolve-ungranted";
    const config = {
      instance,
      port: 0,
      token: "t",
      provider: { name: "echo" as const, model: "echo" },
      workspaceRoot: `${ROOT}/${instance}/workspace`,
      stateRoot: `${ROOT}/${instance}`,
      logRoot: `${ROOT}/${instance}/logs`
    };
    const ref = writeSecret(instance, "id_ungranted", "token", "real-token");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_ungranted",
        instance,
        provider: "linear",
        status: "configured",
        health: "healthy",
        secretRefs: [ref]
      }));
    });
    const skill = newSkill({
      source: "user",
      requiredConnectors: [{ provider: "linear" }],
      prerequisites: { env: ["LINEAR_API_KEY"] }
    });
    const env = await resolveSkillEnv(config, skill);
    expect(env).toEqual({});
  });

  test("granted non-bundled skill injects the connector's secret", async () => {
    const instance = "resolve-granted";
    const config = {
      instance,
      port: 0,
      token: "t",
      provider: { name: "echo" as const, model: "echo" },
      workspaceRoot: `${ROOT}/${instance}/workspace`,
      stateRoot: `${ROOT}/${instance}`,
      logRoot: `${ROOT}/${instance}/logs`
    };
    const ref = writeSecret(instance, "id_granted", "token", "real-token");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_granted",
        instance,
        provider: "linear",
        status: "configured",
        health: "healthy",
        secretRefs: [ref]
      }));
    });
    const skill = newSkill({
      source: "user",
      grantedConnectors: ["linear"],
      requiredConnectors: [{ provider: "linear" }],
      prerequisites: { env: ["LINEAR_API_KEY"] }
    });
    const env = await resolveSkillEnv(config, skill);
    expect(env).toEqual({ LINEAR_API_KEY: "real-token" });
  });

  test("bundled skill injects without any written grant (auto-grant)", async () => {
    const instance = "resolve-bundled-autogrant";
    const config = {
      instance,
      port: 0,
      token: "t",
      provider: { name: "echo" as const, model: "echo" },
      workspaceRoot: `${ROOT}/${instance}/workspace`,
      stateRoot: `${ROOT}/${instance}`,
      logRoot: `${ROOT}/${instance}/logs`
    };
    const ref = writeSecret(instance, "id_bundled", "token", "real-token");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_bundled",
        instance,
        provider: "linear",
        status: "configured",
        health: "healthy",
        secretRefs: [ref]
      }));
    });
    const skill = newSkill({
      source: "bundled",
      requiredConnectors: [{ provider: "linear" }],
      prerequisites: { env: ["LINEAR_API_KEY"] }
    });
    const env = await resolveSkillEnv(config, skill);
    expect(env).toEqual({ LINEAR_API_KEY: "real-token" });
  });
});

// Name-based resolution (the model post-credential-refactor). Skills declare
// `requiredCredentials` (names); connectors carry a `type` and (for api-key)
// the env var IS the credential name. The transitional fallback above keeps
// `requiredConnectors`-keyed skills working until the migration lands.

describe("isSkillActive by credential name", () => {
  test("satisfied when a usable connector with the required name exists", () => {
    const state = createEmptyState("dev");
    state.connectors = [newConnector({ name: "LINEAR_API_KEY", type: "api-key", provider: "linear", health: "healthy" })];
    const skill = newSkill({ requiredCredentials: ["LINEAR_API_KEY"] });
    expect(isSkillActive(state, skill)).toBe(true);
  });

  test("unsatisfied when no connector has the required name", () => {
    const state = createEmptyState("dev");
    state.connectors = [newConnector({ name: "OTHER_KEY", type: "api-key", provider: "linear", health: "healthy" })];
    const skill = newSkill({ requiredCredentials: ["LINEAR_API_KEY"] });
    expect(isSkillActive(state, skill)).toBe(false);
  });

  test("unsatisfied when the named connector is disabled (stale healthy probe)", () => {
    const state = createEmptyState("dev");
    state.connectors = [newConnector({ name: "LINEAR_API_KEY", type: "api-key", provider: "linear", status: "disabled", health: "healthy" })];
    const skill = newSkill({ requiredCredentials: ["LINEAR_API_KEY"] });
    expect(isSkillActive(state, skill)).toBe(false);
  });
});

describe("bindingsForCredentials", () => {
  test("api-key credential: env var IS the credential name", () => {
    const state = createEmptyState("dev");
    state.connectors = [newConnector({
      id: "id_linear",
      name: "LINEAR_API_KEY",
      type: "api-key",
      provider: "linear",
      health: "healthy",
      secretRefs: [{ purpose: "token", path: "secrets/id_linear/token.json" }]
    })];
    const bindings = bindingsForCredentials(state, ["LINEAR_API_KEY"]);
    expect(bindings).toEqual({ LINEAR_API_KEY: { credentialId: "id_linear", purpose: "token" } });
  });

  test("oauth2 credential: one binding per envMap entry", () => {
    const state = createEmptyState("dev");
    state.connectors = [newConnector({
      id: "id_gws",
      name: "google-workspace-oauth",
      type: "oauth2",
      provider: "google-oauth-desktop",
      health: "healthy",
      secretRefs: [
        { purpose: "client_id", path: "secrets/id_gws/client_id.json" },
        { purpose: "client_secret", path: "secrets/id_gws/client_secret.json" }
      ],
      metadata: {
        envMap: {
          client_id: "GOOGLE_WORKSPACE_CLI_CLIENT_ID",
          client_secret: "GOOGLE_WORKSPACE_CLI_CLIENT_SECRET"
        }
      }
    })];
    const bindings = bindingsForCredentials(state, ["google-workspace-oauth"]);
    expect(bindings).toEqual({
      GOOGLE_WORKSPACE_CLI_CLIENT_ID: { credentialId: "id_gws", purpose: "client_id" },
      GOOGLE_WORKSPACE_CLI_CLIENT_SECRET: { credentialId: "id_gws", purpose: "client_secret" }
    });
  });

  test("disabled credential contributes no bindings", () => {
    const state = createEmptyState("dev");
    state.connectors = [newConnector({
      id: "id_linear",
      name: "LINEAR_API_KEY",
      type: "api-key",
      provider: "linear",
      status: "disabled",
      health: "healthy",
      secretRefs: [{ purpose: "token", path: "secrets/id_linear/token.json" }]
    })];
    expect(bindingsForCredentials(state, ["LINEAR_API_KEY"])).toEqual({});
  });
});

describe("resolveSkillEnv by credential name", () => {
  function configFor(instance: string) {
    return {
      instance,
      port: 0,
      token: "t",
      provider: { name: "echo" as const, model: "echo" },
      workspaceRoot: `${ROOT}/${instance}/workspace`,
      stateRoot: `${ROOT}/${instance}`,
      logRoot: `${ROOT}/${instance}/logs`
    };
  }

  test("api-key: granted non-bundled skill injects the secret under name==env var", async () => {
    const instance = "name-apikey-granted";
    const ref = writeSecret(instance, "id_linear", "token", "real-token");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_linear",
        instance,
        name: "LINEAR_API_KEY",
        type: "api-key",
        provider: "linear",
        status: "configured",
        health: "healthy",
        secretRefs: [ref]
      }));
    });
    const skill = newSkill({
      source: "user",
      grantedConnectors: ["LINEAR_API_KEY"],
      requiredCredentials: ["LINEAR_API_KEY"],
      prerequisites: { env: ["LINEAR_API_KEY"] }
    });
    const env = await resolveSkillEnv(configFor(instance), skill);
    expect(env).toEqual({ LINEAR_API_KEY: "real-token" });
  });

  test("api-key: ungranted non-bundled skill injects nothing", async () => {
    const instance = "name-apikey-ungranted";
    const ref = writeSecret(instance, "id_linear", "token", "real-token");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_linear",
        instance,
        name: "LINEAR_API_KEY",
        type: "api-key",
        provider: "linear",
        status: "configured",
        health: "healthy",
        secretRefs: [ref]
      }));
    });
    const skill = newSkill({
      source: "user",
      requiredCredentials: ["LINEAR_API_KEY"],
      prerequisites: { env: ["LINEAR_API_KEY"] }
    });
    const env = await resolveSkillEnv(configFor(instance), skill);
    expect(env).toEqual({});
  });

  test("api-key: bundled skill auto-grants (no written grant needed)", async () => {
    const instance = "name-apikey-bundled";
    const ref = writeSecret(instance, "id_linear", "token", "real-token");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_linear",
        instance,
        name: "LINEAR_API_KEY",
        type: "api-key",
        provider: "linear",
        status: "configured",
        health: "healthy",
        secretRefs: [ref]
      }));
    });
    const skill = newSkill({
      source: "bundled",
      requiredCredentials: ["LINEAR_API_KEY"],
      prerequisites: { env: ["LINEAR_API_KEY"] }
    });
    const env = await resolveSkillEnv(configFor(instance), skill);
    expect(env).toEqual({ LINEAR_API_KEY: "real-token" });
  });

  test("oauth2: granted skill materializes every envMap var by name", async () => {
    const instance = "name-oauth-granted";
    const cid = writeSecret(instance, "id_gws", "client_id", "client-id-value");
    const csec = writeSecret(instance, "id_gws", "client_secret", "client-secret-value");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_gws",
        instance,
        name: "google-workspace-oauth",
        type: "oauth2",
        provider: "google-oauth-desktop",
        status: "configured",
        health: "healthy",
        secretRefs: [cid, csec],
        metadata: {
          envMap: {
            client_id: "GOOGLE_WORKSPACE_CLI_CLIENT_ID",
            client_secret: "GOOGLE_WORKSPACE_CLI_CLIENT_SECRET"
          }
        }
      }));
    });
    const skill = newSkill({
      source: "user",
      grantedConnectors: ["google-workspace-oauth"],
      requiredCredentials: ["google-workspace-oauth"],
      prerequisites: { env: ["GOOGLE_WORKSPACE_CLI_CLIENT_ID", "GOOGLE_WORKSPACE_CLI_CLIENT_SECRET"] }
    });
    const env = await resolveSkillEnv(configFor(instance), skill);
    expect(env).toEqual({
      GOOGLE_WORKSPACE_CLI_CLIENT_ID: "client-id-value",
      GOOGLE_WORKSPACE_CLI_CLIENT_SECRET: "client-secret-value"
    });
  });

  test("oauth2: ungranted skill injects nothing", async () => {
    const instance = "name-oauth-ungranted";
    const cid = writeSecret(instance, "id_gws", "client_id", "client-id-value");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_gws",
        instance,
        name: "google-workspace-oauth",
        type: "oauth2",
        provider: "google-oauth-desktop",
        status: "configured",
        health: "healthy",
        secretRefs: [cid],
        metadata: { envMap: { client_id: "GOOGLE_WORKSPACE_CLI_CLIENT_ID" } }
      }));
    });
    const skill = newSkill({
      source: "user",
      requiredCredentials: ["google-workspace-oauth"],
      prerequisites: { env: ["GOOGLE_WORKSPACE_CLI_CLIENT_ID"] }
    });
    const env = await resolveSkillEnv(configFor(instance), skill);
    expect(env).toEqual({});
  });

  test("disabled named connector does NOT inject its secret", async () => {
    const instance = "name-apikey-disabled";
    const ref = writeSecret(instance, "id_linear", "token", "leaked-token");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_linear",
        instance,
        name: "LINEAR_API_KEY",
        type: "api-key",
        provider: "linear",
        status: "disabled",
        health: "healthy",
        secretRefs: [ref]
      }));
    });
    const skill = newSkill({
      source: "bundled",
      requiredCredentials: ["LINEAR_API_KEY"],
      prerequisites: { env: ["LINEAR_API_KEY"] }
    });
    const env = await resolveSkillEnv(configFor(instance), skill);
    expect(env).toEqual({});
  });
});
