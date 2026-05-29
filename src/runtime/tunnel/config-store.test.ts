// Unit tests for the tunnel config store's parse-failure recovery.
// Pins two invariants:
//   1. A corrupted config.json returns the safe default (re-mints on next
//      write) rather than throwing — the runtime must boot.
//   2. The recovery path completes within a small wall-clock budget so
//      a future change can't reintroduce a busy-loop CPU pin.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTunnelConfig } from "./config-store";

const INSTANCE = "config-store-test";

const HEALTHY_BODY = {
  tunnel: {
    enabled: true,
    secret: "totally-not-random-but-fine-for-tests",
    appleNotes: { enabled: false }
  }
};

describe("readTunnelConfig parse-failure recovery", () => {
  let tmp: string;
  let prevStateRoot: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gini-config-store-"));
    prevStateRoot = process.env.GINI_STATE_ROOT;
    process.env.GINI_STATE_ROOT = tmp;
    const instanceDir = join(tmp, "instances", INSTANCE);
    mkdirSync(instanceDir, { recursive: true });
  });

  afterEach(() => {
    if (prevStateRoot === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevStateRoot;
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeBody(body: string) {
    const path = join(tmp, "instances", INSTANCE, "config.json");
    writeFileSync(path, body, "utf8");
  }

  test("returns safe defaults when config.json is missing", () => {
    const result = readTunnelConfig(INSTANCE);
    expect(result.enabled).toBe(false);
    expect(typeof result.secret).toBe("string");
    expect(result.secret.length).toBeGreaterThan(0);
    expect(result.appleNotes.enabled).toBe(false);
  });

  test("returns parsed tunnel block when config.json is valid", () => {
    writeBody(JSON.stringify(HEALTHY_BODY));
    const result = readTunnelConfig(INSTANCE);
    expect(result.enabled).toBe(true);
    expect(result.secret).toBe(HEALTHY_BODY.tunnel.secret);
    expect(result.appleNotes.enabled).toBe(false);
  });

  test("falls back to safe defaults and completes promptly when config.json is corrupted", () => {
    writeBody("{ not valid json ::::");
    const t0 = Date.now();
    const result = readTunnelConfig(INSTANCE);
    const elapsed = Date.now() - t0;
    // Safe default surfaced; the busy-loop is gone, so the elapsed
    // wall-clock stays well under any busy-loop's wall-clock.
    expect(result.enabled).toBe(false);
    expect(typeof result.secret).toBe("string");
    expect(result.secret.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(250);
  });
});
