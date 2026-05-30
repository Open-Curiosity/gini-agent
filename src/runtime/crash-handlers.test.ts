// Tests for installCrashHandlers. We inject spawn/exit/write/supervisor so
// nothing real is spawned, no process exits, and no disk write touches ~/.gini.
// Handlers are emitted synchronously via process.emit and removed after each
// test so listeners don't leak into the rest of the suite.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  installCrashHandlers,
  __resetCrashHandlersForTest
} from "./crash-handlers";
import type { CrashReport } from "./crash-report";

interface SpawnCall {
  cmd: string;
  args: string[];
}

function captureListeners() {
  return {
    uncaught: [...process.listeners("uncaughtException")],
    rejection: [...process.listeners("unhandledRejection")]
  };
}

describe("installCrashHandlers", () => {
  let before: ReturnType<typeof captureListeners>;
  let stateRoot: string;
  let prevStateRoot: string | undefined;

  beforeEach(() => {
    __resetCrashHandlersForTest();
    before = captureListeners();
    stateRoot = `/tmp/gini-crash-handlers-tests-${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
    prevStateRoot = process.env.GINI_STATE_ROOT;
    process.env.GINI_STATE_ROOT = stateRoot;
  });

  afterEach(() => {
    // Remove only the listeners this test installed.
    const after = captureListeners();
    for (const l of after.uncaught) {
      if (!before.uncaught.includes(l)) process.off("uncaughtException", l);
    }
    for (const l of after.rejection) {
      if (!before.rejection.includes(l)) process.off("unhandledRejection", l);
    }
    __resetCrashHandlersForTest();
    if (prevStateRoot === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevStateRoot;
    rmSync(stateRoot, { recursive: true, force: true });
  });

  function install(overrides: {
    exitCodes: number[];
    spawnCalls: SpawnCall[];
    supervisorValue?: "launchd" | null;
    writeThrows?: boolean;
    writeImpl?: (r: CrashReport) => string;
  }) {
    const supervisorValue =
      "supervisorValue" in overrides ? overrides.supervisorValue! : "launchd";
    installCrashHandlers({
      instance: "test-inst",
      source: "runtime",
      supervisorImpl: () => supervisorValue,
      exitImpl: (code) => { overrides.exitCodes.push(code); },
      spawnImpl: ((cmd: string, args: string[]) => {
        overrides.spawnCalls.push({ cmd, args });
        return { unref() {} } as unknown as ReturnType<typeof import("node:child_process").spawn>;
      }) as unknown as typeof import("node:child_process").spawn,
      writeImpl: overrides.writeThrows
        ? () => { throw new Error("disk full"); }
        : (overrides.writeImpl ?? (() => "/tmp/fake-report.json")),
      clock: () => new Date("2026-05-29T00:00:00.000Z")
    });
  }

  test("uncaughtException -> writes report, spawns report-crash, exits 1", () => {
    const exitCodes: number[] = [];
    const spawnCalls: SpawnCall[] = [];
    install({ exitCodes, spawnCalls });
    process.emit("uncaughtException", new Error("boom"));
    expect(exitCodes).toEqual([1]);
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0]!.args).toContain("report-crash");
    expect(spawnCalls[0]!.args).toContain("--report");
    expect(spawnCalls[0]!.args).toContain("/tmp/fake-report.json");
  });

  test("unhandledRejection -> spawns report-crash, exits 1", () => {
    const exitCodes: number[] = [];
    const spawnCalls: SpawnCall[] = [];
    install({ exitCodes, spawnCalls });
    process.emit("unhandledRejection", new Error("rejected"), Promise.resolve());
    expect(exitCodes).toEqual([1]);
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0]!.args).toContain("report-crash");
  });

  test("write throwing still exits 1 (finally)", () => {
    const exitCodes: number[] = [];
    const spawnCalls: SpawnCall[] = [];
    install({ exitCodes, spawnCalls, writeThrows: true });
    process.emit("uncaughtException", new Error("boom"));
    expect(exitCodes).toEqual([1]);
    // Spawn never reached because the write threw before it.
    expect(spawnCalls.length).toBe(0);
  });

  test("not under launchd -> no spawn but still exits 1", () => {
    const exitCodes: number[] = [];
    const spawnCalls: SpawnCall[] = [];
    install({ exitCodes, spawnCalls, supervisorValue: null });
    process.emit("uncaughtException", new Error("boom"));
    expect(exitCodes).toEqual([1]);
    expect(spawnCalls.length).toBe(0);
  });

  test("the built report carries the source and instance", () => {
    const exitCodes: number[] = [];
    const spawnCalls: SpawnCall[] = [];
    let captured: CrashReport | null = null;
    install({
      exitCodes,
      spawnCalls,
      writeImpl: (r) => { captured = r; return "/tmp/fake-report.json"; }
    });
    process.emit("uncaughtException", new Error("boom"));
    expect(captured).not.toBeNull();
    expect(captured!.source).toBe("runtime");
    expect(captured!.instance).toBe("test-inst");
    expect(captured!.supervisor).toBe("launchd");
  });

  test("double-registration is guarded (second install is a no-op)", () => {
    const exitCodes: number[] = [];
    const spawnCalls: SpawnCall[] = [];
    install({ exitCodes, spawnCalls });
    // Second install without reset must not add a second listener pair.
    install({ exitCodes, spawnCalls });
    process.emit("uncaughtException", new Error("boom"));
    // Exactly one handler fired -> one exit, one spawn.
    expect(exitCodes).toEqual([1]);
    expect(spawnCalls.length).toBe(1);
  });
});
