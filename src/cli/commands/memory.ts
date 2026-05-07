import type { CliContext } from "../context";
import { restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";

export async function memory(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";
  if (sub === "add") {
    const content = restAfter(cliArgs, sub).join(" ").trim();
    if (!content) throw new Error("Usage: gini memory add <content>");
    print(await api(config, "/api/memory", { method: "POST", body: JSON.stringify({ content, status: "active" }) }));
    return;
  }
  if (sub === "approve" || sub === "reject") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error(`Usage: gini memory ${sub} <memory-id>`);
    print(await api(config, `/api/memory/${id}/${sub}`, { method: "POST" }));
    return;
  }
  if (sub === "edit") {
    const [id, ...contentParts] = restAfter(cliArgs, sub);
    if (!id || contentParts.length === 0) throw new Error("Usage: gini memory edit <memory-id> <content>");
    print(await api(config, `/api/memory/${id}`, { method: "PATCH", body: JSON.stringify({ content: contentParts.join(" ") }) }));
    return;
  }
  if (sub === "archive" || sub === "delete") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error(`Usage: gini memory ${sub} <memory-id>`);
    print(await api(config, `/api/memory/${id}`, { method: "DELETE" }));
    return;
  }
  print(await api(config, "/api/memory"));
}
