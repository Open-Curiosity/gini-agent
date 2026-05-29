import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createEmptyState, mutateState } from "../../state";
import { writeSecret } from "../../state/secrets";
import type { ConnectorRecord, SkillRecord } from "../../types";
import { isSkillActive, resolveSkillEnv } from "./index";

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
      requiredConnectors: [{ provider: "generic" }],
      prerequisites: { env: ["MY_API_KEY"] }
    });
    const env = await resolveSkillEnv(config, skill);
    expect(env).toEqual({});
  });
});
