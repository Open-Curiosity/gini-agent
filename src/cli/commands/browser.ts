// CLI surface for the browser-connect capability:
//   gini browser status
//   gini browser connect [--port N] [--url WSURL]
//   gini browser disconnect
//   gini browser wipe-profile [--yes]
//
// Thin client over /api/browser*. All subcommands print the JSON response
// so users can pipe it into jq / scripts; the underlying capability
// already shapes the response with a `connected` boolean for quick checks.
//
// Note on persistence: connect/disconnect now toggle visibility only —
// the agent always drives the same per-instance profile so sign-ins
// persist across cycles. `wipe-profile` is the only path that destroys
// saved logins / cookies.
import * as readline from "node:readline/promises";
import type { CliContext } from "../context";
import { flagValue, hasFlag, restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";

export async function browser(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "status";

  if (sub === "status") {
    print(await api(config, "/api/browser"));
    return;
  }

  if (sub === "connect") {
    const rest = restAfter(cliArgs, "connect");
    const url = flagValue(rest, "--url");
    const portValue = flagValue(rest, "--port");
    const body: Record<string, unknown> = {};
    if (url) body.cdpUrl = url;
    if (portValue !== undefined) {
      const port = Number(portValue);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid --port: ${portValue}`);
      }
      body.port = port;
    }
    print(
      await api(config, "/api/browser/connect", {
        method: "POST",
        body: JSON.stringify(body)
      })
    );
    return;
  }

  if (sub === "disconnect") {
    print(
      await api(config, "/api/browser/disconnect", {
        method: "POST"
      })
    );
    return;
  }

  if (sub === "wipe-profile") {
    const rest = restAfter(cliArgs, "wipe-profile");
    const skipPrompt = hasFlag(rest, "--yes");
    if (!skipPrompt) {
      if (!process.stdin.isTTY) {
        // Mirror the uninstall command's behavior — refuse to run an
        // irreversible action without a TTY when --yes wasn't passed.
        throw new Error(
          "Refusing to wipe profile interactively without a TTY. Pass --yes to proceed."
        );
      }
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const proceed = await rl.question(
          "This permanently deletes the per-instance Chrome profile (cookies, saved logins). Continue? [y/N] "
        );
        const trimmed = proceed.trim().toLowerCase();
        if (trimmed !== "y" && trimmed !== "yes") {
          console.log("Aborted.");
          return;
        }
      } finally {
        rl.close();
      }
    }
    print(
      await api(config, "/api/browser/wipe-profile", {
        method: "POST"
      })
    );
    return;
  }

  throw new Error(
    "Usage: gini browser status | connect [--port N] [--url WSURL] | disconnect | wipe-profile [--yes]"
  );
}
