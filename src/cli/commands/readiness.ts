import type { CliContext } from "../context";
import { api } from "../api";
import { print } from "../output";

export async function readiness(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "v1";
  if (sub !== "v1") throw new Error("Usage: gini readiness v1");
  print(await api(config, "/api/readiness/v1"));
}
