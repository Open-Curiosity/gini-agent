import type { CliContext } from "../context";
import { restAfter } from "../args";
import { readState } from "../../state";
import { createSnapshot, restoreSnapshot } from "../../domain/harness";
import { print } from "../output";

export function snapshot(ctx: CliContext): void {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";
  if (sub === "create") {
    const reason = restAfter(cliArgs, sub).join(" ").trim() || "Manual snapshot";
    print(createSnapshot(config, reason));
    return;
  }
  if (sub === "restore") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error("Usage: gini snapshot restore <snapshot-id>");
    print(restoreSnapshot(config, id));
    return;
  }
  print(readState(config.lane).snapshots);
}
