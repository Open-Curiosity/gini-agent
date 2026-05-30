import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createSkill, mutateState, readState } from "../state";
import type { RuntimeConfig, SkillRecord } from "../types";
import { grantConnectorToSkill, revokeConnectorGrant, setSkillStatus, updateSkill } from "./skills";

const ROOT = "/tmp/gini-skills-capability-unit";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function config(instance: string): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "t",
    provider: { name: "echo", model: "" },
    workspaceRoot: `${ROOT}/${instance}/workspace`,
    stateRoot: `${ROOT}/${instance}`,
    logRoot: `${ROOT}/${instance}/logs`
  };
}

async function seedSkill(instance: string, overrides: Partial<SkillRecord>) {
  return mutateState(instance, (state) =>
    createSkill(state, {
      name: "test-skill",
      description: "",
      trigger: "",
      steps: [],
      requiredTools: [],
      requiredPermissions: [],
      status: "disabled",
      source: "user",
      requiredConnectors: [{ provider: "linear" }],
      ...overrides
    })
  );
}

describe("grantConnectorToSkill / revokeConnectorGrant", () => {
  test("grant appends the provider and writes an audit row; idempotent", async () => {
    const instance = "skills-grant";
    const skill = await seedSkill(instance, {});
    const granted = await grantConnectorToSkill(config(instance), skill.id, "linear");
    expect(granted.grantedConnectors).toEqual(["linear"]);
    // Re-granting the same provider is a no-op (no duplicate entry).
    const again = await grantConnectorToSkill(config(instance), skill.id, "linear");
    expect(again.grantedConnectors).toEqual(["linear"]);
    const state = readState(instance);
    expect(state.audit.filter((a) => a.action === "skill.connector.granted").length).toBe(1);
  });

  test("revoke removes the provider and writes an audit row", async () => {
    const instance = "skills-revoke";
    const skill = await seedSkill(instance, { grantedConnectors: ["linear"] });
    const revoked = await revokeConnectorGrant(config(instance), skill.id, "linear");
    expect(revoked.grantedConnectors).toEqual([]);
    const state = readState(instance);
    expect(state.audit.some((a) => a.action === "skill.connector.revoked")).toBe(true);
  });
});

describe("setSkillStatus disable transition", () => {
  test("disabling a skill clears its connector grants and emits a revoked audit per provider", async () => {
    const instance = "skills-disable-clears";
    const skill = await seedSkill(instance, { status: "enabled", grantedConnectors: ["linear", "generic"] });
    const disabled = await setSkillStatus(config(instance), skill.id, "disabled");
    expect(disabled.status).toBe("disabled");
    expect(disabled.grantedConnectors).toEqual([]);
    const state = readState(instance);
    const revoked = state.audit.filter((a) => a.action === "skill.connector.revoked" && a.target === skill.id);
    expect(revoked.length).toBe(2);
  });

  test("enabling a skill leaves grants untouched", async () => {
    const instance = "skills-enable-keeps";
    const skill = await seedSkill(instance, { status: "disabled", grantedConnectors: ["linear"] });
    const enabled = await setSkillStatus(config(instance), skill.id, "enabled");
    expect(enabled.status).toBe("enabled");
    expect(enabled.grantedConnectors).toEqual(["linear"]);
  });
});

describe("updateSkill status-only PATCH disable", () => {
  test("disabling via PATCH clears connector grants and emits a revoked audit", async () => {
    const instance = "skills-patch-disable-clears";
    const skill = await seedSkill(instance, { status: "enabled", grantedConnectors: ["linear"] });
    const disabled = await updateSkill(config(instance), skill.id, { status: "disabled" });
    expect(disabled.status).toBe("disabled");
    expect(disabled.grantedConnectors).toEqual([]);
    const state = readState(instance);
    expect(state.audit.some((a) => a.action === "skill.connector.revoked" && a.target === skill.id)).toBe(true);
  });
});
