import type { RuntimeConfig } from "../types";
import { addAudit, createMcpServerRecord, mutateState, now } from "../state";

export function addMcpServer(config: RuntimeConfig, input: Record<string, unknown>) {
  const name = String(input.name ?? "");
  const command = String(input.command ?? "");
  if (!name || !command) throw new Error("MCP server name and command are required.");
  return mutateState(config.lane, (state) => createMcpServerRecord(state, {
    name,
    command,
    args: Array.isArray(input.args) ? input.args.map(String) : [],
    envKeys: Array.isArray(input.envKeys) ? input.envKeys.map(String) : [],
    exposedTools: Array.isArray(input.exposedTools) ? input.exposedTools.map(String) : []
  }));
}

export function checkMcpServer(config: RuntimeConfig, idOrName: string) {
  return mutateState(config.lane, (state) => {
    const server = state.mcpServers.find((item) => item.id === idOrName || item.name === idOrName);
    if (!server) throw new Error(`MCP server not found: ${idOrName}`);
    server.lastHealthAt = now();
    server.message = server.status === "configured"
      ? "MCP server record is configured. Live protocol connection is deferred until the MCP transport slice."
      : "MCP server is disabled.";
    server.updatedAt = server.lastHealthAt;
    addAudit(state, {
      actor: "runtime",
      action: "mcp.health",
      target: server.id,
      risk: "low",
      evidence: { status: server.status, exposedTools: server.exposedTools }
    });
    return server;
  });
}

export function removeMcpServer(config: RuntimeConfig, idOrName: string) {
  return mutateState(config.lane, (state) => {
    const server = state.mcpServers.find((item) => item.id === idOrName || item.name === idOrName);
    if (!server) throw new Error(`MCP server not found: ${idOrName}`);
    server.status = "disabled";
    server.updatedAt = now();
    addAudit(state, { actor: "user", action: "mcp.disabled", target: server.id, risk: "medium" });
    return server;
  });
}
