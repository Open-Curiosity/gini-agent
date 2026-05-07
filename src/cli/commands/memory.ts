import type { CliContext } from "../context";
import { restAfter, flagValue } from "../args";
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

  // Hindsight surfaces. The legacy `gini memory list` (the `default` branch
  // below) keeps showing legacy MemoryRecord rows; new subcommands are
  // additive.
  if (sub === "retain") {
    const text = restAfter(cliArgs, sub).filter((arg) => !arg.startsWith("--")).join(" ").trim();
    if (!text) throw new Error("Usage: gini memory retain <text> [--bank ID] [--task ID]");
    const bank = flagValue(cliArgs, "--bank");
    const task = flagValue(cliArgs, "--task");
    const body = JSON.stringify({ text, bankId: bank, sourceTaskId: task });
    print(await api(config, "/api/memory/retain", { method: "POST", body }));
    return;
  }
  if (sub === "units") {
    const action = restAfter(cliArgs, sub)[0] ?? "list";
    if (action === "list") {
      const network = flagValue(cliArgs, "--network");
      const bank = flagValue(cliArgs, "--bank") ?? "bank_default";
      const params = new URLSearchParams({ bank });
      if (network) params.set("network", network);
      print(await api(config, `/api/memory/units?${params.toString()}`));
      return;
    }
    throw new Error(`Unknown units subcommand: ${action}`);
  }
  if (sub === "bank" || sub === "banks") {
    const action = restAfter(cliArgs, sub)[0] ?? "list";
    if (action === "list") {
      print(await api(config, "/api/memory/banks"));
      return;
    }
    if (action === "show") {
      const id = restAfter(cliArgs, sub)[1] ?? "bank_default";
      print(await api(config, `/api/memory/banks/${id}`));
      return;
    }
    if (action === "set") {
      const id = restAfter(cliArgs, sub)[1];
      if (!id) throw new Error("Usage: gini memory bank set <id> [--skepticism N] [--literalism N] [--empathy N] [--bias N]");
      const patch: Record<string, unknown> = {};
      const skep = flagValue(cliArgs, "--skepticism");
      const lit = flagValue(cliArgs, "--literalism");
      const emp = flagValue(cliArgs, "--empathy");
      const bias = flagValue(cliArgs, "--bias") ?? flagValue(cliArgs, "--bias-strength");
      const name = flagValue(cliArgs, "--name");
      const background = flagValue(cliArgs, "--background");
      if (skep) patch.skepticism = Number(skep);
      if (lit) patch.literalism = Number(lit);
      if (emp) patch.empathy = Number(emp);
      if (bias) patch.biasStrength = Number(bias);
      if (name) patch.name = name;
      if (background) patch.background = background;
      print(await api(config, `/api/memory/banks/${id}`, { method: "PATCH", body: JSON.stringify(patch) }));
      return;
    }
    throw new Error(`Unknown bank subcommand: ${action}`);
  }
  if (sub === "recall") {
    const query = restAfter(cliArgs, sub).filter((arg) => !arg.startsWith("--")).join(" ").trim();
    if (!query) throw new Error("Usage: gini memory recall <query> [--bank ID] [--budget N] [--network world]");
    const budget = flagValue(cliArgs, "--budget");
    const network = flagValue(cliArgs, "--network");
    const bank = flagValue(cliArgs, "--bank");
    const body = JSON.stringify({
      query,
      bankId: bank,
      tokenBudget: budget ? Number(budget) : undefined,
      network: network ? network.split(",") : undefined
    });
    print(await api(config, "/api/memory/recall", { method: "POST", body }));
    return;
  }
  if (sub === "reflect") {
    const query = restAfter(cliArgs, sub).filter((arg) => !arg.startsWith("--")).join(" ").trim();
    if (!query) throw new Error("Usage: gini memory reflect <query> [--bank ID]");
    const bank = flagValue(cliArgs, "--bank");
    const body = JSON.stringify({ query, bankId: bank });
    print(await api(config, "/api/memory/reflect", { method: "POST", body }));
    return;
  }
  if (sub === "migrate") {
    print(await api(config, "/api/memory/migrate", { method: "POST" }));
    return;
  }

  print(await api(config, "/api/memory"));
}
