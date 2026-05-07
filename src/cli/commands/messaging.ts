import type { CliContext } from "../context";
import { restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";

export async function messaging(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";
  if (sub === "add") {
    const [name, kind = "demo", ...targets] = restAfter(cliArgs, sub);
    if (!name) throw new Error("Usage: gini messaging add <name> [kind] [delivery-targets...]");
    print(await api(config, "/api/messaging", {
      method: "POST",
      body: JSON.stringify({ name, kind, deliveryTargets: targets })
    }));
    return;
  }
  if (sub === "health" || sub === "disable") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error(`Usage: gini messaging ${sub} <bridge-id-or-name>`);
    print(await api(config, `/api/messaging/${encodeURIComponent(id)}/${sub}`, { method: "POST" }));
    return;
  }
  if (sub === "receive" || sub === "send") {
    const [id, ...textParts] = restAfter(cliArgs, sub);
    if (!id || textParts.length === 0) throw new Error(`Usage: gini messaging ${sub} <bridge-id-or-name> <text>`);
    print(await api(config, `/api/messaging/${encodeURIComponent(id)}/${sub}`, {
      method: "POST",
      body: JSON.stringify({ text: textParts.join(" "), target: "local" })
    }));
    return;
  }
  if (sub === "messages") {
    const id = restAfter(cliArgs, sub)[0];
    print(await api(config, id ? `/api/messaging/${encodeURIComponent(id)}/messages` : "/api/messaging/messages"));
    return;
  }
  print(await api(config, "/api/messaging"));
}
