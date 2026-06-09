# ADR: Model-First Selection (Models With Routes, Not Providers With Models)

- **Status:** Accepted
- **Date:** 2026-06-09
- **See also:** [Per-Agent Provider Settings](./per-agent-provider-settings.md), [Agents Replace Profiles And Drive Runtime Behavior](./agents-replace-profiles.md), [BFF Trust Boundary For Privileged POSTs](./bff-trust-boundary.md)

## Decision

The web app selects models model-first: the user picks a **model**, and a
**provider is just a route that serves it**. Most models resolve to a default
route automatically; the user only chooses a provider when a model is
reachable through more than one connected provider.

Three pieces implement this:

1. **A model-major catalog view.** `buildModelCatalog` (`src/model-routes.ts`)
   folds the configured slice of `providerCatalogWithStatus()` into
   `ModelCatalogEntry[]` — canonical model ids, each with its
   `ModelRoute[]` (`{ provider, providerModelId, label, default }`). Exposed
   at `GET /api/providers/models`. A hand-curated alias table maps
   provider-specific ids onto canonical ones (Bedrock cross-region inference
   profiles fold into the Claude ids they serve, with the geo surfaced as a
   route qualifier: "Amazon Bedrock · eu"). Default-route priority is the
   model vendor's own API first (`openai`, `anthropic`, `deepseek`), then
   `codex`, then the metered clouds (`azure`, `bedrock`), then the
   deliberate opt-ins (`openrouter`, `local`).
2. **One shared picker.** `web/src/components/ModelPicker.tsx` renders a
   collapsed trigger showing only the model name — a "· route" suffix
   appears only when the selection rides a non-default route — and an open
   state with a searchable, name-only list. A multi-route model shows its
   default route plus a chevron; hovering the row (or ArrowRight, or tapping
   the chevron — hover is unreachable on keyboard and touch) opens a side
   flyout of its routes with the default tagged. Picking a model name takes
   its default route; picking a route in the flyout takes that exact pair.
   The same component serves the Settings page and the per-agent chat
   Settings tab.
3. **A default-model write path that updates both layers.**
   `setDefaultModel` (`src/runtime/default-model.ts`), exposed at
   `POST /api/settings/default-model` with body `{ provider, model }`,
   writes `RuntimeConfig.provider` via `setSetupProvider` (preserving stored
   transport config on a same-provider save) **and** mirrors the persisted
   pair onto the default agent's override via `setAgentProvider`. The
   default agent is resolved the same way the boot seeding does —
   `agent_default`, or the legacy pre-rename `profile_default` id.

The Settings page's per-provider "active" radio is replaced by a "Default
model" control at the top of the providers area; the provider rows remain
for credential management only (edit transport config, disconnect, add).

## Context

Selection was provider-first: the Settings page staged an "active provider"
radio that wrote `config.provider`, and the per-agent Settings tab picked a
provider row first, then a model from that provider's list. Two problems:

- **The mental model was inverted.** Users think in models ("use
  claude-sonnet-4-6"), and the same model is often reachable through several
  connected providers (first-party Anthropic and Bedrock; gpt-5.5 via Codex
  and Azure). Provider-first UI made the common case (pick a model) two
  decisions deep and hid the equivalence between routes.
- **The "active provider" radio was inert for the default chat.**
  `seedDefaultAgentFromConfig` (`src/state/store.ts`) seeds `agent_default`'s
  override from `config.provider` on boot, and that override wins in
  `resolveEffectiveContext` from then on. Writing only `config.provider`
  (all the radio did) therefore did not change what the default chat — or
  new agents, which copy `agent_default`'s pair at creation — actually used.
  The two-layer write in `setDefaultModel` is what makes "Default model"
  mean what it says.

## Canonical Model Identity

There is no upstream source of truth for "these provider-specific ids are
the same model", so the mapping is a small hand-curated table in
`src/model-routes.ts` — explicit alias entries only, no prefix-stripping
heuristics, so a new catalog id can never silently merge with the wrong
model. Unaliased ids (Nova, Llama, Mistral profiles, `openrouter/auto`)
surface verbatim as their own single-route entries. Adding a catalog model
that exists under another provider means adding its alias entry; the
`model-routes.test.ts` catalog-drift test pins the aliased ids to the real
catalog.

## Read And Write Paths

- The picker's list comes from `GET /api/providers/models` (BFF-proxied like
  every `/api/runtime/*` read; no credentials involved — route labels and
  ids only, see ADR bff-trust-boundary.md).
- **Settings "Default model"** reads `agent_default`'s pair from
  `GET /api/agents` (falling back to the instance provider pre-seed) and
  writes `POST /api/settings/default-model`. Reading `agent_default` — not
  `config.provider` — keeps the display honest: it is what new chats start
  with even when another surface (CLI `gini provider set`, the Edit dialog,
  add-provider) has moved `config.provider` underneath it.
- **Chat Settings tab** reads `/api/status.activeAgent.resolvedProvider` and
  writes the existing `POST /api/agents/:id/provider` contract (ADR
  per-agent-provider-settings.md) with the route pair; "Use default model"
  clears the override. Selection applies immediately on pick — no staged
  save bar.
- Routes are derived only from **configured** providers, so the picker never
  offers a route the next turn can't authenticate. Azure's configured-gate
  (active instance provider only) means a cross-provider Azure override
  still can't be picked, same as before.
- An off-catalog selection (custom Bedrock/local id set elsewhere) renders
  on the trigger as `model · provider`; entering new custom ids stays in the
  provider Edit dialog.

## Consequences

- "Default model" now actually changes the default chat and what new agents
  inherit; previously only a per-agent save did.
- `config.provider` remains the transport/credential anchor: embeddings and
  the reranker keep reading it (ADR agents-replace-profiles.md), the Edit
  provider dialog still writes its model field as the instance fallback, and
  removal of the provider backing it stays blocked in the UI.
- Other agents' overrides are copies, not links — changing the default model
  does not rewrite agents that already carry a pair. Their chat Settings tab
  shows their own selection.
- Two routes can share a provider (Bedrock geo profiles); a route label is
  therefore provider label + qualifier, and the picker treats the pair
  `(provider, providerModelId)` — not the provider name — as the selection
  unit.
- The CLI `gini provider set` still writes only `config.provider`; aligning
  it with the two-layer default-model write is future work.

## Acceptance Checks

- `GET /api/providers/models` returns only configured providers' routes;
  with Bedrock connected, the Claude geo profiles fold into canonical
  entries with geo-qualified Bedrock routes.
- `POST /api/settings/default-model { provider, model }` updates
  `config.provider` (persisted) AND `agent_default.providerName/model`; a
  rejected provider save (missing key, unsupported name) leaves the agent
  untouched.
- Settings shows the Default model trigger with the model name only when on
  the default route; picking a model via the flyout's non-default route
  appends "· route" to the trigger.
- In the chat Settings tab, picking a model + non-default route persists the
  exact pair on the agent and the next chat turn dispatches through it.
- The picker is operable by keyboard (arrows + ArrowRight into the flyout +
  Enter) and by tap (chevron button opens the flyout).
- `bun run typecheck`, `bun run test`, and `bun run gini smoke` are green.

## Critical Files

- `src/model-routes.ts` — model-major catalog fold, alias table, route
  priority.
- `src/runtime/default-model.ts` — two-layer default-model write.
- `src/http.ts` — `GET /api/providers/models`,
  `POST /api/settings/default-model`.
- `src/types.ts` — `ModelRoute`, `ModelCatalogEntry`.
- `web/src/components/ModelPicker.tsx` — the shared picker (trigger, search
  list, route flyout).
- `web/src/app/settings/_components/DefaultModelControl.tsx` — Settings
  "Default model" control.
- `web/src/app/settings/_components/ProviderCard.tsx` — provider rows,
  credential management only.
- `web/src/components/chat/SettingsTab.tsx` — per-agent picker surface.
