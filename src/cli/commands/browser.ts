// CLI surface for the browser-connect capability:
//   gini browser status
//   gini browser connect [--port N] [--url WSURL]
//   gini browser disconnect
//
// Thin client over /api/browser*. All three subcommands print the JSON
// response so users can pipe it into jq / scripts; the underlying
// capability already shapes the response with a `connected` boolean for
// quick checks.
import type { CliContext } from "../context";
import { flagValue, restAfter } from "../args";
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

  throw new Error(
    "Usage: gini browser status | connect [--port N] [--url WSURL] | disconnect"
  );
}
