import type { CliContext } from "../context";
import { restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";

export async function mcp(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";
  if (sub === "add") {
    const [name, commandValue, ...args] = restAfter(cliArgs, sub);
    if (!name || !commandValue) throw new Error("Usage: gini mcp add <name> <command> [args...]");
    print(await api(config, "/api/mcp", {
      method: "POST",
      body: JSON.stringify({ name, command: commandValue, args, exposedTools: [] })
    }));
    return;
  }
  if (sub === "health" || sub === "disable") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error(`Usage: gini mcp ${sub} <server-id-or-name>`);
    print(await api(config, `/api/mcp/${encodeURIComponent(id)}/${sub}`, { method: "POST" }));
    return;
  }
  if (sub === "invoke") {
    const [id, toolName, ...payloadParts] = restAfter(cliArgs, sub);
    if (!id || !toolName) throw new Error("Usage: gini mcp invoke <server-id-or-name> <tool-name> [json-input]");
    const input = payloadParts.length > 0 ? JSON.parse(payloadParts.join(" ")) : {};
    print(await api(config, `/api/mcp/${encodeURIComponent(id)}/invoke`, {
      method: "POST",
      body: JSON.stringify({ toolName, input })
    }));
    return;
  }
  print(await api(config, "/api/mcp"));
}
