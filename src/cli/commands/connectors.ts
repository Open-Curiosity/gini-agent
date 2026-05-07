import type { CliContext } from "../context";
import { restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";

export async function connector(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";
  if (sub === "health") {
    const id = restAfter(cliArgs, sub)[0] ?? "conn_demo";
    print(await api(config, `/api/connectors/${id}/health`, { method: "POST" }));
    return;
  }
  print(await api(config, "/api/connectors"));
}
