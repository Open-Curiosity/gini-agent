import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createEmptyState, normalizeState } from "./store";
import type { RuntimeState } from "../types";

// Isolated state root so the test never touches ~/.gini.
const ROOT = "/tmp/gini-store-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("normalizeState toolset/tool backfill", () => {
  test("adds missing default toolsets and tools by name", () => {
    const state = createEmptyState("test-instance");
    // Simulate an older instance whose state was written before the
    // browser toolset was added: drop those entries from both arrays.
    state.toolsets = state.toolsets.filter((ts) => ts.name !== "browser");
    state.tools = state.tools.filter((tool) => tool.toolset !== "browser");
    expect(state.toolsets.some((ts) => ts.name === "browser")).toBe(false);
    expect(state.tools.some((tool) => tool.toolset === "browser")).toBe(false);

    const normalized = normalizeState("test-instance", state);

    expect(normalized.toolsets.some((ts) => ts.name === "browser")).toBe(true);
    expect(normalized.tools.some((tool) => tool.name === "browser.navigate")).toBe(true);
    expect(normalized.tools.some((tool) => tool.name === "browser.click")).toBe(true);
  });

  test("does not duplicate existing toolsets", () => {
    const state = createEmptyState("test-instance-2");
    const beforeCount = state.toolsets.length;
    const beforeToolCount = state.tools.length;
    const normalized = normalizeState("test-instance-2", state);
    expect(normalized.toolsets.length).toBe(beforeCount);
    expect(normalized.tools.length).toBe(beforeToolCount);
  });

  test("preserves user-modified toolset rows when names already match", () => {
    const state = createEmptyState("test-instance-3");
    const fileToolset = state.toolsets.find((ts) => ts.name === "file");
    expect(fileToolset).toBeDefined();
    const customDescription = "custom user description";
    fileToolset!.description = customDescription;
    const normalized = normalizeState("test-instance-3", state);
    const after = normalized.toolsets.find((ts) => ts.name === "file");
    expect(after?.description).toBe(customDescription);
  });

  test("seeds toolsets when state.toolsets is missing entirely", () => {
    const partial = { instance: "test-instance-4" } as unknown as RuntimeState;
    const normalized = normalizeState("test-instance-4", partial);
    expect(Array.isArray(normalized.toolsets)).toBe(true);
    expect(normalized.toolsets.length).toBeGreaterThan(0);
    expect(normalized.toolsets.some((ts) => ts.name === "browser")).toBe(true);
  });

  test("unions new tool names into an existing toolset row and synthesizes matching tool rows", () => {
    // Simulate an older instance whose browser toolset row was written
    // when only the original 9 browser tools existed. The toolset row
    // exists; the new tool entries (vision, hover, drag, select_option,
    // wait_for, tabs, upload_file) are missing from both toolNames and
    // the tool rows. Mark the existing toolset as "enabled" so we can
    // verify the new tool rows come up "available" matching the
    // toolset's status.
    const state = createEmptyState("test-instance-5");
    const browser = state.toolsets.find((ts) => ts.name === "browser");
    expect(browser).toBeDefined();
    browser!.toolNames = [
      "browser.navigate",
      "browser.snapshot",
      "browser.click",
      "browser.type",
      "browser.press",
      "browser.scroll",
      "browser.back",
      "browser.console",
      "browser.close"
    ];
    browser!.status = "enabled";
    // Drop the newer tool rows so the backfill has something to do.
    const newerNames = new Set([
      "browser.vision",
      "browser.hover",
      "browser.drag",
      "browser.select_option",
      "browser.wait_for",
      "browser.tabs",
      "browser.upload_file"
    ]);
    state.tools = state.tools.filter(
      (tool) => tool.toolset !== "browser" || !newerNames.has(tool.name)
    );

    const normalized = normalizeState("test-instance-5", state);
    const after = normalized.toolsets.find((ts) => ts.name === "browser")!;
    // toolNames is now the full default set, in stable order (old names
    // first, new names appended).
    expect(after.toolNames.length).toBe(16);
    for (const name of newerNames) {
      expect(after.toolNames.includes(name)).toBe(true);
    }
    // Tool rows for each new name exist and inherit the toolset's
    // enabled→available status.
    for (const name of newerNames) {
      const row = normalized.tools.find((tool) => tool.name === name);
      expect(row).toBeDefined();
      expect(row!.toolset).toBe("browser");
      expect(row!.status).toBe("available");
    }
  });

  test("normalizes legacy intervalSeconds: 0 sentinel on cron-driven jobs to undefined", () => {
    // Earlier versions of the runtime stored `intervalSeconds: 0` on cron
    // jobs so the field stayed a `number`. After the type was made
    // optional, cron jobs carry no intervalSeconds at all. The normalizer
    // migrates legacy rows on load — interval jobs are left untouched.
    const state = createEmptyState("test-instance-cron-migrate");
    state.jobs = [
      // Legacy cron job: intervalSeconds: 0, cronExpression set.
      {
        id: "job_legacy_cron",
        instance: "test-instance-cron-migrate",
        name: "legacy cron",
        prompt: "x",
        intervalSeconds: 0,
        cronExpression: "0 9 * * *",
        cronTimezone: "UTC",
        status: "active",
        deliveryTargets: [],
        context: [],
        retryLimit: 0,
        timeoutSeconds: 600,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        nextRunAt: "2026-01-02T09:00:00.000Z",
        runCount: 0,
        missedRuns: 0,
        taskIds: [],
        runIds: []
      },
      // Legacy interval job: positive intervalSeconds, no cronExpression.
      {
        id: "job_legacy_interval",
        instance: "test-instance-cron-migrate",
        name: "legacy interval",
        prompt: "x",
        intervalSeconds: 60,
        status: "active",
        deliveryTargets: [],
        context: [],
        retryLimit: 0,
        timeoutSeconds: 600,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        nextRunAt: "2026-01-01T00:01:00.000Z",
        runCount: 0,
        missedRuns: 0,
        taskIds: [],
        runIds: []
      }
    ];

    const normalized = normalizeState("test-instance-cron-migrate", state);

    const cronJob = normalized.jobs.find((j) => j.id === "job_legacy_cron");
    const intervalJob = normalized.jobs.find((j) => j.id === "job_legacy_interval");
    // Cron-driven row: the 0 sentinel is dropped.
    expect(cronJob?.intervalSeconds).toBeUndefined();
    expect(cronJob?.cronExpression).toBe("0 9 * * *");
    // Interval-driven row: untouched.
    expect(intervalJob?.intervalSeconds).toBe(60);
  });

  test("backfilled tool rows for a DISABLED toolset stay disabled", () => {
    const state = createEmptyState("test-instance-6");
    const browser = state.toolsets.find((ts) => ts.name === "browser");
    expect(browser).toBeDefined();
    // Reduce to the old 9-tool roster and leave the toolset disabled
    // (the on-disk default for the browser toolset).
    browser!.toolNames = [
      "browser.navigate",
      "browser.snapshot",
      "browser.click",
      "browser.type",
      "browser.press",
      "browser.scroll",
      "browser.back",
      "browser.console",
      "browser.close"
    ];
    expect(browser!.status).toBe("disabled");
    const newerNames = ["browser.vision", "browser.hover"];
    state.tools = state.tools.filter(
      (tool) => tool.toolset !== "browser" || !newerNames.includes(tool.name)
    );

    const normalized = normalizeState("test-instance-6", state);
    for (const name of newerNames) {
      const row = normalized.tools.find((tool) => tool.name === name);
      expect(row).toBeDefined();
      expect(row!.status).toBe("disabled");
    }
  });
});
