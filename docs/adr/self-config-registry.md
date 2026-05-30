# ADR: Self-Config Registry as Deferred Direct Tools

## Decision

Gini introspects and reconfigures its own runtime — provider/model, active
agent, skills, MCP servers, connectors — through **direct, deferred tools**
(one per capability), surfaced via the general deferred-tools mechanism
(catalog `deferred` flag + the `load_tools` meta-tool; see
agent-loop-tool-calling.md). Each capability is its own catalog tool whose
name is the operation name (`get_self`, `list_providers`, `set_provider`,
`use_agent`, …). The tool names + one-line summaries appear in the system
prompt's "Tools available on demand" index; the model `load_tools` the ones
it needs, then calls them directly by name.

This **supersedes the original two-meta-tool facade** (`self_discover` /
`self_invoke`). The general deferred-tools mechanism now solves the
keep-the-live-tool-count-low problem for the whole catalog, so a domain
-specific discover/invoke indirection is no longer warranted — the self ops
ride the same load-on-demand path as every other deferred tool.

The tools still front a registry of `SelfOperation` records in
`src/execution/self-registry.ts`, which remains the single source of truth for
each capability's BEHAVIOR: its `tag` (`query` => synchronous read; `mutate`
=> routed through the approval seam), its `handler`, and its arg `schema` (the
catalog entry mirrors this schema in its `function.parameters`). Adding a
capability = registering one operation here plus a matching catalog entry.

Because the tools are deferred, their full schemas are withheld from the live
provider `tools` array until loaded. This keeps the live full-schema tool
count low even as the number of self operations grows, which matters for
weaker local providers whose tool-selection accuracy degrades as the live tool
count grows.

## Context

The catalog described in ADR agent-loop-tool-calling.md is a static list — one
OpenAI-shape spec per tool, all sent to the model every turn. Its own Deferred
section flags this ("the catalog is currently a static list"). Exposing every
self-config capability as its own catalog entry does not scale: each wrapped
capability costs prompt tokens on every turn, and a large flat tool surface
degrades model tool-selection — earlier and more steeply for the weaker
providers Gini must support (local OpenAI-compatible servers, smaller models).

The motivating failure was concrete: asked "what model are you using," Gini
answered "I don't have visibility into the exact underlying model name" — it
had no tool to introspect itself and fell back to a disclaimer.

Two priors informed the shape:

- **OpenClaw** exposes config through a generic RPC — `config.schema.lookup`
  (discover a subtree's shape), `config.get`, `config.patch`. Discovery is
  explicit; the schema is self-describing.
- **Hermes** keeps model/provider switching OUT of the agent tool surface
  entirely — `/model` is a human slash command parsed by the CLI/gateway, not
  a tool the model calls.

We keep **named operations** (`set_provider`, not a raw path), because the
names are what the model selects against and good names drive selection
accuracy. The original facade froze a two-entry surface and did the discovery
inside the meta-tools' handlers; the deferred-tools mechanism instead withholds
each op's schema until `load_tools` pulls it live and the chat-task loop
recomputes its `tools` array (see agent-loop-tool-calling.md). The loaded set
persists on the task so it survives an approval pause/resume.

## Required Now

- `src/execution/self-registry.ts` is a **leaf module**: it must not import
  from `agent.ts` or `tool-dispatch.ts` (tool-dispatch imports the registry;
  `agent.ts` imports `findSelfOperation` to re-run a mutate handler on
  approval). Its low-risk audit write is inlined against `src/state` so no
  helper transitively re-enters `agent.ts` and forms a cycle. The inlined
  audit is best-effort: a task deleted mid-flight skips the row rather than
  throwing and discarding the handler's already-computed result.
- The self tools are on toolset `self` (not in the default toolsets) and
  bypass the toolset gate (`tool.toolset === "self"` in `buildToolCatalog`) so
  a fresh instance can answer "what model are you using" and act on the answer
  without an operator-only toggle. They are `deferred: true`, so deferral —
  not gating — is what keeps them out of the live tools array until the model
  `load_tools` them.
- The dispatcher routes the nine tool cases through one helper
  (`dispatchSelfOp`): a `query` tool runs its handler synchronously; a
  `mutate` tool (`set_provider`, `use_agent`, `create_agent`) routes through
  the approval seam (`pendingOrAuto`) as PolicyAction `self.config`. The tool
  name IS the op name and args are passed at top level.
- `self.config` policy (ADR approval-mode.md): auto-approves under `auto` (the
  default — frictionless when the user says "set provider to deepseek"), gates
  under `strict`, auto-resolves under `yolo`. The approval row carries
  `payload { opName, args, toolCallId }`; the deferred side effect runs in
  `executeApprovedAction`'s `self.config` branch, which re-reads
  `{ opName, args }`, runs the registry handler, and writes an approval-linked
  audit row (`approvalId`, `risk: medium`, the operation outcome) mirroring the
  `messaging.send` branch so the operation is joinable to the approval that
  authorized it (ADR approval-and-audit-substrate.md). Because the direct tool
  name equals the op name and its args are top-level, this payload shape is
  identical to the retired facade's — `executeApprovedAction` is unchanged.
- The nine self tool names do not trip the `riskForTool` substring heuristic
  (none contain `write`/`exec`/`invoke`/`send`), so they correctly seed as
  `low` at the tool-name level; per-operation gating happens inside dispatch
  via `self.config`, not via the tool-name heuristic.

Seed operations: `get_self`, `list_providers`, `list_agents`,
`list_skills`, `list_mcp_servers`, `list_connectors` (`query`); `set_provider`,
`use_agent`, `create_agent` (`mutate`).

## Config vs Action

Operations are tagged by what they are, not only by risk:

- `query` — read-only introspection. Runs inline, no approval.
- `mutate` — changes runtime config (provider, active agent, agent roster).
  Routed through the approval seam so `strict`-mode operators gate it.

This is distinct from the **action** tools (`file_write`, `terminal_exec`,
`send_message`, `browser_*`) which stay as first-class catalog entries: their
arguments are payloads, not paths into the agent's own configuration, and they
each carry bespoke side-effect semantics. The registry is for the agent
operating on its **own runtime state**, not for arbitrary side effects.

## Forward-Looking

The registry is intended to extend beyond the initial self-config domain to a
broader set of runtime operations the agent can perform on itself. The
invariant to preserve: the registry is the single source of truth for each
op's behavior; each op is a deferred direct tool that loads on demand and
routes by tag (query sync; mutate via `self.config`); the live full-schema
tool count stays low because unloaded ops ship no schema. Generalizing to
cover more of the `/api/*` surface is an extension of this ADR — register more
operations, add their catalog entries (deferred), and tag their risk.

## Consequences For Coding Agents

- To add a self-config / self-introspection capability, register a
  `SelfOperation` in `src/execution/self-registry.ts` AND add a matching
  deferred catalog entry (toolset `self`, `deferred: true`, `function.
  parameters` mirroring the op's schema) plus a dispatch case routed through
  `dispatchSelfOp`. The on-demand index and the gini self-skill breadcrumb
  surface it automatically.
- Keep `self-registry.ts` a leaf. A handler that needs a helper which
  transitively imports `agent.ts` must inline it or import from a neutral
  module — an import cycle through the registry breaks the build.
- `query` handlers must be side-effect-free reads. `mutate` handlers run
  inside the approval-execution path; their result string is fed back to the
  chat-task loop, so return a JSON envelope the model can act on (include
  `ok`).
- The gini self-skill (`skills/agents/gini/SKILL.md`) carries the breadcrumb
  that names the common operations and the `load_tools`-then-call flow. Keep
  it in sync when seed operations change.

## Acceptance Checks

- `buildToolCatalog` carries the nine self tools (toolset `self`,
  `deferred: true`); `applyDeferralFilter(catalog, ∅)` excludes them until
  loaded; `self_discover` / `self_invoke` are gone.
- A `query` tool (`get_self`) dispatched directly returns a sync result; a
  `mutate` tool returns a pending approval under `strict` and auto-resolves
  (running the handler) under `auto`; the resulting `self.config` audit row
  carries the `approvalId` and the operation outcome.
- The loaded set persists across an approval pause/resume (`task.loadedTools`).
- A real chat turn confirms model selection: "what model are you using" drives
  `load_tools(get_self)` then `get_self`; "set provider to deepseek" drives
  `load_tools(list_providers, set_provider)` then those tools.
- `bun run typecheck` and `bun test` are green.
