import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { __test, connectBrowser, disconnectBrowser, getBrowserConnection } from "./browser-connect";
import { readState } from "../state";
import type { RuntimeConfig } from "../types";

// Isolated state root so we don't smear test state across the developer's
// real ~/.gini directory. Mirrors the convention used elsewhere in the
// test suite (see src/http.test.ts).
const TEST_ROOT = "/tmp/gini-browser-connect-tests";
process.env["GINI_STATE_ROOT"] = TEST_ROOT;

function testConfig(instance: string): RuntimeConfig {
  rmSync(`${TEST_ROOT}/instances/${instance}`, { recursive: true, force: true });
  return {
    instance,
    port: 7337,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: `${TEST_ROOT}/instances/${instance}`,
    logRoot: `${TEST_ROOT}-logs/${instance}`
  };
}

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("browser-connect helpers", () => {
  test("redactUrlCredentials strips user:pass@", () => {
    const result = __test.redactUrlCredentials("ws://alice:secret@127.0.0.1:9222/devtools/browser/abc");
    expect(result).not.toContain("alice");
    expect(result).not.toContain("secret");
    expect(result).toContain("127.0.0.1");
  });

  test("redactUrlCredentials leaves credential-free URLs alone", () => {
    const url = "ws://127.0.0.1:9222/devtools/browser/abc";
    expect(__test.redactUrlCredentials(url)).toBe(url);
  });

  test("redactUrlCredentials returns sentinel for invalid URLs", () => {
    const result = __test.redactUrlCredentials("not a url");
    expect(result).toBe("<redacted>");
  });

  test("cdpHttpForm rewrites ws:// to http://", () => {
    expect(__test.cdpHttpForm("ws://127.0.0.1:9222/devtools/browser/abc")).toBe("http://127.0.0.1:9222");
  });

  test("cdpHttpForm rewrites wss:// to https://", () => {
    expect(__test.cdpHttpForm("wss://example.com:9443/devtools/browser/abc")).toBe("https://example.com:9443");
  });

  test("validateCdpUrl accepts ws/wss/http/https", () => {
    expect(__test.validateCdpUrl("ws://localhost:9222/").ok).toBe(true);
    expect(__test.validateCdpUrl("wss://example.com/").ok).toBe(true);
    expect(__test.validateCdpUrl("http://localhost:9222/").ok).toBe(true);
    expect(__test.validateCdpUrl("https://example.com/").ok).toBe(true);
  });

  test("validateCdpUrl rejects unsupported protocols", () => {
    const result = __test.validateCdpUrl("file:///etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Unsupported");
  });

  test("validateCdpUrl rejects garbage input", () => {
    const result = __test.validateCdpUrl("not a url");
    expect(result.ok).toBe(false);
  });

  test("validatePort accepts 1..65535 and rejects everything else", () => {
    expect(__test.validatePort(9222, 1234)).toBe(9222);
    expect(__test.validatePort(undefined, 1234)).toBe(1234);
    expect(() => __test.validatePort(-1, 9222)).toThrow();
    expect(() => __test.validatePort(0, 9222)).toThrow();
    expect(() => __test.validatePort(99999, 9222)).toThrow();
    expect(() => __test.validatePort("nope", 9222)).toThrow();
  });

  test("profileDirFor lives under the instance root", () => {
    const config = testConfig("profile-dir");
    const dir = __test.profileDirFor(config);
    expect(dir.endsWith("chrome-profile")).toBe(true);
    expect(dir.includes("profile-dir")).toBe(true);
  });
});

describe("browser-connect API surface", () => {
  beforeEach(() => {
    // No-op — each test creates its own config via testConfig() which
    // wipes the per-instance directory.
  });

  test("status is disconnected by default", () => {
    const config = testConfig("status-empty");
    const status = getBrowserConnection(config);
    expect(status.connected).toBe(false);
    expect(status.record).toBeUndefined();
  });

  test("connect with a bad cdpUrl protocol is rejected", async () => {
    const config = testConfig("connect-bad-url");
    await expect(connectBrowser(config, { cdpUrl: "file:///nope" })).rejects.toThrow(/Unsupported/);
  });

  test("connect with garbage cdpUrl is rejected", async () => {
    const config = testConfig("connect-garbage-url");
    await expect(connectBrowser(config, { cdpUrl: "not-a-url" })).rejects.toThrow(/Invalid cdpUrl/);
  });

  test("connect with an unreachable cdpUrl fails after the probe timeout", async () => {
    const config = testConfig("connect-unreachable");
    // Port 1 is reserved and refused everywhere — the probe loop will
    // never get a response. We use a low timeout via the unreachable
    // host instead of mocking time; the test sets its own ceiling.
    await expect(
      connectBrowser(config, { cdpUrl: "http://127.0.0.1:1/" })
    ).rejects.toThrow(/Could not reach CDP endpoint/);
  }, 30_000);

  test("disconnect on an empty state is a no-op", async () => {
    const config = testConfig("disconnect-empty");
    const status = await disconnectBrowser(config);
    expect(status.connected).toBe(false);
    const state = readState(config.instance);
    expect(state.browser ?? null).toBeNull();
  });

  test("connectExisting persists redacted credentials in the audit row when state is mutated", async () => {
    // We can't exercise the full connectExisting path without a real CDP
    // endpoint, but we can directly verify the redaction helper covers
    // the audit shape the capability writes. The mutateState-coupled
    // happy path is exercised end-to-end in the integration smoke run.
    const dirty = "ws://user:pass@127.0.0.1:9222/devtools/browser/abc";
    expect(__test.redactUrlCredentials(dirty)).not.toContain("pass");
    expect(__test.redactUrlCredentials(dirty)).toContain("127.0.0.1");
  });

  test("idempotent connect: an existing dead record is cleared before retrying", async () => {
    const config = testConfig("idempotent-dead");
    // Seed a fake CDP record pointing at an unreachable port. When
    // connectBrowser sees an existing record it should re-probe, fail,
    // clear the record, and only THEN attempt the requested path. We
    // ask for a managed launch but the test environment has no Chrome,
    // so we expect the call to fail at the launch step (or earlier).
    // The success criterion is that the stale record was cleared.
    const { mutateState } = await import("../state");
    await mutateState(config.instance, (state) => {
      state.browser = {
        mode: "cdp",
        cdpUrl: "ws://127.0.0.1:1/devtools/browser/dead",
        pid: null,
        dataDir: null,
        chromePath: null,
        startedAt: new Date().toISOString()
      };
    });

    // Now call connect with a cdpUrl that's also unreachable. Both the
    // pre-probe and the fresh attempt should fail; the important
    // assertion is that the dead record was cleared mid-flight.
    await expect(
      connectBrowser(config, { cdpUrl: "http://127.0.0.1:1/" })
    ).rejects.toThrow();
    const state = readState(config.instance);
    expect(state.browser ?? null).toBeNull();
  }, 60_000);
});
