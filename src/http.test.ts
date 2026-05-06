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
