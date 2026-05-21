import type { CliContext } from "../context";
import { hasFlag, restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";
import {
  applyMigration,
  describeSource,
  discoverOpenclawState,
  planMigration,
  summarizePlan
} from "../../integrations/openclaw-migrate";

export async function importInspect(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";
  if (sub === "inspect") {
    const [source, path] = restAfter(cliArgs, sub);
    if (source !== "openclaw" || !path) {
      throw new Error("Usage: gini import inspect openclaw <path>");
    }
    print(
      await api(config, "/api/imports/inspect", {
        method: "POST",
        body: JSON.stringify({ source, path })
      })
    );
    return;
  }
  if (sub === "plan") {
    const rest = restAfter(cliArgs, sub);
    const [source, path] = rest.filter((value) => !value.startsWith("--"));
    if (source !== "openclaw") {
      throw new Error("Usage: gini import plan openclaw [path]");
    }
    const discovery = discoverOpenclawState(path);
    const plan = planMigration(discovery);
    const summary = summarizePlan(plan);
    print({
      description: describeSource(discovery),
      ...summary
    });
    return;
  }
  if (sub === "apply") {
    const rest = restAfter(cliArgs, sub);
    const positional = rest.filter((value) => !value.startsWith("--"));
    const [source, path] = positional;
    if (source !== "openclaw") {
      throw new Error("Usage: gini import apply openclaw [path] [--force]");
    }
    const force = hasFlag(rest, "--force");
    const discovery = discoverOpenclawState(path);
    const plan = planMigration(discovery);
    const result = await applyMigration(config, discovery, plan, { force });
    print({
      source: describeSource(discovery),
      applied: result.applied,
      counts: {
        agents: result.agentsCreated,
        bridges: result.bridgesCreated,
        skills: result.skillsCopied,
        secrets: result.secretsWritten,
        workspaceFiles: result.workspaceFilesCopied
      },
      unsupported: result.unsupported,
      warnings: result.warnings,
      reportId: result.report.id
    });
    return;
  }
  print(await api(config, "/api/imports"));
}
