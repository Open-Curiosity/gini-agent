# ADR: Typed, Named Credentials Referenced By Name

## Decision

A credential is a `ConnectorRecord` carrying an explicit `type` and a unique
`name`. Skills, MCP rows, and grants reference credentials **by name**, not by
provider module. Two types ship:

- **`api-key`** — one secret whose env var **is** the credential `name`
  (uppercase env-token, e.g. `LINEAR_API_KEY`). Optional `metadata.mcp`
  (`{ url, name?, headerName?, scheme? }`) registers an HTTP MCP server row;
  the row is named by `metadata.mcp.name` when set (else the credential name),
  and the header is `{[headerName ?? "Authorization"]: "<scheme ?? Bearer> ${<credential-name>}"}`.
- **`oauth2`** — a named handle (may be kebab, e.g. `google-workspace-oauth`)
  whose secret purposes materialize as env vars via
  `metadata.envMap: Record<purpose, ENV_NAME>`. Runtime-managed token refresh is
  deferred; the type reserves the structure.

`ConnectorRecord.provider` stays as a soft hint/migration breadcrumb and selects
the optional provider **module** (probe, dialog field schema, credential
template). The module is no longer required to resolve a credential: a plain
api-key with no module resolves entirely from its own `name`/secret, so adding a
new API key needs no provider code.

Skills declare `metadata.gini.requires.credentials: [<name>]`. The runtime gates
a skill active iff every required credential NAME maps to a configured + healthy
`ConnectorRecord`, and `resolveSkillEnv` materializes `prerequisites.env` from
those named credentials. Per-(skill, credential) consent
(`SkillRecord.grantedConnectors`) keys on the credential NAME
(ADR skill-connector-consent.md). Name uniqueness is enforced instance-wide.

Presence-only providers (`demo`, `claude-code`, `codex`) stay **untyped**: they
carry no env and resolve nothing.

## Context

ADR skills-and-connectors.md modeled requirements as `requires.connectors:
[{ provider }]` and resolved env per provider module (`envBindingsForProviders`).
Two problems emerged:

1. **A plain API key needed a provider module.** Every BYO key forced either a
   code module or the `generic` escape hatch, whose env resolution matched a
   secret-field name verbatim and fell back to a fail-safe on ambiguity. The
   model carried provider-keyed branches in `resolveSkillEnv`, `isSkillActive`,
   `firstUngrantedCredential`, `resolveMcpHeaders`, and MCP sync.
2. **"Reference by provider" doesn't match how the agent authors skills.** Gini
   knows the credential names (e.g. `LINEAR_API_KEY`) and should reference them
   by name when writing a skill, the same way Hermes/OpenClaw skills reference
   env vars — but with a managed credential plane behind the name.

Naming the credential and giving it a type collapses every resolution path to a
single name-based lookup and removes the provider-module requirement for plain
keys, while keeping provider modules as optional templates.

## Migration

`migrateConnectorsToTypedCredentials` runs once per instance in
`normalizeState` (marker `state.migrations.connectorsTypedCredentials`,
idempotent, one summary audit when it changes anything):

- `linear` → `api-key` named `LINEAR_API_KEY` (its single secret purpose re-keyed
  to the name; the encrypted file is untouched and resolves under the new
  purpose), `metadata.mcp` driving the existing `linear` MCP row.
- `google-oauth-desktop` → `oauth2` named `google-workspace-oauth` with
  `metadata.envMap` reversing the module's `envBindings` (purposes unchanged).
- `generic` → `api-key` named by its field purpose (1 secret) or `oauth2` with an
  identity envMap (2+).
- presence-only providers stay untyped.
- skill `requiredConnectors` → `requiredCredentials`; `grantedConnectors`
  provider→name.

Collision (a generic field colliding with a template-typed canonical name): the
template-typed credential keeps the canonical name; the generic dup is renamed
`<name>_2` with a `connector.migration_collision` audit.

Bundled SKILL.md frontmatter is edited on disk (re-parsed on boot), not rewritten
by the migration.

## MCP row reconcile

A migrated Linear instance keeps exactly **one** Linear MCP row, named `linear`,
because the `LINEAR_API_KEY` credential's `metadata.mcp.name` targets that row.
The credential-driven sync no-ops on the existing row; the header still resolves
`${LINEAR_API_KEY}` by env-var name (independent of the row name), so skills that
call `server: "linear"` keep working and no separate `LINEAR_API_KEY` row is
created.

## Legacy `requires.connectors` compatibility

The loader still **parses** `requires.connectors` for one release. When a skill
declares only the legacy form, the loader derives `requiredCredentials` from a
template provider→name table (`linear` → `LINEAR_API_KEY`,
`google-oauth-desktop` → `google-workspace-oauth`); `generic`/unknown providers
have no canonical name and are dropped. **Runtime resolution is purely
name-based** — there is no provider-keyed resolution path left in
`resolveSkillEnv`, `isSkillActive`, `firstUngrantedCredential`, or MCP sync.

`resolveMcpHeaders` keeps a provider-declared block-list (every env var any
provider declares as a secret) as a defense-in-depth guard: such a var can ONLY
be supplied by a live credential, never by `process.env`, so deleting a
credential can't leave an MCP row authenticated from the operator's shell. This
is a block-list, not a resolution source.

## Rejected

- **Renaming the skill body's `server: "linear"` to the env-var name.** Couples
  the user-facing MCP server name to an env var and churns the skill body;
  `metadata.mcp.name` keeps the row name stable instead.
- **Re-keying nothing on the api-key migration.** `bindingsForCredentials` reads
  the single secret purpose, so resolution would work either way, but re-keying
  the purpose to the credential name keeps the record self-consistent.
- **Dropping the provider-declared block-list with the provider-fallback.** It is
  a security boundary (no shell-supplied credentials), not the fallback.

## Deferred

- Runtime-managed OAuth2 token refresh (gws owns its tokens today).
- Credential types beyond `api-key` and `oauth2`.

## Consequences For Coding Agents

- Reference credentials by NAME. Skills use `metadata.gini.requires.credentials`;
  grants and MCP rows resolve by credential name.
- A plain API key needs no provider module — set `type: "api-key"`, a name that
  is its env var, and (optionally) `metadata.mcp`.
- Do not add provider-keyed resolution branches back. The only name→env mapping
  is `bindingsForCredentials`.
- When a credential backs an MCP server whose name differs from the credential
  name, set `metadata.mcp.name`.

## Acceptance Checks

- `bun run typecheck` clean (root + web).
- `bun test` passes including the migration test (typed+named with secrets
  intact, skill requires/grants converted, exactly one Linear MCP row, idempotent
  second run, collision renamed + audited) and the name-based resolution tests.
- `bun run gini smoke` runs to completion; the Linear MCP server resolves
  `${LINEAR_API_KEY}`, a Linear-referencing skill resolves env by name, and a
  google-referencing skill materializes `GOOGLE_WORKSPACE_CLI_CLIENT_ID/SECRET`.
- A pre-migration provider-keyed instance upgrades with no manual reconnection.
