# ADR: Self-Config Registry Behind Discover/Invoke Meta-Tools

## Decision

Gini introspects and reconfigures its own runtime — provider/model, active
agent, skills, MCP servers, connectors — through **two always-on meta-tools**
rather than one catalog entry per capability:

- `self_discover(name?, tag?)` — returns the index of self operations (each
  `{ name, summary, tag }`); pass `name` for one operation's full argument
  schema, `tag` (`query` | `mutate`) to filter.
- `self_invoke(name, args)` — runs a named operation. Args are validated
  against the operation's JSON Schema; a validation miss returns the schema so
  the model self-corrects.

Both front a registry of `SelfOperation` records in
`src/execution/self-registry.ts`. Each record is the single source of truth
for one capability: its `summary` (the discovery index entry), its `tag`
(`query` => synchronous read; `mutate` => routed through the approval seam),
its arg `schema`, and its `handler`. Adding a capability = registering one
operation — no separate catalog/dispatch/skill edit.

The **operation names are the load-bearing discovery index**; full arg schemas
are fetched on demand via `self_discover`. This keeps the live full-schema
tool count constant (two entries) regardless of how many self operations
exist, which matters for weaker local providers whose tool-selection accuracy
degrades as the live tool count grows.

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

We take OpenClaw's discover-then-act shape but keep **named operations**
(`set_provider`, not a raw path), because the names are what the model selects
against and good names drive selection accuracy. The chat-task loop builds its
`tools` array once per loop entry and freezes it for the turn (see
agent-loop-tool-calling.md), so the dynamism lives entirely inside the two
meta-tools' handlers — no per-turn schema injection, no `toolsHash` churn.

## Required Now

- `src/execution/self-registry.ts` is a **leaf module**: it must not import
  from `agent.ts` or `tool-dispatch.ts` (tool-dispatch imports the registry;
  `agent.ts` imports `findSelfOperation` to re-run a mutate handler on
  approval). Its low-risk audit write is inlined against `src/state` so no
  helper transitively re-enters `agent.ts` and forms a cycle. The inlined
  audit is best-effort: a task deleted mid-flight skips the row rather than
  throwing and discarding the handler's already-computed result.
- `self_discover` and `self_invoke` are always-on (toolset `self`, not in the
  default toolsets) so a fresh instance can answer "what model are you using"
  and act on the answer without an operator-only toggle.
- `self_invoke` resolves the operation by name (unknown name returns a
  recoverable `{ ok: false, didYouMean }` — never throws), shallow-validates
  required args (returning the schema on a miss), then routes by tag:
  - `query` runs the handler synchronously and returns its string.
  - `mutate` routes through the approval seam (`pendingOrAuto`) as PolicyAction
    `self.config`.
- `self.config` policy (ADR approval-mode.md): auto-approves under `auto` (the
  default — frictionless when the user says "set provider to deepseek"), gates
  under `strict`, auto-resolves under `yolo`. The approval row carries
  `payload { opName, args, toolCallId }`; the deferred side effect runs in
  `executeApprovedAction`'s `self.config` branch, which re-reads
  `{ opName, args }`, runs the registry handler, and writes an approval-linked
  audit row (`approvalId`, `risk: medium`, the operation outcome) mirroring the
  `messaging.send` branch so the operation is joinable to the approval that
  authorized it (ADR approval-and-audit-substrate.md).
- `self_invoke` carries an explicit `TOOL_RISK` entry of `low` so the
  substring heuristic (`includes("invoke")`) does not seed it high-risk;
  per-operation gating happens inside dispatch via `self.config`, not via the
  tool-name heuristic.

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
broader set of runtime operations the agent can perform on itself, without
re-introducing one catalog tool per operation. The invariant to preserve:
discovery (`self_discover`) lists names + summaries; invocation
(`self_invoke`) validates and routes by tag; the registry is the single
source of truth; the live full-schema tool count stays at two. Generalizing
to cover more of the `/api/*` surface is an extension of this ADR, not a new
mechanism — register more operations and tag their risk; do not wrap
endpoints as individual tools.

## Consequences For Coding Agents

- To add a self-config / self-introspection capability, register a
  `SelfOperation` in `src/execution/self-registry.ts`. Do NOT add a new
  catalog tool for it. The two meta-tools and the gini self-skill breadcrumb
  surface it automatically.
- Keep `self-registry.ts` a leaf. A handler that needs a helper which
  transitively imports `agent.ts` must inline it or import from a neutral
  module — an import cycle through the registry breaks the build.
- `query` handlers must be side-effect-free reads. `mutate` handlers run
  inside the approval-execution path; their result string is fed back to the
  chat-task loop, so return a JSON envelope the model can act on (include
  `ok`).
- The gini self-skill (`skills/agents/gini/SKILL.md`) carries the breadcrumb
  that names the common operations so the hot path is a single `self_invoke`
  with no `self_discover` round-trip. Keep it in sync when seed operations
  change.

## Acceptance Checks

- `self_discover()` returns every operation with `name`, `summary`, `tag`;
  `self_discover({ tag })` filters; `self_discover({ name })` returns one
  operation's schema; an unknown name returns `{ ok: false }` without throwing.
- `self_invoke` of a `query` op returns a sync result; an unknown op or a
  missing required arg returns a recoverable `{ ok: false, ... }` (schema on a
  validation miss).
- `self_invoke` of a `mutate` op returns a pending approval under `strict` and
  auto-resolves (running the handler) under `auto`; the resulting
  `self.config` audit row carries the `approvalId` and the operation outcome.
- A real chat turn confirms model selection: "what model are you using" drives
  `self_invoke(get_self)`; "set provider to deepseek" drives
  `list_providers` then `self_invoke(set_provider)`.
- `bun run typecheck` and `bun test` are green.
