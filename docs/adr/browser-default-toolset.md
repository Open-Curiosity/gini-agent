# ADR: Browser Toolset Enabled By Default

- **Status:** Accepted
- **Date:** 2026-05-18
- **See also:** [Minimal Trust Substrate](./trust-substrate.md), [dangerouslyAutoApprove — sanctioned approval-bypass mode](./dangerously-auto-approve.md)

## Decision

The `browser` toolset ships **enabled by default** on every new instance and on the default agent's `toolsets` whitelist. Existing instances pick the addition up on the next runtime boot via a migration helper in `normalizeState`. Six of the seven browser actions that mutate page state — `browser_click`, `browser_type`, `browser_drag`, `browser_select_option`, and `browser_tabs` (open/switch/close) plus `browser_press` — skip the approval gate; the accessibility-tree snapshot returned after each action serves as the trace evidence. The seventh, `browser_upload_file`, remains approval-gated.

The decision is scoped to:

- `src/state/defaults.ts` — the `toolset_browser` row ships with `status: "enabled"` (was `"disabled"`), and `defaultAgent(...)` includes `"browser"` in its toolsets array.
- `src/state/store.ts` — `migrateDefaultAgentToolsets` unions the current desired list into `agent_default.toolsets` (and the legacy `profile_default`) on every read. Idempotent; user-authored agents are untouched.
- `src/capabilities/agents.ts` — the `createAgent` fallback that fires when the caller omits `toolsets` unions the desired list into whatever the default agent currently has on disk. A sibling created on an old instance never inherits a stale list.
- `src/capabilities/subagents.ts` — the `spawn_subagent` fallback that fires when the caller omits `toolsets` matches.

## Context

The browser toolset shipped initially as a power-user opt-in: `toolset_browser` defaulted to `disabled`, and the default agent's whitelist did not include `browser`. The product story for the Google Workspace skills (and a growing class of "drive my Cloud Console / OAuth consent screen for me" workflows) made the gate friction-blocking: the user invokes a skill, the model has no browser tools, and the failure mode is a confusing "I can't help with this" rather than a useful sign-in handoff.

We considered three shapes:

1. **Keep the opt-in.** Every browser-dependent skill prerequisite would have to walk the user through enabling the toolset before the skill can run. The most common case (Google OAuth setup) cascades from a chat message — moving an extra side-quest to the front of every workflow is poor UX for the dominant path.
2. **Per-skill opt-in (skill requests toolset enable at trust time).** This requires a new control surface (`requiredToolsets` on `SkillRecord`, a UI to surface the request, a runtime check). The cost of building it is real, and the gate it produces is still "click a button I don't understand."
3. **Default on, with per-action approval skipping for non-destructive actions.** This is the path we took. It rests on three things being true of the browser surface:
   - The Chromium subprocess is sandboxed and isolated to a per-instance profile directory (`~/.gini/instances/<inst>/chrome-profile/`).
   - The accessibility-tree snapshot returned after each action is a complete record of *what was on screen and what the agent did* — a richer trace than the post-hoc audit row a file write produces.
   - The only browser action that can exfiltrate workspace data — `browser_upload_file` — remains approval-gated as a high-risk side effect.

## Trust-Boundary Delta

`trust-substrate.md:31` codifies "approval first for state-mutating actions." This ADR **refines** that rule for the browser surface rather than superseding it:

- For **file, terminal, code** the rule stands unchanged. Every new approval-gated tool added in those families must route through `pendingOrAuto` and produce an approval row before any side effect.
- For **browser** the trust currency shifts from "approval row decided ex ante" to "snapshot evidence emitted post-action." The snapshot contains the URL, the accessibility tree at the moment of action, and the element the agent addressed by ref — enough to reconstruct intent after the fact. Skipping the approval is acceptable *because* the snapshot is a reliable trace artifact.
- `browser_upload_file` is the explicit exception. It can move workspace bytes to a remote endpoint, and the destination is not bounded by the snapshot semantics (the upload may complete to a URL that the snapshot doesn't reveal in detail). It stays approval-gated and continues to use `pendingOrAuto`.

This is the first surface in Gini's tool catalog where a medium-risk side effect lands without an approval row by *design*, rather than via the operator-opt-in `dangerouslyAutoApprove` bypass.

## Composition With Other Trust ADRs

- **`trust-substrate.md`** — refined, not superseded. The "approval first" default still applies to every new approval-gated tool. The browser carve-out is documented here rather than as a footnote on `trust-substrate.md` so future readers can trace the decision to a single ADR.
- **`dangerously-auto-approve.md`** — different mechanism. That ADR is an operator-opt-in flag that bypasses approvals across every approval-gated surface (and even then, every bypassed action still writes an `approval.approved` audit row). This ADR's carve-out is unconditional for browser actions: the actions never create an approval row in the first place. The two mechanisms compose: an operator who flips `dangerouslyAutoApprove` on top of this default sees no change in the browser surface (the actions weren't approval-gated to begin with), and any operator who wants browser actions approval-gated can disable the toolset (escape hatch below).

## Escape Hatches

- **Per-instance runtime toggle.** `POST /api/toolsets/browser/enable` and `POST /api/toolsets/browser/disable` flip the toolset row live without restarting the runtime. When disabled, the per-tool entries flip to `disabled` via the cascaded status from the toolset row.
- **Per-agent opt-out.** The `AgentRecord.toolsets` field is the agent-level whitelist; remove `"browser"` from it and the effective context filter at `src/execution/effective-context.ts` drops the entire family from the agent's tool catalog.
- **Known limitation: no PATCH route for agents.** There is no `PATCH /api/agents/<id>` endpoint at the time of this ADR. An operator who wants to disable browser for the default agent on an existing instance must stop the runtime, hand-edit `~/.gini/instances/<inst>/state.json` to remove `"browser"` from `agent_default.toolsets`, and restart. The migration helper added in this ADR will **re-add** `"browser"` to the default agent on every boot, so the only durable way to opt the default agent out today is to disable the toolset globally via the runtime toggle. Adding `PATCH /api/agents/<id>` is a tracked follow-up.

## Required Now

- `defaultToolsets(...)` returns the `toolset_browser` row with `status: "enabled"`.
- `defaultAgent(...)` returns a toolsets array containing `"browser"`.
- `normalizeState` invokes `migrateDefaultAgentToolsets` after agents are populated. The helper unions the desired list into `agent_default` (and the legacy `profile_default`) without touching user-authored agents, and bumps `updatedAt` on the migrated record.
- `createAgent`'s fallback unions the desired list into whatever the default agent has on disk before the new record is persisted.
- `spawn_subagent`'s fallback when no `toolsets` argument is supplied matches.
- The six approval-skipping browser actions (`click`, `type`, `drag`, `select_option`, `tabs`, `press`) continue to emit accessibility-tree snapshots as their result payload. The audit trail records each action via the existing tool-call audit row; no separate `approval.requested` / `approval.approved` rows are produced.
- `browser_upload_file` keeps the existing `pendingOrAuto` route and produces an approval row with the destination URL surfaced via `peekCurrentBrowserUrl(taskId)`.

## Acceptance Checks

- A fresh instance boot writes `state.toolsets[name="browser"].status === "enabled"`, `state.tools[toolset="browser"][*].status === "available"`, and `state.agents[id="agent_default"].toolsets` containing `"browser"`.
- An instance whose `state.json` was written before this ADR landed boots cleanly, and after the first read `agent_default.toolsets` contains `"browser"`. `GET /api/status.activeAgent.toolsetFilter` includes `"browser"`.
- A user-authored agent's `toolsets` list is unchanged across the migration (covered by `src/state/store.test.ts` "unions new default toolsets into existing agent_default without touching user-authored agents").
- `browser_click` and `browser_type` produce a tool-call audit row but no `approval.requested` row; `browser_upload_file` still produces both an approval row and the file-write audit row when the operator approves.
- `POST /api/toolsets/browser/disable` flips `state.toolsets[name="browser"].status` to `"disabled"` and cascades to the tool rows.

## Consequences For Coding Agents

- New browser actions that mutate user state but stay within the page (click, type, drag, select_option, tabs, press, scroll, navigate) inherit the snapshot-as-evidence trust model. Do not add a `pendingOrAuto` wrapper to a new action of that shape.
- New browser actions whose side effect *escapes* the page (uploads, downloads to disk outside a managed location, network calls outside the loaded origin) must route through `pendingOrAuto` and produce an approval row, mirroring `browser_upload_file`. The model for "what stays in the snapshot" is the load-bearing test.
- Any future addition to the default toolsets list must also extend `migrateDefaultAgentToolsets`'s desired-list source (it reads from `defaultAgent(...)` directly, so the helper auto-picks up new entries) and add a test in `src/state/store.test.ts` that pins the migration semantics against a pre-addition state shape.
- The "approval-first" rule from `trust-substrate.md` remains the default for non-browser tools. When adding a new tool family, the bar for skipping approvals is "is there a per-action evidence artifact at least as informative as the approval row, captured atomically with the action?" The browser snapshot meets that bar; few other surfaces do.
