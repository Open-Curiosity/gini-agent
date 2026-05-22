import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeTunnelState } from "./runtime";

// runtimeTunnelState reads the tunnel slot out of config.json on demand.
// The previous implementation required the runtime to inject
// GINI_TUNNEL_SECRET into the spawned web process at start time, which
// dropped the secret in two failure modes:
//
//   1. First-boot race: the gateway minted the secret AFTER `gini start`
//      had already spawned the web with an empty env.
//   2. Autostart: the launchd web plist did not propagate runtime env
//      variables at all, so the supervised web never saw the secret.
//
// Reading from config.json on each request (with the helper's mtime
// cache for cheap repeated reads) keeps the proxy in lockstep with the
// gateway's source of truth.
//
// Test layout: each test runs against a UNIQUE state root + UNIQUE
// instance name so the production-side mtime cache (a module-level Map
// keyed by absolute config path in lib/runtime.ts) cannot return a
// stale entry from a prior test. Reusing one path with sequential
// rmSync+write cycles risked a flake on filesystems where two writes
// within the same millisecond produced identical statSync().mtimeMs —
// the cache would serve the previous test's body.

let suiteRoot: string;
const envSnapshot: { instance: string | undefined; root: string | undefined } = {
  instance: undefined,
  root: undefined
};

beforeAll(() => {
  envSnapshot.instance = process.env.GINI_INSTANCE;
  envSnapshot.root = process.env.GINI_STATE_ROOT;
  suiteRoot = mkdtempSync(join(tmpdir(), "gini-runtime-tunnel-state-"));
});

afterAll(() => {
  rmSync(suiteRoot, { recursive: true, force: true });
  // Restore env so a later suite that depends on the original values
  // doesn't see this suite's overrides.
  if (envSnapshot.instance === undefined) delete process.env.GINI_INSTANCE;
  else process.env.GINI_INSTANCE = envSnapshot.instance;
  if (envSnapshot.root === undefined) delete process.env.GINI_STATE_ROOT;
  else process.env.GINI_STATE_ROOT = envSnapshot.root;
});

let instanceCounter = 0;
let currentInstance: string;

function withConfig(tunnel: unknown): void {
  const instanceDir = join(suiteRoot, "instances", currentInstance);
  mkdirSync(instanceDir, { recursive: true });
  writeFileSync(
    join(instanceDir, "config.json"),
    JSON.stringify({ instance: currentInstance, tunnel }, null, 2)
  );
}

describe("runtimeTunnelState", () => {
  beforeEach(() => {
    instanceCounter += 1;
    currentInstance = `tunnel-state-test-${instanceCounter}`;
    process.env.GINI_INSTANCE = currentInstance;
    process.env.GINI_STATE_ROOT = suiteRoot;
  });

  afterEach(() => {
    // Tear down the per-test instance dir so we don't accumulate state,
    // but leave suiteRoot intact for the remaining tests.
    rmSync(join(suiteRoot, "instances", currentInstance), { recursive: true, force: true });
  });

  test("returns disabled + empty when config.json is missing", () => {
    const state = runtimeTunnelState();
    expect(state).toEqual({ enabled: false, secret: "" });
  });

  test("returns disabled when the tunnel slot is absent", () => {
    withConfig(undefined);
    expect(runtimeTunnelState()).toEqual({ enabled: false, secret: "" });
  });

  test("returns enabled+secret for a fully-configured tunnel", () => {
    withConfig({ enabled: true, secret: "abcdefghij0123456789" });
    expect(runtimeTunnelState()).toEqual({
      enabled: true,
      secret: "abcdefghij0123456789"
    });
  });

  test("treats enabled !== true as disabled", () => {
    withConfig({ enabled: "yes", secret: "abcdefghij0123456789" });
    const state = runtimeTunnelState();
    expect(state.enabled).toBe(false);
    expect(state.secret).toBe("abcdefghij0123456789");
  });

  test("ignores non-string secrets", () => {
    withConfig({ enabled: true, secret: 12345 });
    expect(runtimeTunnelState()).toEqual({ enabled: true, secret: "" });
  });

  test("returns disabled when config.json is invalid JSON", () => {
    const instanceDir = join(suiteRoot, "instances", currentInstance);
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(join(instanceDir, "config.json"), "{ not valid");
    expect(runtimeTunnelState()).toEqual({ enabled: false, secret: "" });
  });
});
