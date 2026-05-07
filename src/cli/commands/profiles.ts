import type { CliContext } from "../context";
import { restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";

export async function profile(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";
  if (sub === "create") {
    const [name, ...toolsets] = restAfter(cliArgs, sub);
    if (!name) throw new Error("Usage: gini profile create <name> [toolsets...]");
    print(await api(config, "/api/profiles", {
      method: "POST",
      body: JSON.stringify({ name, toolsets: toolsets.length > 0 ? toolsets : undefined })
    }));
    return;
  }
  if (sub === "use") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error("Usage: gini profile use <profile-id-or-name>");
    print(await api(config, `/api/profiles/${encodeURIComponent(id)}/use`, { method: "POST" }));
    return;
  }
  print(await api(config, "/api/profiles"));
}
