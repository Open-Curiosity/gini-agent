# ADR: Skill env containment for terminal_exec and skill_run

## Decision

Connector-derived env vars are scoped to one skill at a time. The
runtime never aggregates env across skills into a single spawn. Two
explicit invocation surfaces enter a skill's env scope; everything else
runs with a clean env (no connector secrets, only `PATH` / `HOME` /
runtime-context vars):

- **`terminal_exec({command, skill?})`** — runs an arbitrary shell
  command. When `skill` is supplied, only that skill's
  `resolveSkillEnv` output is injected. When `skill` is omitted (the
  default and the case for any non-skill-CLI command), no connector
  env is injected at all.

- **`skill_run({skill, script, args})`** — runs a script that ships in
  `<skill>/scripts/`. Env is always scoped to the named skill via
  `resolveSkillEnv`. The model passes the skill name and script name
  (not a path or command string), so the runtime — not the model —
  picks the file on disk.

Both surfaces share `resolveSkillEnvByName(config, skillName, taskId)`
in `src/integrations/connectors/index.ts`. It looks up the named
enabled skill and returns that skill's `resolveSkillEnv` map, or `{}`
for `undefined` / unknown / disabled inputs. There is no aggregate
"all active skills" helper — the old `resolveActiveSkillsEnv` is gone.

## Context

Connector secrets are bound to skills through two SKILL.md frontmatter
fields:

- `metadata.gini.requires.connectors` declares which provider modules a
  skill needs to be active.
- `metadata.gini.prerequisites.env` lists the env var names the skill's
  CLI / scripts read at runtime (`LINEAR_API_KEY`,
  `GOOGLE_WORKSPACE_CLI_CLIENT_ID`, etc.).

`resolveSkillEnv(config, skill, taskId?)` maps the declared env names
against the connector module's `secrets.envBindings`, finds the matching
healthy connector record, reads the per-instance encrypted secret, and
returns a `{ENV_NAME: secret-value}` object. This per-skill resolution
has always existed and is the right unit of env containment.

The original spawn paths called a different helper,
`resolveActiveSkillsEnv`, which iterated *every* enabled, active skill
and `Object.assign`-merged each one's `resolveSkillEnv` output into a
single env object. The spawn path then injected the merged map into
**every** `terminal_exec` invocation regardless of which skill (if any)
the model was acting under.

The aggregation pre-dated `skill_run` and the connector-provider rewrite;
back when skills were a smaller surface, "all enabled skills' env" was a
useful default for letting `terminal_exec` "just work" when the model
followed any skill's instructions. It quietly stopped being right once
skills started layering credentials across providers (Linear, GitHub,
Google, Notion, etc.).

### Why aggregation was the wrong default

A SKILL.md activating to put credentials inside a process is a
deliberate trust grant. The user accepted scope X at install/connection
time. Aggregation widened that grant transitively: enabling the
`apple-notes` skill (which declares no env vars) didn't expand the
credential surface, but enabling `linear` *did* add `LINEAR_API_KEY` to
every `gws` invocation, every `git status`, every `curl`, and every
`bun` invocation the model ever made. A compromised or buggy command —
whether from a model error, a prompt injection, or a third-party skill
script following Anthropic-style "run `bun scripts/foo.ts`" guidance —
got every other connector's secret along with it.

The new `skill_run` dispatch already used `resolveSkillEnv` (one skill
only). The fact that we needed a separate dispatch path to get scoped
env was the tell: `terminal_exec`'s default was the bug.

### Considered alternatives

- **Path-sniffing `terminal_exec`.** Detect when the command string
  resolves to a known skill's `scripts/` file and route through scoped
  semantics automatically. Rejected: shell-command recognition is a
  bad privilege boundary. Quoting, symlinks, `env` wrappers, aliases,
  pipes, `cwd`, command substitution, and multi-command strings all
  defeat path matching. An attacker (or the model on a bad day) can
  trivially construct a command that looks-like-a-skill-script but
  isn't, or a real skill-script invocation wrapped in additional
  effects that bypass approval gates.

- **Add a sibling `skill_exec({skill, command, args?})` tool, leave
  `terminal_exec` aggregating.** Rejected: keeps the leak in the
  generic path. Operators auditing per-process credentials would
  still have to inspect every `terminal.exec` audit row to know what
  secrets were available. The principle "default-deny on connector
  env" is what makes the audit trail meaningful.

- **Per-script connector declarations in SKILL.md frontmatter.**
  Tracked in [ENG-1606](https://linear.app/lilac-labs/issue/ENG-1606)
  (skill-script capability declarations). Operates at finer grain than
  per-skill scoping — each script declares which subset of the skill's
  connectors it needs. Compatible with this ADR; tightens scoping
  inside `skill_run` further when implemented. Deferred until the
  install-time validation surface is ready.

## Consequences

### Required

- `terminal_exec` callers that invoke a skill's CLI **must** pass
  `skill: "<name>"` to receive that skill's env. The `terminal_exec`
  tool description in `src/execution/tool-catalog.ts` documents this;
  the model picks `skill` from context (the skill it's following).
  Bundled CLI-wrapper skills' SKILL.md examples don't need to repeat
  the instruction — the tool description carries the guidance.

- Skill authors who ship CLI-wrapper skills with `prerequisites.env`
  declarations must rely on callers passing `skill`. There is no
  fallback path that injects their env without an explicit invocation.

- Any future tool that spawns a process with connector env must use
  `resolveSkillEnvByName` (or `resolveSkillEnv` directly), not
  re-implement aggregation. `resolveActiveSkillsEnv` is gone from the
  codebase and should not be reintroduced.

### Audited surfaces

Two audit row kinds attribute spawned commands to a skill context:

- `terminal.exec` rows from the dispatcher record `payload.skill` and
  the audit's `evidence.skill` field. Unattributed invocations (no
  `skill` arg) appear with `skill: undefined`, signaling no connector
  env was injected.

- `skill.script.invoked` rows from `skill_run` always attribute to the
  invoked skill by construction.

Both attribution paths let operators query "which commands ran under
skill X" without scanning the command-string itself for substrings.

### Trust boundary

The model's invocation shape is the trust boundary, not the executed
process. Two surfaces with the same execution semantics intentionally
have different invocation contracts:

- **`skill_run`** takes structured **names** (`{skill, script}`). The
  runtime resolves the names to a file on disk. The model never picks
  the path. Approval is not required because the user accepted the
  skill at install/enable time; the bytes the runtime spawns are
  exactly the bytes the user reviewed.

- **`terminal_exec`** takes a **command string** the model wrote. The
  runtime executes the string verbatim. Approval is gated by policy
  because the user did not pre-approve the model's specific string;
  the dangerous-pattern check and the approval seam apply.

Aggregation broke this trust split by making `terminal_exec` (model-
written string) silently carry all the connector credentials that
`skill_run` (name-resolved trusted code) was designed to carry. Scoping
restores the split.

## Implementation surface

- `src/integrations/connectors/index.ts`:
  - `resolveSkillEnvByName(config, skillName, taskId?)` exported.
  - `resolveActiveSkillsEnv` removed; comment block in place to prevent
    its reintroduction.
- `src/execution/tool-catalog.ts`: `terminal_exec` parameter schema
  declares optional `skill: string`. Description documents the no-env
  default and the per-skill opt-in.
- `src/execution/policy.ts`: `TerminalExecPayload` carries optional
  `skill`. Policy decisions don't currently branch on it (see
  [ENG-1606](https://linear.app/lilac-labs/issue/ENG-1606) for the
  effect-class follow-up).
- `src/execution/tool-dispatch.ts`: `terminalExecDispatch` parses
  `skill` from args, threads it through the auto-approve fast-path
  (`runTerminalCommand`) and the approval request path
  (`requestTerminalExec` → approval payload).
- `src/agent.ts`: `runTerminalCommandClaimed` and the post-approval
  executor both replace `resolveActiveSkillsEnv` with
  `resolveSkillEnvByName(config, options.skill, taskId)` /
  `resolveSkillEnvByName(config, approval.payload.skill, approval.taskId)`.
- `src/capabilities/skill-scripts.ts`: `invokeSkillScript` uses
  `resolveSkillEnv` directly (the script always knows its owning
  skill), unchanged by this ADR.

## Acceptance checks

- `bun test src/integrations/connectors/index.test.ts` covers
  `resolveSkillEnvByName`: undefined → empty, unknown skill → empty,
  matching skill → only its env, disabled skill → empty, and the
  cross-skill leak test (linear invocation does not see `GOOGLE_*`,
  vice versa).
- Existing `terminal_exec` happy-path tests still pass; the auto-
  approve and approval-resolution paths both flow `skill` through to
  the spawn site.
- E2E verified during ENG-1613 (PR #158): a chat-driven Linear
  attachment flow that includes `skill_run` against the `attachments`
  skill plus surrounding `mcp_call` invocations runs without
  regression.

## Related

- [ENG-1613](https://linear.app/lilac-labs/issue/ENG-1613) — the
  containment bug this ADR closes.
- [ENG-1606](https://linear.app/lilac-labs/issue/ENG-1606) — skill-
  script capability declarations (per-script connector scoping, schema
  validation, effect-class declaration) that build on this ADR.
- ADR `connector-provider-spec-compliance.md` — provider modules
  declare `secrets.envBindings`, which `resolveSkillEnv` consults.
- ADR `connector-secret-storage.md` — how connector secrets are
  encrypted at rest before `resolveSkillEnv` resolves them at spawn.
- ADR `approval-and-audit-substrate.md` — the policy seam through
  which `terminal_exec`'s payload (now including `skill`) flows.
