import type { CliContext } from "../context";
import { restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";

export async function skill(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";
  if (sub === "add") {
    const name = restAfter(cliArgs, sub)[0];
    const description = restAfter(cliArgs, sub).slice(1).join(" ");
    if (!name) throw new Error("Usage: gini skill add <name> [description]");
    print(await api(config, "/api/skills", {
      method: "POST",
      body: JSON.stringify({ name, description, trigger: name, steps: [description || `Use ${name}`], status: "draft" })
    }));
    return;
  }
  if (sub === "validate") {
    print(await api(config, "/api/skills/validate"));
    return;
  }
  if (sub === "show" || sub === "test" || sub === "trust" || sub === "disable" || sub === "rollback") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error(`Usage: gini skill ${sub} <skill-id-or-name>`);
    print(await api(config, `/api/skills/${encodeURIComponent(id)}${sub === "show" ? "" : `/${sub}`}`, { method: sub === "show" ? "GET" : "POST" }));
    return;
  }
  if (sub === "search") {
    const query = restAfter(cliArgs, sub).join(" ").trim();
    print(await api(config, `/api/skills?q=${encodeURIComponent(query)}`));
    return;
  }
  print(await api(config, "/api/skills"));
}
