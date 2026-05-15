import { writeFileSync } from "node:fs";
import type { CliContext } from "../context";
import { flagValue, restAfter } from "../args";
import { configPath } from "../../paths";
import { normalizeProvider, providerHealth } from "../../provider";
import { api } from "../api";
import { print } from "../output";
import { maybeRefreshAutostart } from "./autostart";

const USAGE = "Usage: gini provider set echo|openai|codex|openrouter|local [model] [--base-url <url>] [--api-key-env <NAME>] [--extra-body <JSON>]";

export async function provider(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "show";
  if (sub === "set") {
    const tail = restAfter(cliArgs, sub);
    // Positional args: <name> [model]. Skip flag tokens so users can write
    // `gini provider set local --base-url X gemma-...` if they prefer that
    // ordering. We collect the first two non-flag tokens as name/model.
    const positional: string[] = [];
    for (let i = 0; i < tail.length; i += 1) {
      const token = tail[i] ?? "";
      if (token.startsWith("--")) {
        // Skip the value that follows recognized value-bearing flags.
        if (token === "--base-url" || token === "--api-key-env" || token === "--extra-body") i += 1;
        continue;
      }
      positional.push(token);
    }
    const name = positional[0];
    const model = positional[1];
    if (name !== "echo" && name !== "openai" && name !== "codex" && name !== "openrouter" && name !== "local") {
      throw new Error(USAGE);
    }

    const baseUrl = flagValue(tail, "--base-url");
    const apiKeyEnv = flagValue(tail, "--api-key-env");
    const extraBodyRaw = flagValue(tail, "--extra-body");
    let extraBody: Record<string, unknown> | undefined;
    if (extraBodyRaw !== undefined) {
      try {
        const parsed = JSON.parse(extraBodyRaw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("--extra-body must be a JSON object");
        }
        extraBody = parsed as Record<string, unknown>;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`--extra-body is not valid JSON: ${message}`);
      }
    }

    config.provider = normalizeProvider({
      name,
      model: model ?? (name === "echo" ? "gini-echo-v0" : name === "codex" ? "gpt-5.5" : name === "openrouter" ? "openrouter/auto" : name === "local" ? "local/default" : "gpt-5.4-mini"),
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiKeyEnv ? { apiKeyEnv } : {}),
      ...(extraBody ? { extraBody } : {})
    });
    writeFileSync(configPath(config.instance), `${JSON.stringify(config, null, 2)}\n`);
    // If an autostart plist already exists for this instance, refresh it
    // so the new provider (and any secrets.env values that came along
    // with it) are picked up on the next launchd respawn. No-op on
    // non-macOS or when autostart is not enabled.
    const autostart = await maybeRefreshAutostart(config.instance);
    print({ updated: true, provider: providerHealth(config), configPath: configPath(config.instance), autostart });
    return;
  }
  if (sub === "catalog") {
    print(await api(config, "/api/providers/catalog"));
    return;
  }
  print(providerHealth(config));
}
