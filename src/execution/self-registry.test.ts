// Coverage for the self-config / introspection registry and its
// discover/invoke dispatch surface.
//
// The registry (self-registry.ts) is the single source of truth for the
// self-config operations; dispatch (tool-dispatch.ts) exposes them through
// two always-on meta-tools. The index/find helpers are pure; the
// dispatch-level tests exercise the validate-and-route logic (unknown name,
// query sync, mutate gated-vs-auto) against a seeded RuntimeConfig + state,
// reusing the same fixture shape as tool-dispatch.test.ts.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatSession, createTask, mutateState, readState, upsertTask } from "../state";
import type { RuntimeConfig } from "../types";
import { dispatchToolCall } from "./tool-dispatch";
import { findSelfOperation, selfOperationIndex, SELF_OPERATIONS } from "./self-registry";

const ROOT = mkdtempSync(join(tmpdir(), "gini-self-registry-"));
process.env.GINI_STATE_ROOT = ROOT;
process.env.GINI_LOG_ROOT = `${ROOT}/logs`;

function buildConfig(instance: string, approvalMode: RuntimeConfig["approvalMode"] = "auto"): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "t",
    provider: { name: "echo", model: "" },
    approvalMode,
    workspaceRoot: `${ROOT}/${instance}/workspace`,
    stateRoot: ROOT,
    logRoot: `${ROOT}/logs`
  };
}

async function newTask(config: RuntimeConfig): Promise<string> {
  const task = createTask(config.instance, "self-registry test");
  await mutateState(config.instance, (state) => {
    const session = createChatSession(state, "self-registry test session");
    task.chatSessionId = session.id;
    upsertTask(state, task);
  });
  return task.id;
}

describe("self operation registry", () => {
  test("selfOperationIndex returns all ops with name, summary, tag", () => {
    const index = selfOperationIndex();
    expect(index.length).toBe(SELF_OPERATIONS.length);
    expect(index.length).toBe(9);
    for (const entry of index) {
      expect(typeof entry.name).toBe("string");
      expect(entry.name.length).toBeGreaterThan(0);
      expect(typeof entry.summary).toBe("string");
      expect(entry.summary.length).toBeGreaterThan(0);
      expect(["query", "mutate"]).toContain(entry.tag);
    }
    const names = index.map((e) => e.name).sort();
    expect(names).toEqual(
      [
        "create_agent",
        "get_self",
        "list_agents",
        "list_connectors",
        "list_mcp_servers",
        "list_providers",
        "list_skills",
        "set_provider",
        "use_agent"
      ]
    );
  });

  test("selfOperationIndex filters by tag", () => {
    const queries = selfOperationIndex({ tag: "query" });
    const mutates = selfOperationIndex({ tag: "mutate" });
    expect(queries.every((op) => op.tag === "query")).toBe(true);
    expect(mutates.every((op) => op.tag === "mutate")).toBe(true);
    expect(queries.map((op) => op.name).sort()).toEqual([
      "get_self",
      "list_agents",
      "list_connectors",
      "list_mcp_servers",
      "list_providers",
      "list_skills"
    ]);
    expect(mutates.map((op) => op.name).sort()).toEqual(["create_agent", "set_provider", "use_agent"]);
  });

  test("findSelfOperation returns undefined for an unknown name", () => {
    expect(findSelfOperation("nope")).toBeUndefined();
    expect(findSelfOperation("get_self")).toBeDefined();
  });
});

describe("self_discover dispatch", () => {
  test("no args returns the index", async () => {
    const instance = `self-disc-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const result = await dispatchToolCall(config, taskId, "self_discover", "call_1", "{}");
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as Array<{ name: string; tag: string }>;
      expect(parsed.length).toBe(9);
    }
  });

  test("name arg returns one op's full schema", async () => {
    const instance = `self-disc-name-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const result = await dispatchToolCall(config, taskId, "self_discover", "call_1", JSON.stringify({ name: "set_provider" }));
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as { name: string; tag: string; schema: Record<string, unknown> };
      expect(parsed.name).toBe("set_provider");
      expect(parsed.tag).toBe("mutate");
      expect(parsed.schema.type).toBe("object");
    }
  });

  test("unknown name returns an error envelope with suggestions", async () => {
    const instance = `self-disc-unk-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const result = await dispatchToolCall(config, taskId, "self_discover", "call_1", JSON.stringify({ name: "list_provider" }));
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as { ok: boolean; didYouMean: string[] };
      expect(parsed.ok).toBe(false);
      expect(parsed.didYouMean).toContain("list_providers");
    }
  });
});

describe("self_invoke dispatch", () => {
  test("unknown op returns ok:false and does not throw", async () => {
    const instance = `self-inv-unk-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const result = await dispatchToolCall(config, taskId, "self_invoke", "call_1", JSON.stringify({ name: "frobnicate" }));
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as { ok: boolean; didYouMean: string[] };
      expect(parsed.ok).toBe(false);
    }
  });

  test("missing required arg returns the schema so the model can self-correct", async () => {
    const instance = `self-inv-missing-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    // use_agent requires agentId; omit it.
    const result = await dispatchToolCall(config, taskId, "self_invoke", "call_1", JSON.stringify({ name: "use_agent", args: {} }));
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as { ok: boolean; schema?: Record<string, unknown> };
      expect(parsed.ok).toBe(false);
      expect(parsed.schema).toBeDefined();
    }
  });

  test("query op (get_self) returns a sync result", async () => {
    const instance = `self-inv-get-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const result = await dispatchToolCall(config, taskId, "self_invoke", "call_1", JSON.stringify({ name: "get_self" }));
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as { ok: boolean; instance: string };
      expect(parsed.ok).toBe(true);
      expect(parsed.instance).toBe(instance);
    }
  });

  test("mutate op gates as pending in strict mode", async () => {
    const instance = `self-inv-strict-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "strict");
    const taskId = await newTask(config);
    const result = await dispatchToolCall(config, taskId, "self_invoke", "call_1", JSON.stringify({ name: "create_agent", args: { name: "Athena" } }));
    expect(result.kind).toBe("pending");
    if (result.kind === "pending") {
      const state = readState(instance);
      const approval = state.authorizations.find((a) => a.id === result.approvalId);
      expect(approval).toBeDefined();
      expect(approval?.action).toBe("self.config");
      expect(approval?.status).toBe("pending");
      expect(approval?.payload.opName).toBe("create_agent");
    }
  });

  test("mutate op auto-resolves in auto mode and runs the handler", async () => {
    const instance = `self-inv-auto-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "auto");
    const taskId = await newTask(config);
    const result = await dispatchToolCall(config, taskId, "self_invoke", "call_1", JSON.stringify({ name: "create_agent", args: { name: "Athena" } }));
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as { ok: boolean; agent?: { name: string } };
      expect(parsed.ok).toBe(true);
      expect(parsed.agent?.name).toBe("Athena");
    }
    // The side effect actually landed: a new agent row exists.
    const state = readState(instance);
    expect(state.agents.some((a) => a.name === "Athena")).toBe(true);
  });
});
