---
name: create-skill
description: "Author a new SKILL.md from a user prompt, or migrate an existing non-spec skill to the Anthropic Agent Skills format."
license: MIT
compatibility: "Requires the gini gateway."
allowed-tools: "Bash file_write file_patch"
metadata:
  gini:
    version: 1.0.0
    author: Gini
    category: meta
    requires:
      connectors: []
---

# Create Skill

You author new skills from a prompt and migrate legacy skills to the
Anthropic Agent Skills specification. The goal is one spec-compliant
SKILL.md plus optional scripts the agent can later run.

## When To Use

- User asks "create a skill for X" or "add a skill that does X".
- User pastes a SKILL.md that is missing required fields or uses the
  legacy top-level fields (`version`, `author`, `platforms`,
  `prerequisites`, `requires.connectors`).
- User asks "make this work" while looking at a non-spec SKILL.md.

## Spec Reference

Required top-level frontmatter keys (Anthropic Agent Skills spec):

- `name` — max 64 chars, lowercase + digits + hyphens, must equal the
  parent directory name.
- `description` — max 1024 chars.

Optional spec keys:

- `license` — free-form string.
- `compatibility` — max 500 chars; human summary of environment needs.
- `metadata` — arbitrary; Gini extensions live under `metadata.gini.*`.
- `allowed-tools` — space-separated list of tool names the skill plans
  to invoke (advisory; recorded in audit trail).

Gini extensions (under `metadata.gini`):

- `version`, `author`, `platforms`, `category`
- `prerequisites: { commands, env }`
- `requires.connectors: [{ provider, scopes? }]`
- `scripts` (Anthropic Agent Skills `scripts/` convention) — each entry
  declares an executable companion the agent can invoke as a tool. See
  the "Scripts" section below.

## Procedure

1. Confirm the user's intent. If the request is "create a skill that
   posts to Slack", clarify whether the skill should also read messages,
   list channels, etc. — surface the cardinality so the design is right.

2. Decide whether the skill needs a connector. Use
   `requires.connectors` only when the skill needs a configured account,
   credential, remote API, or connector-backed local integration. If the
   skill only needs local commands such as `git`, `gh`, `jq`, or `curl`,
   record those under `prerequisites.commands` and set
   `requires.connectors: []`. If a fitting connector exists in
   `/api/connectors/providers`, use it. If the skill truly needs an
   unsupported external system, declare `provider: generic` under
   `requires.connectors`. Do not ask the user to pick between
   install/skip on unknown providers — default to forward motion.

3. Draft the frontmatter. Use this template:

   ```yaml
   ---
   name: <kebab-case-name>
   description: "<one-liner>"
   license: MIT
   compatibility: "<one sentence describing host requirements>"
   allowed-tools: "<space-separated tool names>"
   metadata:
     gini:
       version: 1.0.0
       author: <user-or-"Gini">
       platforms: [<macos|linux|windows>]
       prerequisites:
         commands: [<cli names>]
         env: [<ENV_VAR_NAMES>]
       requires:
         # Leave empty for local-command-only skills. If a connector is
         # needed, use: [{ provider: <id>, scopes: [<optional>] }]
         connectors: []
   ---
   ```

4. Write the body. The body is the model's manual for this skill at
   runtime — concrete examples, when-to-use / when-not-to-use sections,
   exact commands. Imitate the body shape of
   `skills/apple/apple-notes/SKILL.md` for a working reference.

5. Validate before writing to disk. Run:

   ```bash
   bun run gini skill validate /tmp/draft-skill.md
   ```

   Fix every issue the validator reports. Common failures:
   - `name` is uppercase or contains underscores → switch to kebab-case.
   - `description` exceeds 1024 chars → tighten it.
   - parent dir name doesn't match `name` → adjust whichever is wrong.
   - required provider doesn't exist → if the skill needs a real external
     system, switch to `generic` or add the provider module first; if it
     only needs local commands, remove the connector requirement.

6. Install the skill via the API so the runtime picks it up:

   ```bash
   curl -sS -X POST http://localhost:<runtime-port>/api/skills \
     -H "authorization: Bearer $GINI_TOKEN" \
     -H "content-type: application/json" \
     -d "$(jq -nc \
       --arg body "$(cat /tmp/draft-skill.md)" \
       --arg category "<optional category override>" \
       '{ body: $body, category: $category }')"
   ```

   The endpoint writes the file under
   `~/.gini/instances/<instance>/skills/<category>/<name>/SKILL.md`
   and triggers a loader reload. The response includes the new
   `SkillRecord` with `validation: { ok, issues }`.

7. Walk the connector dependency:

   - List the providers the skill declares in `requires.connectors`.
   - For each, check `GET /api/connectors`. If a healthy connector for
     that provider already exists, you are done.
   - If not, tell the user: "Open `/skills`, find the new skill, and
     click the inline `[Set up <Provider>]` button next to the missing
     connector." There is no standalone Connectors page; setup is
     inline on the Skills page.

## Scripts

A skill folder can ship a `scripts/` subdirectory with executable
companions (Anthropic Agent Skills convention). Each script declared
under `metadata.gini.scripts` registers as a runtime tool the agent
invokes directly — the dispatcher spawns `bun run <script>`, pipes the
agent's args object as JSON via stdin, and reads JSON from stdout as the
tool result. This is the right place for orchestration the model can't
drive on its own: signed-URL uploads, multi-step API flows, anything
that needs runtime-injected credentials.

### When to add a script

- The orchestration needs a credential the skill's `requires.connectors`
  declares (e.g. a Linear bearer token). The runtime injects every
  declared env var via `metadata.gini.prerequisites.env` into the
  script's environment.
- The flow has multiple HTTP steps that the model couldn't compose
  through `web_fetch` alone (signed PUT to a third-party URL, etc.).
- You want a deterministic, server-side path that's testable in
  isolation (unit-test the script directly with `bun test`).

### When NOT to add a script

- The user-facing CLI is rich enough that the model can drive it via
  `terminal_exec` (the `gws`, `memo`, `gh` pattern). Skills like
  `apple-notes`, `google-drive`, etc. don't need scripts — the model
  reads the SKILL.md body and runs the CLI directly.
- The task is one HTTP call the model can already make via `mcp_call`.

### Frontmatter declaration

Add a `scripts` array under `metadata.gini`:

```yaml
metadata:
  gini:
    prerequisites:
      env: [LINEAR_API_KEY]
    requires:
      connectors:
        - provider: linear
    scripts:
      - file: scripts/attach.ts
        tool:
          name: linear_attach_image
          description: "Attach a chat-uploaded image to a Linear issue."
          parameters: '{"type":"object","properties":{"issue":{"type":"string"},"uploadId":{"type":"string"}},"required":["issue","uploadId"]}'
```

`parameters` is a JSON-encoded JSON Schema. Keep it inline as a
string — the loader's YAML-ish parser handles flat structures cleanly
but the JSON-string form is more robust for deeply nested schemas.

The tool name must be unique across all enabled skills' scripts. The
runtime registers it with the catalog's always-on filter, so the agent
sees it regardless of toolset toggles whenever the skill is enabled.

### Script contract

Write the script at `scripts/<name>.ts`. It runs as a Bun process. The
runtime provides:

- **stdin**: a single JSON object — the args the agent passed to the
  tool. Read with `await Bun.stdin.text()` and `JSON.parse(...)`.
- **env**: `LINEAR_API_KEY` (or whatever connector env vars the skill
  declares under `prerequisites.env`, resolved from healthy connectors),
  plus `GINI_INSTANCE`, `GINI_UPLOADS_DIR`, `GINI_TASK_ID`, `PATH`,
  `HOME`. Nothing else is inherited — keep the surface narrow.
- **stdout**: a single JSON object. The runtime returns this verbatim
  as the tool result. Convention: `{ ok: boolean, error?: string, ... }`.
- **exit code**: 0 on success, non-zero on hard failure. The runtime
  also returns `ok: false` when stdout isn't valid JSON or is empty.

The script never sees the gateway, the model, or any other tool. It
runs once per invocation and exits.

### Trust boundary

Only **bundled** skills' scripts (vendored under `<repo>/skills/`)
auto-register as tools. User-imported skills are loaded as markdown
only — the loader still records their `scripts` declarations, but the
runtime ignores them at catalog/dispatch time. This mirrors npm's
trusted-package vs. arbitrary-install split. When a user wants to add
a third-party skill that ships scripts, the path today is a PR to
vendor the skill into the bundled set after review.

## Migration Mode

When converting a legacy SKILL.md, the recipe is:

1. Move `version`, `author`, `platforms`, `prerequisites`, and
   `requires.connectors` (with `provider:` items) under
   `metadata.gini.*` — paying attention to the renames introduced by
   ADR connector-provider-spec-compliance.md:
   - `requires.identities[].kind` → `requires.connectors[].provider`.
   The legacy `requires.identities` / `kind:` shape is what older
   pre-ADR-connector-provider-spec-compliance.md SKILL.md files used; rewrite both keys when migrating.

2. Move `compatibility` to the top level if you can describe the host
   contract in ≤ 500 chars.

3. Add `allowed-tools` at the top level when the skill is meant to run
   under an agent harness that respects it.

4. Re-validate with `gini skill validate` before installing.

## Rules

- Never write a skill without validating first.
- Always check `GET /api/connectors/providers` for the providers the new
  skill will depend on. Prefer existing providers over `generic`, and do
  not add `generic` for local-command-only skills.
- Bundled skills are immutable from the agent's perspective — if the
  user asks to edit a bundled skill, instead create a user-source copy
  with the same name. The runtime keeps both as separate rows.
- Do not embed plaintext API tokens or secrets in SKILL.md body.
