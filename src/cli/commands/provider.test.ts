// Unit tests for the `gini provider set` command — focused on argument
// parsing, especially the new --base-url / --api-key-env / --extra-body
// flags introduced for OpenAI-compatible local servers like oMLX.
//
// We swap the shared print() function out via mocking so command output
// can be captured and the test never writes to a real config.json — the
// CliContext we hand provider() points at a tmp instance dir.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CliContext } from "../context";
import type { RuntimeConfig } from "../../types";
import { provider } from "./provider";

describe("provider CLI", () => {
  let scratchHome: string;
  let originalHome: string | undefined;
  let originalState: string | undefined;
  let printed: unknown[];

  beforeEach(() => {
    scratchHome = `/tmp/gini-provider-cli-tests/${process.pid}-${Math.random().toString(36).slice(2)}`;
    mkdirSync(scratchHome, { recursive: true });
    originalHome = process.env.HOME;
    originalState = process.env.GINI_STATE_ROOT;
    process.env.HOME = scratchHome;
    process.env.GINI_STATE_ROOT = join(scratchHome, ".gini");
    printed = [];
    // Pre-create the instance dir so writeFileSync(configPath(...)) succeeds.
    mkdirSync(join(process.env.GINI_STATE_ROOT, "instances", "test-instance"), { recursive: true });
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = originalState;
    rmSync(scratchHome, { recursive: true, force: true });
  });

  test("set local accepts --base-url, --api-key-env, --extra-body and persists them", async () => {
    const ctx = makeCtx([
      "provider", "set", "local", "gemma-4-26b-a4b-it-uncensored-8bit",
      "--base-url", "http://127.0.0.1:8000/v1",
      "--api-key-env", "GINI_LOCAL_API_KEY",
      "--extra-body", JSON.stringify({ chat_template_kwargs: { preserve_thinking: false, enable_thinking: true } })
    ]);
    await provider(ctx);
    const cfgPath = join(process.env.GINI_STATE_ROOT!, "instances", "test-instance", "config.json");
    const persisted = JSON.parse(readFileSync(cfgPath, "utf8")) as RuntimeConfig;
    expect(persisted.provider.name).toBe("local");
    expect(persisted.provider.model).toBe("gemma-4-26b-a4b-it-uncensored-8bit");
    expect(persisted.provider.baseUrl).toBe("http://127.0.0.1:8000/v1");
    expect(persisted.provider.apiKeyEnv).toBe("GINI_LOCAL_API_KEY");
    expect(persisted.provider.extraBody).toEqual({
      chat_template_kwargs: { preserve_thinking: false, enable_thinking: true }
    });
  });

  test("set local with no flags falls back to normalizeProvider defaults", async () => {
    const ctx = makeCtx(["provider", "set", "local"]);
    await provider(ctx);
    const cfgPath = join(process.env.GINI_STATE_ROOT!, "instances", "test-instance", "config.json");
    const persisted = JSON.parse(readFileSync(cfgPath, "utf8")) as RuntimeConfig;
    expect(persisted.provider.name).toBe("local");
    expect(persisted.provider.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(persisted.provider.apiKeyEnv).toBe("GINI_LOCAL_API_KEY");
    expect(persisted.provider.extraBody).toBeUndefined();
  });

  test("flags can appear before or after the positional model name", async () => {
    const ctx = makeCtx([
      "provider", "set", "local",
      "--base-url", "http://127.0.0.1:8000/v1",
      "qwen3-test",
      "--api-key-env", "MY_KEY"
    ]);
    await provider(ctx);
    const cfgPath = join(process.env.GINI_STATE_ROOT!, "instances", "test-instance", "config.json");
    const persisted = JSON.parse(readFileSync(cfgPath, "utf8")) as RuntimeConfig;
    expect(persisted.provider.model).toBe("qwen3-test");
    expect(persisted.provider.baseUrl).toBe("http://127.0.0.1:8000/v1");
    expect(persisted.provider.apiKeyEnv).toBe("MY_KEY");
  });

  test("--extra-body rejects non-object JSON", async () => {
    const ctx = makeCtx([
      "provider", "set", "local", "m",
      "--extra-body", JSON.stringify(["not", "an", "object"])
    ]);
    await expect(provider(ctx)).rejects.toThrow(/--extra-body must be a JSON object/);
  });

  test("--extra-body rejects malformed JSON", async () => {
    const ctx = makeCtx([
      "provider", "set", "local", "m",
      "--extra-body", "{this is not valid json"
    ]);
    await expect(provider(ctx)).rejects.toThrow(/--extra-body is not valid JSON/);
  });

  test("set rejects unknown provider names", async () => {
    const ctx = makeCtx(["provider", "set", "anthropic"]);
    await expect(provider(ctx)).rejects.toThrow(/Usage: gini provider set/);
  });
});

function makeCtx(cliArgs: string[]): CliContext {
  const stateRoot = join(process.env.GINI_STATE_ROOT!, "instances", "test-instance");
  const config: RuntimeConfig = {
    instance: "test-instance",
    port: 7337,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: join(stateRoot, "workspace"),
    stateRoot,
    logRoot: join(stateRoot, "logs")
  };
  return {
    config,
    cliArgs,
    command: cliArgs[0] ?? "",
    ephemeralSmoke: false,
    explicitInstance: true,
    rawArgs: cliArgs,
    web: { webPort: 0, webPortPinned: false, noWeb: true }
  };
}
