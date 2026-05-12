// Subprocess tests for `gini setup`. The interactive read-secret path
// requires a real TTY, so these tests exercise only the non-TTY refusal
// and the --non-interactive (--yes) short-circuit. Real prompts are
// validated by manual smoke through the curl|bash installer.
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dir, "..", "..");
const CLI_PATH = join(PROJECT_ROOT, "src", "cli.ts");

interface RunOptions {
  args: string[];
  env: NodeJS.ProcessEnv;
  stdin?: "ignore" | "pipe";
  stdinData?: string;
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
      stdio: [opts.stdin ?? "ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    if (opts.stdin === "pipe" && opts.stdinData !== undefined) {
      child.stdin?.write(opts.stdinData);
      child.stdin?.end();
    }
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

function scratch(tag: string): string {
  const dir = `/tmp/gini-setup-tests/${tag}-${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("gini setup", () => {
  test("--non-interactive without provider configured exits 1", async () => {
    // Seed an openai-named provider in config but provide no OPENAI_API_KEY
    // anywhere. providerStep.isComplete returns false, the non-interactive
    // IO refuses the secret prompt, command exits non-zero. This is the
    // failure path scripted installers would hit if they forgot to export
    // the key before invoking `gini setup --yes`.
    const stateRoot = scratch("no-key");
    const home = scratch("no-key-home");
    const instance = "dev";
    const instanceDir = join(stateRoot, "instances", instance);
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(join(instanceDir, "config.json"), `${JSON.stringify({
      instance,
      port: 7337,
      token: "test-token",
      provider: { name: "openai", model: "gpt-5.4-mini", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" },
      workspaceRoot: join(instanceDir, "workspace"),
      stateRoot: instanceDir,
      logRoot: join(instanceDir, "logs")
    }, null, 2)}\n`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GINI_STATE_ROOT: stateRoot,
      GINI_INSTANCE: instance,
      HOME: home
    };
    delete env.OPENAI_API_KEY;
    const result = await runCli({
      args: ["setup", "--non-interactive", "--state-root", stateRoot, "--instance", instance],
      env
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain("not allowed");
  }, 30_000);

  test("--non-interactive with OPENAI_API_KEY in env and provider preconfigured exits 0", async () => {
    const stateRoot = scratch("preconfigured");
    const home = scratch("preconfigured-home");
    const instance = "dev";
    // Seed a config.json with the openai provider so isComplete short-
    // circuits to true. The instance dir + every adjacent dir loadConfig
    // creates must already exist, otherwise loadConfig's defaultConfig
    // would clobber our seed. Simplest path: write the seed, let
    // loadConfig merge on top.
    const instanceDir = join(stateRoot, "instances", instance);
    mkdirSync(instanceDir, { recursive: true });
    const seedConfig = {
      instance,
      port: 7337,
      token: "test-token",
      provider: {
        name: "openai",
        model: "gpt-5.4-mini",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY"
      },
      workspaceRoot: join(instanceDir, "workspace"),
      stateRoot: instanceDir,
      logRoot: join(instanceDir, "logs")
    };
    writeFileSync(join(instanceDir, "config.json"), `${JSON.stringify(seedConfig, null, 2)}\n`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GINI_STATE_ROOT: stateRoot,
      GINI_INSTANCE: instance,
      HOME: home,
      OPENAI_API_KEY: "sk-test"
    };
    const result = await runCli({
      args: ["setup", "--non-interactive", "--state-root", stateRoot, "--instance", instance],
      env
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("already configured");
    expect(result.stdout).toContain("Done.");
  }, 30_000);

  test("non-TTY without --yes refuses", async () => {
    const stateRoot = scratch("no-tty");
    const home = scratch("no-tty-home");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GINI_STATE_ROOT: stateRoot,
      HOME: home
    };
    delete env.OPENAI_API_KEY;
    const result = await runCli({
      args: ["setup", "--state-root", stateRoot],
      env,
      stdin: "pipe",
      stdinData: ""
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Refusing to run interactively without a TTY");
    // We deliberately don't assert "no instance dir created" here — the
    // command currently triggers loadConfig before the TTY check so the
    // scaffold gets created. That mirrors the same trade-off update.ts
    // accepts; if we wanted to defer config loading we'd lift the TTY
    // check up to the dispatcher.
    void existsSync(stateRoot);
  }, 30_000);
});
