import type { RuntimeConfig } from "../types";
import { addAudit, appendEvent, createMcpServerRecord, mutateState, now, readState } from "../state";
import { spawn } from "bun";

export async function addMcpServer(config: RuntimeConfig, input: Record<string, unknown>) {
  const name = String(input.name ?? "");
  const command = String(input.command ?? "");
  if (!name || !command) throw new Error("MCP server name and command are required.");
  return mutateState(config.instance, (state) => createMcpServerRecord(state, {
    name,
    command,
    args: Array.isArray(input.args) ? input.args.map(String) : [],
    envKeys: Array.isArray(input.envKeys) ? input.envKeys.map(String) : [],
    exposedTools: Array.isArray(input.exposedTools) ? input.exposedTools.map(String) : []
  }));
}

export async function checkMcpServer(config: RuntimeConfig, idOrName: string) {
  const server = readState(config.instance).mcpServers.find((item) => item.id === idOrName || item.name === idOrName);
  if (!server) throw new Error(`MCP server not found: ${idOrName}`);
  const probe = server.status === "configured" ? await runMcpProbe(config, server.command, server.args) : { ok: false, message: "MCP server is disabled." };
  return mutateState(config.instance, (state) => {
    const server = state.mcpServers.find((item) => item.id === idOrName || item.name === idOrName);
    if (!server) throw new Error(`MCP server not found: ${idOrName}`);
    server.lastHealthAt = now();
    server.status = probe.ok ? "configured" : "error";
    server.message = probe.message;
    server.updatedAt = server.lastHealthAt;
    // MCP servers are instance-level integrations; their health probes
    // aren't per-agent activity.
    addAudit(
      state,
      {
        actor: "runtime",
        action: "mcp.health",
        target: server.id,
        risk: "low",
        evidence: { status: server.status, exposedTools: server.exposedTools, probe }
      },
      { system: true }
    );
    return server;
  });
}

// In-process options for invokeMcpTool. Mirrors the pattern in
// sendMessagingOutput: HTTP callers pass nothing, the agent-loop
// caller threads its task signal so a cancel that races in after
// approval but before the MCP process exits tears the subprocess down
// (best-effort kill via the runMcpProbe abort hook) instead of letting
// it run to completion.
export interface InvokeMcpToolOptions {
  signal?: AbortSignal;
}

export async function invokeMcpTool(
  config: RuntimeConfig,
  idOrName: string,
  toolName: string,
  input: Record<string, unknown> = {},
  options: InvokeMcpToolOptions = {}
) {
  const server = readState(config.instance).mcpServers.find((item) => item.id === idOrName || item.name === idOrName);
  if (!server) throw new Error(`MCP server not found: ${idOrName}`);
  if (server.status !== "configured") throw new Error(`MCP server is not configured: ${idOrName}`);
  if (server.exposedTools.length > 0 && !server.exposedTools.includes(toolName)) throw new Error(`MCP tool is not exposed: ${toolName}`);
  // Loud refusal when the signal is already aborted — avoids spawning
  // a subprocess we know will be torn down immediately. Mid-flight
  // abort is handled inside runMcpProbe.
  if (options.signal?.aborted) {
    throw new Error("mcp.invoke aborted: task was cancelled.");
  }
  const result = await runMcpProbe(config, server.command, [...server.args, JSON.stringify(input)], options.signal);
  await mutateState(config.instance, (state) => {
    // The current MCP entry point doesn't carry a task context (HTTP
    // surface only). Until the agent loop wires MCP through a task-bound
    // dispatcher, these stay system-attributed.
    addAudit(
      state,
      {
        actor: "runtime",
        action: "mcp.tool.invoked",
        target: server.id,
        risk: "medium",
        evidence: { toolName, ok: result.ok, stdout: result.stdout?.slice(0, 1000), stderr: result.stderr?.slice(0, 1000) }
      },
      { system: true }
    );
    appendEvent(
      state,
      {
        kind: "mcp",
        action: "mcp.tool.invoked",
        target: server.id,
        risk: "medium",
        summary: result.ok ? `MCP tool ${toolName} invoked.` : `MCP tool ${toolName} failed.`,
        data: { toolName, result }
      },
      { system: true }
    );
  });
  return { serverId: server.id, toolName, ...result };
}

export async function removeMcpServer(config: RuntimeConfig, idOrName: string) {
  return mutateState(config.instance, (state) => {
    const server = state.mcpServers.find((item) => item.id === idOrName || item.name === idOrName);
    if (!server) throw new Error(`MCP server not found: ${idOrName}`);
    server.status = "disabled";
    server.updatedAt = now();
    addAudit(
      state,
      { actor: "user", action: "mcp.disabled", target: server.id, risk: "medium" },
      { system: true }
    );
    return server;
  });
}

async function runMcpProbe(config: RuntimeConfig, command: string, args: string[], signal?: AbortSignal) {
  try {
    const proc = spawn([command, ...args], { cwd: config.workspaceRoot, stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => proc.kill(), 3000);
    // Best-effort cancellation: when the caller's signal aborts before
    // the process exits, kill it. Bun's `spawn` doesn't accept a signal
    // directly, so we register an abort listener that kills the child.
    // The detach via `{ once: true }` avoids leaking listeners across
    // long-lived signals.
    let abortKilled = false;
    const onAbort = () => {
      abortKilled = true;
      try { proc.kill(); } catch { /* already exited */ }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    try {
      [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    } finally {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
    if (abortKilled) {
      return {
        ok: false,
        message: "MCP tool aborted: task was cancelled.",
        exitCode,
        stdout: stdout.slice(0, 4000),
        stderr: stderr.slice(0, 4000),
        aborted: true as const
      };
    }
    return {
      ok: exitCode === 0,
      message: exitCode === 0 ? "MCP server command completed health probe." : `MCP command exited ${exitCode}.`,
      exitCode,
      stdout: stdout.slice(0, 4000),
      stderr: stderr.slice(0, 4000)
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
