# Gini Agent Project Instructions

These instructions apply to the whole repository unless a nested `AGENTS.md` overrides them for a subtree.

## Project Shape

Gini is a local-first Bun TypeScript agent runtime. The gateway owns durable state and execution. CLI, Next.js, future mobile, MCP, messaging, and scripts are clients of the same runtime contract.

Key docs:

- `README.md` is the entry point and docs index.
- `docs/master-plan.md` tracks the high-level goal, principles, and roadmap.
- `docs/architecture-overview.md` gives the system map.
- `docs/gateway.md`, `docs/conversation-runs.md`, `docs/memory.md`, `docs/operations.md`, and `docs/runtime-capabilities.md` document focused runtime areas.
- `docs/adr/` records important architecture decisions.

## ADRs Are Living Documents

Keep ADRs current when architecture changes.

- Update an existing ADR when the original decision still stands but implementation details, consequences, or acceptance checks changed.
- Add a new ADR when introducing a significant new architecture decision, trust boundary, persistence model, process shape, provider strategy, client contract, or operational workflow.
- Do not use ADRs as stale milestone notes. They should explain decisions that still matter.
- If a change makes an ADR obsolete, mark the old decision as superseded and link to the replacement ADR.
- When updating runtime architecture, also check `README.md`, `docs/master-plan.md`, `docs/architecture-overview.md`, and the focused docs for drift.

## Implementation Boundaries

- Prefer existing module patterns over new abstractions.
- API handlers should delegate behavior to `src/domain/*`.
- Storage and low-level persistence belong in `src/state/*`.
- CLI commands should prefer the public runtime API for product behavior.
- Browser code must not receive gateway bearer tokens; keep token injection server-side in the Next.js BFF.
- Side-effecting tools must preserve approval, audit, and trace behavior.
- Instance-aware paths, ports, logs, and state must remain isolated.

## Verification

For code changes, run the narrow relevant tests plus the broader checks when practical:

```bash
bun run typecheck
bun test
bun run gini smoke
```

For docs-only changes, at minimum sweep for stale links and terminology:

```bash
rg -n "v0|v1|v2|v3|lane|v1-readiness|single HTML|src/state\\.ts|src/api" README.md docs
```

The compatibility command/API name `readiness v1` and `/api/readiness/v1` may still appear, but they should not drive product planning language.

## Runtime Logs

Gini captures spawned child stdio under:

```text
~/.gini/instances/<instance>/logs/
```

Common files:

- `web.log`: Next.js dev server stdout/stderr
- `runtime-stdout.log`: Bun runtime stdout/stderr
- `runtime.jsonl`: structured runtime events
