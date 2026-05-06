import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createHandler } from "./http";
import { readState } from "./state";
import type { RuntimeConfig } from "./types";

describe("runtime api", () => {
  test("applies approved improvement proposals and audits the decision", async () => {
    const config = testConfig("improvement-approve");
    const handler = createHandler(config);

    const proposal = await call(handler, config, "/api/improvements", {
      method: "POST",
      body: JSON.stringify({
        kind: "skill",
        title: "review-traces",
        rationale: "Trace evidence shows repeated review steps.",
        payload: { name: "review-traces", steps: ["Inspect trace", "Summarize evidence"] }
      })
    });

    const applied = await call(handler, config, `/api/improvements/${proposal.id}/approve`, { method: "POST" });
    const state = readState(config.lane);

    expect(applied.status).toBe("applied");
    expect(applied.appliedTargetId).toBeString();
    expect(state.skills.some((skill) => skill.id === applied.appliedTargetId)).toBe(true);
    expect(state.audit.some((event) => event.action === "improvement.applied")).toBe(true);
  });

  test("rejected improvement proposals do not mutate target stores", async () => {
    const config = testConfig("improvement-reject");
    const handler = createHandler(config);

    const proposal = await call(handler, config, "/api/improvements", {
      method: "POST",
      body: JSON.stringify({
        kind: "memory",
        title: "Remember review preference",
        payload: { content: "Prefer evidence-backed reviews." }
      })
    });

    const rejected = await call(handler, config, `/api/improvements/${proposal.id}/reject`, { method: "POST" });
    const state = readState(config.lane);

    expect(rejected.status).toBe("rejected");
    expect(state.memories).toHaveLength(0);
    expect(state.audit.some((event) => event.action === "improvement.rejected")).toBe(true);
  });

  test("pairs devices with one-time codes and redacts stored secrets", async () => {
    const config = testConfig("pairing");
    const handler = createHandler(config);

    const pairing = await call(handler, config, "/api/pairing", { method: "POST", body: JSON.stringify({ ttlSeconds: 60 }) });
    const claimed = await callPublic(handler, config, "/api/pairing/claim", {
      method: "POST",
      body: JSON.stringify({ code: pairing.code, deviceName: "Test phone" })
    });
    const mobile = await callWithToken(handler, config, claimed.token, "/api/mobile/bootstrap");
    const devices = await call(handler, config, "/api/devices");
    const state = await call(handler, config, "/api/state");

    expect(mobile.lane).toBe(config.lane);
    expect(devices[0].name).toBe("Test phone");
    expect(JSON.stringify(state)).not.toContain("tokenHash");
    expect(JSON.stringify(state)).not.toContain("codeHash");
    expect(JSON.stringify(state)).not.toContain(claimed.token);
  });

  test("revoked device tokens cannot use mobile contracts", async () => {
    const config = testConfig("pairing-revoke");
    const handler = createHandler(config);

    const pairing = await call(handler, config, "/api/pairing", { method: "POST" });
    const claimed = await callPublic(handler, config, "/api/pairing/claim", {
      method: "POST",
      body: JSON.stringify({ code: pairing.code, deviceName: "Revoked phone" })
    });
    await call(handler, config, `/api/devices/${claimed.device.id}/revoke`, { method: "POST" });
    const response = await rawCall(handler, config, "/api/mobile/bootstrap", {}, claimed.token);

    expect(response.status).toBe(401);
  });

  test("records promotion proposals without applying upgrades", async () => {
    const config = testConfig("promotion");
    const handler = createHandler(config);

    const proposal = await call(handler, config, "/api/promotions", {
      method: "POST",
      body: JSON.stringify({
        candidateRef: "commit-abc",
        evidencePath: "/tmp/evidence.json",
        summary: "Candidate passed sandbox smoke.",
        rollbackPlan: "Restore snapshot snap_abc."
      })
    });
    const rejected = await call(handler, config, `/api/promotions/${proposal.id}/reject`, { method: "POST" });

    expect(rejected.status).toBe("rejected");
    expect(rejected.candidateRef).toBe("commit-abc");
    expect(readState(config.lane).audit.some((event) => event.action === "promotion.rejected")).toBe(true);
  });

  test("supports Hermes-parity control records for search, toolsets, subagents, MCP, messaging, and imports", async () => {
    const config = testConfig("hermes-parity");
    const handler = createHandler(config);

    const task = await call(handler, config, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ input: "remember Hermes parity should be searchable" })
    });
    await Bun.sleep(30);

    const search = await call(handler, config, "/api/search?q=Hermes");
    const toolsets = await call(handler, config, "/api/toolsets");
    const disabled = await call(handler, config, "/api/toolsets/messaging/disable", { method: "POST" });
    const subagent = await call(handler, config, "/api/subagents", {
      method: "POST",
      body: JSON.stringify({ name: "reviewer", prompt: "review Hermes parity", parentTaskId: task.id, toolsets: ["memory"] })
    });
    const mcp = await call(handler, config, "/api/mcp", {
      method: "POST",
      body: JSON.stringify({ name: "demo-mcp", command: "echo", args: ["ok"], exposedTools: ["demo.echo"] })
    });
    const bridge = await call(handler, config, "/api/messaging", {
      method: "POST",
      body: JSON.stringify({ name: "demo-bridge", kind: "demo", deliveryTargets: ["local"] })
    });
    const report = await call(handler, config, "/api/imports/inspect", {
      method: "POST",
      body: JSON.stringify({ source: "hermes", path: process.cwd() })
    });

    expect(search.length).toBeGreaterThan(0);
    expect(toolsets.toolsets.some((item: { name: string }) => item.name === "session_search")).toBe(true);
    expect(disabled.status).toBe("disabled");
    expect(subagent.taskId).toBeString();
    expect(mcp.status).toBe("configured");
    expect(bridge.status).toBe("configured");
    expect(report.status).toBe("completed");
  });
});

async function call(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, path: string, init: RequestInit = {}) {
  return callWithToken(handler, config, config.token, path, init);
}

async function callWithToken(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, token: string, path: string, init: RequestInit = {}) {
  const response = await rawCall(handler, config, path, init, token);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}

async function callPublic(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, path: string, init: RequestInit = {}) {
  const response = await rawCall(handler, config, path, init);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}

async function rawCall(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, path: string, init: RequestInit = {}, token?: string) {
  const response = await handler(new Request(`http://127.0.0.1:${config.port}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) }
  }));
  return response;
}

function testConfig(lane: string): RuntimeConfig {
  const root = `/tmp/gini-http-test-${lane}`;
  rmSync(root, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = root;
  process.env.GINI_LOG_ROOT = `${root}-logs`;
  return {
    lane,
    port: 7337,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: `${root}/${lane}`,
    logRoot: `${root}-logs/${lane}`
  };
}
