// Load-time approval-mode migration + fresh-instance default behavior.
//
// The two contracts pinned here:
//   1. A legacy config carrying `dangerouslyAutoApprove: true` without
//      an explicit `approvalMode` is aliased to `approvalMode: "yolo"`
//      on next install/restart, AND a one-time `config.migrated` audit
//      row records the change.
//   2. A fresh instance with no prior `config.json` defaults to
//      `approvalMode: "auto"` via `defaultConfig`/`loadConfig`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { install, migrateLegacyApprovalMode } from "./index";
import { configPath, defaultConfig, loadConfig } from "../paths";
import { readState } from "../state";
import type { RuntimeConfig } from "../types";

function writeConfig(instance: string, config: RuntimeConfig): void {
  const path = configPath(instance);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "gini-approval-migrate-"));
}

describe("approval-mode migration shim", () => {
  let root: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = makeRoot();
    prevState = process.env.GINI_STATE_ROOT;
    prevLog = process.env.GINI_LOG_ROOT;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = prevLog;
    rmSync(root, { recursive: true, force: true });
  });

  test("legacy dangerouslyAutoApprove: true (no approvalMode) aliases to yolo and emits config.migrated audit", async () => {
    const instance = "legacy-migrate";
    // Hand-roll the legacy on-disk config shape: no approvalMode field.
    const legacy = {
      ...defaultConfig(instance),
      dangerouslyAutoApprove: true
    } as RuntimeConfig;
    // Strip approvalMode so the file looks like a pre-flip install.
    delete (legacy as { approvalMode?: unknown }).approvalMode;
    writeConfig(instance, legacy);

    const loaded = loadConfig(instance);
    // loadConfig itself doesn't migrate; install runs the alias.
    install(loaded);
    // Wait for the fire-and-forget audit row to land.
    await migrateLegacyApprovalMode(loaded);

    // In-memory shape: alias applied.
    expect(loaded.approvalMode).toBe("yolo");
    expect(loaded.dangerouslyAutoApprove).toBe(true);

    // On-disk shape: the rewrite persisted approvalMode.
    const persisted = JSON.parse(readFileSync(configPath(instance), "utf8")) as RuntimeConfig;
    expect(persisted.approvalMode).toBe("yolo");

    // Audit row: exactly one config.migrated event referencing approvalMode.
    const state = readState(loaded.instance);
    const migrated = state.audit.filter((event) => event.action === "config.migrated");
    expect(migrated).toHaveLength(1);
    expect(migrated[0]?.target).toBe(instance);
    expect(migrated[0]?.evidence?.field).toBe("approvalMode");
    expect(migrated[0]?.evidence?.from).toBe("dangerouslyAutoApprove: true");
    expect(migrated[0]?.evidence?.to).toBe("yolo");
  });

  test("migration is idempotent: running install twice produces a single audit row", async () => {
    const instance = "legacy-migrate-idempotent";
    const legacy = {
      ...defaultConfig(instance),
      dangerouslyAutoApprove: true
    } as RuntimeConfig;
    delete (legacy as { approvalMode?: unknown }).approvalMode;
    writeConfig(instance, legacy);

    const loaded = loadConfig(instance);
    install(loaded);
    await migrateLegacyApprovalMode(loaded);
    // Second invocation should detect the existing audit row and skip.
    await migrateLegacyApprovalMode(loaded);

    const state = readState(loaded.instance);
    const migrated = state.audit.filter((event) => event.action === "config.migrated");
    expect(migrated).toHaveLength(1);
  });

  test("fresh install with no legacy flag does NOT emit config.migrated", async () => {
    const instance = "fresh-no-migration";
    // Default install — no legacy field at all.
    const fresh = defaultConfig(instance);
    writeConfig(instance, fresh);

    const loaded = loadConfig(instance);
    install(loaded);
    await migrateLegacyApprovalMode(loaded);

    expect(loaded.approvalMode).toBe("auto");
    const state = readState(loaded.instance);
    const migrated = state.audit.filter((event) => event.action === "config.migrated");
    expect(migrated).toHaveLength(0);
  });
});

describe("fresh-instance default approval mode", () => {
  let root: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = makeRoot();
    prevState = process.env.GINI_STATE_ROOT;
    prevLog = process.env.GINI_LOG_ROOT;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = prevLog;
    rmSync(root, { recursive: true, force: true });
  });

  test("defaultConfig sets approvalMode to auto for a fresh instance", () => {
    const config = defaultConfig("fresh-default");
    expect(config.approvalMode).toBe("auto");
    expect(config.dangerouslyAutoApprove).toBeUndefined();
  });

  test("loadConfig on a fresh instance writes approvalMode: auto to disk", () => {
    const instance = "fresh-disk-default";
    // No prior config file — loadConfig should write a fresh one.
    expect(existsSync(configPath(instance))).toBe(false);
    const loaded = loadConfig(instance);
    expect(loaded.approvalMode).toBe("auto");
    const persisted = JSON.parse(readFileSync(configPath(instance), "utf8")) as RuntimeConfig;
    expect(persisted.approvalMode).toBe("auto");
  });
});
