import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readUpload } from "../state/uploads";
import type { RuntimeConfig } from "../types";
import { invokePromoteFile } from "./promote-file";

const ROOT = "/tmp/gini-promote-file-unit";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function setup(instance: string): RuntimeConfig {
  const workspaceRoot = `${ROOT}/${instance}/workspace`;
  mkdirSync(workspaceRoot, { recursive: true });
  return {
    instance,
    port: 0,
    token: "t",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: `${ROOT}/${instance}`,
    logRoot: `${ROOT}/${instance}/logs`
  };
}

describe("invokePromoteFile", () => {
  test("happy path: promotes a workspace file, sniffs mime from extension", async () => {
    const config = setup("pf-happy");
    const fp = join(config.workspaceRoot, "chart.png");
    writeFileSync(fp, new Uint8Array([1, 2, 3, 4, 5]));
    const result = await invokePromoteFile(config, { path: "chart.png" });
    expect(result.ok).toBe(true);
    expect(result.mimeType).toBe("image/png");
    expect(result.size).toBe(5);
    const stored = readUpload(config.instance, result.uploadId!);
    expect(stored).not.toBeNull();
    expect(stored!.filename).toBe("chart.png");
  });

  test("falls back to application/octet-stream for unknown extensions", async () => {
    const config = setup("pf-unknown");
    const fp = join(config.workspaceRoot, "weird.foobar");
    writeFileSync(fp, new Uint8Array([7, 7, 7]));
    const result = await invokePromoteFile(config, { path: "weird.foobar" });
    expect(result.ok).toBe(true);
    expect(result.mimeType).toBe("application/octet-stream");
  });

  test("explicit mimeType overrides extension sniff", async () => {
    const config = setup("pf-override");
    const fp = join(config.workspaceRoot, "data.bin");
    writeFileSync(fp, new Uint8Array([0xff, 0xd8, 0xff]));
    const result = await invokePromoteFile(config, { path: "data.bin", mimeType: "image/jpeg" });
    expect(result.ok).toBe(true);
    expect(result.mimeType).toBe("image/jpeg");
  });

  test("rejects ../ workspace escape", async () => {
    const config = setup("pf-escape");
    const result = await invokePromoteFile(config, { path: "../etc-passwd" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/workspace|outside|inside/i);
  });

  test("rejects missing file", async () => {
    const config = setup("pf-missing");
    const result = await invokePromoteFile(config, { path: "does-not-exist.png" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  test("rejects empty file", async () => {
    const config = setup("pf-empty");
    const fp = join(config.workspaceRoot, "empty.png");
    writeFileSync(fp, new Uint8Array(0));
    const result = await invokePromoteFile(config, { path: "empty.png" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/empty/);
  });

  test("rejects directories", async () => {
    const config = setup("pf-dir");
    mkdirSync(join(config.workspaceRoot, "subdir"));
    const result = await invokePromoteFile(config, { path: "subdir" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a regular file/i);
  });
});
