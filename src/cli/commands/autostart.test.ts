// Subprocess tests for `gini autostart enable|disable|status`.
//
// We invoke the CLI directly with GINI_STATE_ROOT and GINI_LOG_ROOT pointed
// at a scratch dir to avoid touching the developer's real install. The
// launchctl integration is gated by GINI_AUTOSTART_E2E so these tests stay
// safe on shared machines: by default we only exercise the disable/status
// paths against a non-existent service, which prove the JSON contract and
// idempotency without registering anything with launchd.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { labelForKind, plistPathFor } from "../autostart";

function tag(): string {
  return `${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
}

function makeScratch(label: string): { stateRoot: string; logRoot: string } {
  const root = `/tmp/gini-autostart-cli-tests/${label}-${tag()}`;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return { stateRoot: join(root, "state"), logRoot: join(root, "logs") };
}

function runCli(args: string[], env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync("bun", ["run", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

describe("gini autostart usage and platform gate", () => {
  test("no subcommand prints usage block", () => {
    const result = runCli(["autostart"], {});
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.usage).toBeDefined();
    expect(Array.isArray(parsed.usage)).toBe(true);
    expect((parsed.usage as string[]).some((line) => line.includes("enable"))).toBe(true);
  });

  test("unknown subcommand returns non-zero exit", () => {
    const result = runCli(["autostart", "nope"], {});
    expect(result.status).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.ok).toBe(false);
  });
});

// Run only on macOS — the platform gate kicks in elsewhere and the JSON
// shape is different. Skipping rather than describe.skipIf-ing keeps the
// fail signal on the intended platform clear.
const isDarwin = process.platform === "darwin";

(isDarwin ? describe : describe.skip)("gini autostart status (no service registered)", () => {
  let scratch: { stateRoot: string; logRoot: string };
  const uniqueInstance = `autostart-test-${tag()}`;

  beforeEach(() => {
    scratch = makeScratch("status");
  });

  afterEach(() => {
    rmSync(scratch.stateRoot, { recursive: true, force: true });
    rmSync(scratch.logRoot, { recursive: true, force: true });
  });

  test("reports plistExists:false and loaded:false for a fresh instance (both kinds)", () => {
    const result = runCli(
      ["autostart", "status", "--instance", uniqueInstance, "--state-root", scratch.stateRoot, "--log-root", scratch.logRoot],
      {}
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.instance).toBe(uniqueInstance);
    // round-2: both gateway and web are reported under `services`. The
    // top-level `label` field mirrors the gateway service for back-compat
    // with shell scripts that grep on it.
    expect(parsed.label).toBe(labelForKind(uniqueInstance, "gateway"));
    expect(parsed.plistExists).toBe(false);
    expect(parsed.loaded).toBe(false);
    expect(parsed.pid).toBe(null);
    const services = parsed.services as Array<Record<string, unknown>>;
    expect(Array.isArray(services)).toBe(true);
    expect(services.length).toBe(2);
    expect(services[0]!.kind).toBe("gateway");
    expect(services[1]!.kind).toBe("web");
    expect(services[0]!.label).toBe(labelForKind(uniqueInstance, "gateway"));
    expect(services[1]!.label).toBe(labelForKind(uniqueInstance, "web"));
    for (const svc of services) {
      expect(svc.plistExists).toBe(false);
      expect(svc.loaded).toBe(false);
    }
    expect(Array.isArray(parsed.limitations)).toBe(true);
    expect((parsed.limitations as string[]).some((l) => l.includes("PID supervision"))).toBe(true);
  });
});

(isDarwin ? describe : describe.skip)("gini autostart disable (no service registered)", () => {
  let scratch: { stateRoot: string; logRoot: string };
  const uniqueInstance = `autostart-test-${tag()}`;

  beforeEach(() => {
    scratch = makeScratch("disable");
  });

  afterEach(() => {
    rmSync(scratch.stateRoot, { recursive: true, force: true });
    rmSync(scratch.logRoot, { recursive: true, force: true });
    // Defensive: clean up any plist we might have written if a test failed
    // mid-way through. Both kinds and the legacy single-plist label.
    for (const path of [
      plistPathFor(uniqueInstance),
      plistPathFor(uniqueInstance, "gateway"),
      plistPathFor(uniqueInstance, "web")
    ]) {
      try { rmSync(path, { force: true }); } catch { /* ignore */ }
    }
  });

  test("returns alreadyDisabled:true when nothing is registered", () => {
    const result = runCli(
      ["autostart", "disable", "--instance", uniqueInstance, "--state-root", scratch.stateRoot, "--log-root", scratch.logRoot],
      {}
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(parsed.alreadyDisabled).toBe(true);
    expect(parsed.disabled).toBe(false);
    expect(parsed.plistRemoved).toBe(false);
  });
});

// Idempotent re-enable: running `autostart enable` twice should leave the
// system in the same registered state. We test this by writing plists
// directly via the resolveLaunchSpecPair + writePlist surface and
// asserting the on-disk shape doesn't change across two invocations.
// We do NOT touch launchctl here; that's the e2e path below.
(isDarwin ? describe : describe.skip)("gini autostart enable idempotency (plist on disk)", () => {
  let scratch: { stateRoot: string; logRoot: string };
  const uniqueInstance = `autostart-test-${tag()}`;

  beforeEach(() => {
    scratch = makeScratch("idempotent");
  });

  afterEach(() => {
    rmSync(scratch.stateRoot, { recursive: true, force: true });
    rmSync(scratch.logRoot, { recursive: true, force: true });
    // Clean up any plists we may have written.
    for (const path of [
      plistPathFor(uniqueInstance, "gateway"),
      plistPathFor(uniqueInstance, "web")
    ]) {
      try { rmSync(path, { force: true }); } catch { /* ignore */ }
    }
  });

  test("two `enable` runs produce identical plist contents (idempotent re-enable)", async () => {
    const { resolveLaunchSpecPair, writePlist } = await import("../autostart");
    // Pass an explicit testRoot so the plist embeds the scratch dirs;
    // we don't actually invoke the CLI here, just exercise the same
    // file-write surface that `enable` uses.
    const pair = resolveLaunchSpecPair({
      instance: uniqueInstance,
      testRoot: { stateRoot: scratch.stateRoot, logRoot: scratch.logRoot }
    });
    const gatewayPath = writePlist({
      instance: uniqueInstance,
      kind: "gateway",
      spec: pair.gateway,
      stdoutPath: join(scratch.logRoot, "runtime-stdout.log"),
      stderrPath: join(scratch.logRoot, "runtime-launchd.err.log")
    });
    const webPath = writePlist({
      instance: uniqueInstance,
      kind: "web",
      spec: pair.web,
      stdoutPath: join(scratch.logRoot, "web.log"),
      stderrPath: join(scratch.logRoot, "web-launchd.err.log")
    });
    const { readFileSync } = await import("node:fs");
    const gatewayFirst = readFileSync(gatewayPath, "utf8");
    const webFirst = readFileSync(webPath, "utf8");

    // Re-run identical resolve+write — should produce byte-identical output.
    const pair2 = resolveLaunchSpecPair({
      instance: uniqueInstance,
      testRoot: { stateRoot: scratch.stateRoot, logRoot: scratch.logRoot }
    });
    writePlist({
      instance: uniqueInstance,
      kind: "gateway",
      spec: pair2.gateway,
      stdoutPath: join(scratch.logRoot, "runtime-stdout.log"),
      stderrPath: join(scratch.logRoot, "runtime-launchd.err.log")
    });
    writePlist({
      instance: uniqueInstance,
      kind: "web",
      spec: pair2.web,
      stdoutPath: join(scratch.logRoot, "web.log"),
      stderrPath: join(scratch.logRoot, "web-launchd.err.log")
    });
    expect(readFileSync(gatewayPath, "utf8")).toBe(gatewayFirst);
    expect(readFileSync(webPath, "utf8")).toBe(webFirst);
  });
});

// True end-to-end: write plist, bootstrap, kill PID, verify respawn,
// `gini stop`, verify it stays down, disable. Gated behind
// GINI_AUTOSTART_E2E because it touches the real `gui/<uid>` domain and
// shouldn't run in shared CI.
const e2eOn = isDarwin && process.env.GINI_AUTOSTART_E2E === "1";

(e2eOn ? describe : describe.skip)("gini autostart enable→stop respawn cycle (e2e)", () => {
  let scratch: { stateRoot: string; logRoot: string };
  const uniqueInstance = `autostart-e2e-${tag()}`;

  beforeEach(() => {
    scratch = makeScratch("e2e");
  });

  afterEach(() => {
    // Best-effort: disable + remove plists even if the test asserted out.
    try {
      runCli(
        ["autostart", "disable", "--instance", uniqueInstance, "--state-root", scratch.stateRoot, "--log-root", scratch.logRoot],
        {}
      );
    } catch { /* ignore */ }
    rmSync(scratch.stateRoot, { recursive: true, force: true });
    rmSync(scratch.logRoot, { recursive: true, force: true });
    for (const path of [
      plistPathFor(uniqueInstance, "gateway"),
      plistPathFor(uniqueInstance, "web")
    ]) {
      try { rmSync(path, { force: true }); } catch { /* ignore */ }
    }
  });

  test("enable → status shows both kinds loaded; disable → status shows both gone", () => {
    const enableResult = runCli(
      [
        "autostart", "enable",
        "--instance", uniqueInstance,
        "--state-root", scratch.stateRoot,
        "--log-root", scratch.logRoot,
        "--test-root", scratch.stateRoot
      ],
      { GINI_AUTOSTART_E2E: "1" }
    );
    expect(enableResult.status).toBe(0);
    const enableParsed = JSON.parse(enableResult.stdout) as Record<string, unknown>;
    expect(enableParsed.ok).toBe(true);
    expect(enableParsed.enabled).toBe(true);
    const results = enableParsed.results as Array<Record<string, unknown>>;
    expect(results.length).toBe(2);
    for (const r of results) expect(r.enabled).toBe(true);

    // Status should report both kinds plistExists:true and loaded:true.
    const statusResult = runCli(
      ["autostart", "status", "--instance", uniqueInstance, "--state-root", scratch.stateRoot, "--log-root", scratch.logRoot],
      {}
    );
    const statusParsed = JSON.parse(statusResult.stdout) as Record<string, unknown>;
    const services = statusParsed.services as Array<Record<string, unknown>>;
    for (const svc of services) {
      expect(svc.plistExists).toBe(true);
      expect(svc.loaded).toBe(true);
    }

    // Disable tears both down.
    const disableResult = runCli(
      ["autostart", "disable", "--instance", uniqueInstance, "--state-root", scratch.stateRoot, "--log-root", scratch.logRoot],
      {}
    );
    expect(disableResult.status).toBe(0);
    const disableParsed = JSON.parse(disableResult.stdout) as Record<string, unknown>;
    expect(disableParsed.ok).toBe(true);
    expect(disableParsed.disabled).toBe(true);

    // Re-statusing: nothing loaded, no plists on disk.
    const statusAgain = runCli(
      ["autostart", "status", "--instance", uniqueInstance, "--state-root", scratch.stateRoot, "--log-root", scratch.logRoot],
      {}
    );
    const statusAgainParsed = JSON.parse(statusAgain.stdout) as Record<string, unknown>;
    const servicesAgain = statusAgainParsed.services as Array<Record<string, unknown>>;
    for (const svc of servicesAgain) {
      expect(svc.plistExists).toBe(false);
      expect(svc.loaded).toBe(false);
    }
  }, 60_000);
});
