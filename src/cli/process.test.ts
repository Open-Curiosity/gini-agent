// Unit tests for the stdio-capture plumbing in src/cli/process.ts.
//
// These tests drive `setupChildLog` directly (not via a full `gini run`
// subprocess) so we can exercise the FD-as-stdio daemon path and the tee+flush
// foreground path with a trivial, fast child. The previous coverage gap (only
// foreground runtime stdout was tested) hid two regressions: daemon mode had
// zero coverage, and tail bytes were lost on signal-driven exits.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { awaitForegroundLogFlush, setupChildLog } from "./process";

function uniqueInstance(tag: string): string {
  return `process-test-${tag}-${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
}

function makeLogRoot(): string {
  const root = `/tmp/gini-process-tests/${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
  rmSync(root, { recursive: true, force: true });
  return root;
}

describe("setupChildLog", () => {
  let originalLogRoot: string | undefined;
  let logRoot: string;

  beforeEach(() => {
    originalLogRoot = process.env.GINI_LOG_ROOT;
    logRoot = makeLogRoot();
    process.env.GINI_LOG_ROOT = logRoot;
  });

  afterEach(() => {
    if (originalLogRoot === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = originalLogRoot;
    rmSync(logRoot, { recursive: true, force: true });
  });

  test("daemon mode captures both stdout and stderr via FD stdio", async () => {
    const instance = uniqueInstance("daemon");
    const plumbing = setupChildLog(instance, "child.log", false);
    // Daemon plumbing must hand numeric FDs to spawn() so writes survive the
    // parent unrefing the child. "ignore" + numeric fd + numeric fd is the
    // canonical shape.
    expect(plumbing.stdio[0]).toBe("ignore");
    expect(typeof plumbing.stdio[1]).toBe("number");
    expect(typeof plumbing.stdio[2]).toBe("number");

    const child = spawn("bun", ["-e", "console.log('hi'); console.error('bye')"], {
      stdio: plumbing.stdio
    });
    plumbing.onSpawned(child);
    await new Promise<void>((resolve) => { child.once("close", () => resolve()); });

    const logPath = join(logRoot, instance, "child.log");
    expect(existsSync(logPath)).toBe(true);
    const contents = readFileSync(logPath, "utf8");
    expect(contents).toContain("hi");
    expect(contents).toContain("bye");
  });

  test("foreground mode tees stdout and stderr to the log file and flushes the tail", async () => {
    const instance = uniqueInstance("fg");
    const plumbing = setupChildLog(instance, "child.log", true);
    expect(plumbing.stdio).toEqual(["inherit", "pipe", "pipe"]);

    const child = spawn("bun", ["-e", "console.log('hi'); console.error('bye')"], {
      stdio: plumbing.stdio
    });
    plumbing.onSpawned(child);
    await new Promise<void>((resolve) => { child.once("close", () => resolve()); });

    // Mirrors the production exit path: callers await flush before process.exit
    // so the tail of stderr bursts isn't dropped.
    await awaitForegroundLogFlush();

    const logPath = join(logRoot, instance, "child.log");
    expect(existsSync(logPath)).toBe(true);
    const contents = readFileSync(logPath, "utf8");
    expect(contents).toContain("hi");
    expect(contents).toContain("bye");
  });

  test("foreground mode uses web.log filename when requested", async () => {
    // Sanity: the helper writes to whatever filename the caller supplies, so
    // both web.log (Next.js) and runtime-stdout.log (runtime) are covered by
    // the same plumbing — verifying once is enough.
    const instance = uniqueInstance("web");
    const plumbing = setupChildLog(instance, "web.log", true);
    const child = spawn("bun", ["-e", "console.log('next-dev-banner')"], {
      stdio: plumbing.stdio
    });
    plumbing.onSpawned(child);
    await new Promise<void>((resolve) => { child.once("close", () => resolve()); });
    await awaitForegroundLogFlush();

    const logPath = join(logRoot, instance, "web.log");
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, "utf8")).toContain("next-dev-banner");
  });

  test("awaitForegroundLogFlush waits for tail bytes printed shortly before child exit", async () => {
    // Validates the fix for the race where `process.exit` ran before the tee
    // stream's `'finish'` event. We print on stderr immediately before exiting
    // and assert the bytes made it to disk after awaiting flush.
    const instance = uniqueInstance("tail");
    const plumbing = setupChildLog(instance, "child.log", true);
    const child = spawn("bun", [
      "-e",
      "process.stderr.write('TAIL_MARKER_LINE\\n'); process.exit(7)"
    ], { stdio: plumbing.stdio });
    plumbing.onSpawned(child);
    await new Promise<void>((resolve) => { child.once("close", () => resolve()); });
    await awaitForegroundLogFlush();

    const logPath = join(logRoot, instance, "child.log");
    const contents = readFileSync(logPath, "utf8");
    expect(contents).toContain("TAIL_MARKER_LINE");
  });
});
