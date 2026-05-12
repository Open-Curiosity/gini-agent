// Subprocess tests for `gini update`. They exercise the command's guardrails
// without ever touching the developer's real ~/.gini/runtime: the
// GINI_STATE_ROOT short-circuit covers the happy-path branches, and HOME
// override covers the "missing runtime" and "wrong origin" error branches.
// A real fetch+reset+bun-install integration test would be slow, flaky, and
// network-dependent — these subprocess tests are what locks the guardrails in.
import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dir, "..", "..");
const CLI_PATH = join(PROJECT_ROOT, "src", "cli.ts");

interface RunOptions {
  args: string[];
  env: NodeJS.ProcessEnv;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runCli(opts: RunOptions): Promise<RunResult> {
  return new Promise((resolveRun) => {
    const child = spawn("bun", ["run", CLI_PATH, ...opts.args], {
      cwd: PROJECT_ROOT,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

function scratch(tag: string): string {
  const dir = `/tmp/gini-update-tests/${tag}-${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("gini update", () => {
  test("GINI_STATE_ROOT short-circuits", async () => {
    const stateRoot = scratch("short-circuit");
    const result = await runCli({
      args: ["update"],
      env: { ...process.env, GINI_STATE_ROOT: stateRoot }
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("skipped (GINI_STATE_ROOT set");
  }, 30_000);

  test("missing runtime errors clearly", async () => {
    const home = scratch("no-runtime");
    const env = { ...process.env, HOME: home };
    delete env.GINI_STATE_ROOT;
    const result = await runCli({ args: ["update"], env });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not present");
    expect(result.stderr).toContain("curl -fsSL");
  }, 30_000);

  test("wrong origin errors clearly", async () => {
    const home = scratch("wrong-origin");
    const runtimeDir = join(home, ".gini", "runtime");
    mkdirSync(runtimeDir, { recursive: true });
    // Initialize a real git repo with a non-matching origin so the command
    // reaches the origin-check branch instead of the missing-runtime branch.
    spawnSync("git", ["-C", runtimeDir, "init", "--quiet"]);
    spawnSync("git", ["-C", runtimeDir, "remote", "add", "origin", "https://example.com/foo"]);
    const env = { ...process.env, HOME: home };
    delete env.GINI_STATE_ROOT;
    const result = await runCli({ args: ["update"], env });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("refuses to touch");
    expect(result.stderr).toContain("https://example.com/foo");
  }, 30_000);
});
