import type { CliContext } from "../context";
import { api } from "../api";
import { print } from "../output";

export async function parity(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "hermes";
  if (sub !== "hermes") throw new Error("Usage: gini parity hermes");
  print(await api(config, "/api/parity/hermes"));
}
