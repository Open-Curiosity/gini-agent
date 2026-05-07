import type { Lane, ProfileRecord, ToolRecord, ToolsetRecord } from "../types";

export function defaultToolsets(lane: Lane, at: string): ToolsetRecord[] {
  return [
    {
      id: "toolset_file",
      lane,
      name: "file",
      description: "Workspace file read, search, list, and approval-gated write operations.",
      status: "enabled",
      toolNames: ["file.read", "file.search", "file.list", "file.write"],
      scopes: ["task", "job", "skill", "subagent"],
      createdAt: at,
      updatedAt: at
    },
    {
      id: "toolset_terminal",
      lane,
      name: "terminal",
      description: "Approval-gated shell execution with timeout and trace evidence.",
      status: "enabled",
      toolNames: ["terminal.exec"],
      scopes: ["task", "job", "skill", "subagent"],
      createdAt: at,
      updatedAt: at
    },
    {
      id: "toolset_memory",
      lane,
      name: "memory",
      description: "Inspectable memory proposal, activation, retrieval, and rejection flows.",
      status: "enabled",
      toolNames: ["memory.search", "memory.propose", "memory.activate"],
      scopes: ["task", "job", "skill", "subagent"],
      createdAt: at,
      updatedAt: at
    },
    {
      id: "toolset_session_search",
      lane,
      name: "session_search",
      description: "Search prior tasks, traces, memories, skills, and audit events with source links.",
      status: "enabled",
      toolNames: ["session.search"],
      scopes: ["task", "job", "skill", "subagent"],
      createdAt: at,
      updatedAt: at
    },
    {
      id: "toolset_delegation",
      lane,
      name: "delegation",
      description: "Spawn isolated subagent tasks with toolset limits and trace linkage.",
      status: "enabled",
      toolNames: ["delegate.task"],
      scopes: ["task", "job", "skill"],
      createdAt: at,
      updatedAt: at
    },
    {
      id: "toolset_mcp",
      lane,
      name: "mcp",
      description: "Expose selected external MCP tools through configured server records.",
      status: "disabled",
      toolNames: ["mcp.invoke"],
      scopes: ["task", "job", "skill", "subagent", "mcp"],
      createdAt: at,
      updatedAt: at
    },
    {
      id: "toolset_messaging",
      lane,
      name: "messaging",
      description: "Bridge task input and notifications to configured messaging channels.",
      status: "disabled",
      toolNames: ["message.send"],
      scopes: ["job", "messaging"],
      createdAt: at,
      updatedAt: at
    }
  ];
}

export function defaultTools(lane: Lane, at: string): ToolRecord[] {
  return defaultToolsets(lane, at).flatMap((toolset) => toolset.toolNames.map((name) => ({
    id: `tool_${name.replaceAll(".", "_")}`,
    lane,
    name,
    description: `${name} from ${toolset.name} toolset`,
    toolset: toolset.name,
    status: toolset.status === "enabled" ? "available" : "disabled",
    risk: name.includes("write") || name.includes("exec") || name.includes("invoke") || name.includes("send") ? "high" : "low",
    requiresApproval: name.includes("write") || name.includes("exec") || name.includes("invoke") || name.includes("send"),
    createdAt: at,
    updatedAt: at
  } satisfies ToolRecord)));
}

export function defaultProfile(lane: Lane, at: string): ProfileRecord {
  return {
    id: "profile_default",
    lane,
    name: "default",
    status: "active",
    providerName: "echo",
    model: "gini-echo-v0",
    toolsets: ["file", "terminal", "memory", "session_search", "delegation"],
    memoryScopes: ["user", "project", "device", "temporary"],
    messagingTargets: [],
    createdAt: at,
    updatedAt: at
  };
}
