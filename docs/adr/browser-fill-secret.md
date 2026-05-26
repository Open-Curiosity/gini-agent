# ADR: Browser Fill-Secret Tool

## Decision

Gini gives the agent an inline-in-chat tool, `browser_fill_secrets`, that asks the user to supply one or more values which the gateway fills directly into named locators on the agent's browser tab via playwright. Values flow `user keyboard → chat UI → BFF → gateway → playwright → DOM` and are never persisted, never written to audit/trace payloads, and never reach the LLM. The tool reuses the existing `connector.request` approval substrate — same `POST /api/approvals/<id>/connect` endpoint, same `{ secrets: Record<string, string> }` body shape, same inline chat card UX written by Shelden in `BlockApprovalRequested.tsx` — distinguished only by the approval's `action` field.

## Context

The agent's browser tool drives a Chromium instance via playwright. Many real workflows hit a login wall (GitHub, banking, internal SSO) where credentials must be supplied. The agent cannot type the credentials itself — and even if it could, the LLM context, transcripts, traces, and audit rows would all leak the secret. The user needs a way to supply the value directly into the right DOM field, inline in the same chat where the agent is working, so the agent can immediately re-snapshot the page and decide what to do next (including asking for another value if there are more fields to fill).

Two earlier explorations were abandoned:

1. A full co-browsing handoff (live CDP screencast + WebSocket input relay) — overbuilt for a workflow that only needs typed-text delivery into one DOM field at a time.
2. A parallel `POST /api/approvals/<id>/value` endpoint with its own in-process value queue — duplicated infrastructure that the existing `/connect` substrate already provides. Same multi-input pattern, same bearer-injection BFF, same inline chat card — just with a slight payload variant.

The right substrate is the one Shelden already built for `connector.request`. The card lives in chat (`BlockApprovalRequested.tsx`), Submit POSTs `{ secrets: Record<string, string> }` to `POST /api/approvals/<id>/connect`, the gateway's bearer is injected server-side by the BFF, and the runtime has full control over what the secrets are used for. For `connector.request`, the secrets are encrypted to a connector record. For our use case, they are passed straight to `page.locator(...).fill(...)` and discarded the moment the request returns.

## Required Now

- `Approval.action` gains `"browser.fill_secret"`.
- The `POST /api/approvals/<id>/connect` handler branches on `approval.action`:
  - `"connector.request"` keeps its existing behavior (`createConnector`, `writeSecret`, `checkConnector`, resolve approval).
  - `"browser.fill_secret"` reads the same `secrets` field from the request body, looks up each key as a named slot in `approval.payload.slots` (each slot carries `{ name, locator, label, kind? }`), calls `browserFillByLocator(taskId, { locator: slot.locator, value })` per slot, writes one redacted audit row (`redacted: true`, `evidence: { filledSlots, errors }`), resolves the approval atomically BEFORE the fill loop via `resolveApproval(resumeChatTask: false)` to close the deny-mid-fill race, then calls `resumeChatTask` manually with a result string reflecting the actual filled/errored outcome. No `createConnector`, no `writeSecret`, no persistence of any kind. The slot values exist only inside the handler's request-scope local variables.
- A new agent tool `browser_fill_secrets` (always-on, same gating tier as `request_connector`):
  - Tool catalog descriptor: parameters `{ slots: Array<{ name, locator, label, kind? }>, reason: string }`.
  - Tool function mints an approval with `action: "browser.fill_secret"`, payload `{ slots, reason, toolCallId }`. Returns `{ kind: "pending", approvalId }`.
  - The chat-task loop already emits an `approval_requested` block for any pending approval (`chat-task.ts:1098-1110`); no new emission seam needed.
- A new branch in `BlockApprovalRequested.tsx` for `action === "browser.fill_secret"`:
  - Renders one HTML input per slot from `payload.slots`, with `type` set from `slot.kind` (`text` | `password` | `email` | `tel` | `number` | `url`, defaulting to `text`).
  - Password-manager attributes (`autoComplete="off"`, `data-1p-ignore`, `data-lpignore`, `data-form-type="other"`) to suppress autofill.
  - Submit POSTs `{ secrets: Record<slot.name, value> }` to `/approvals/<id>/connect` via the existing `connect` mutation path.
  - Clears local state on success so the secret never lingers in React state past the click.
- All audit rows for the fill action use `redacted: true` so the writer drops the evidence column at the boundary.

## Surface Restriction

The amber approval card is web-only React UI rendered on the Next.js BFF. The messaging bridge mirrors in `src/integrations/telegram-poller.ts` and `src/integrations/discord-poller.ts` gate their reply dispatch on `isTerminalTaskStatus(...)` and log `messaging.{telegram,discord}.reply_skip_non_terminal` when the task is parked in `awaiting_approval`. If the tool were allowed to mint an approval while the conversation was originating from Telegram or Discord, the task would park, the mirror would skip, and the messaging-surface user would see a typing indicator that eventually stops — no card, no error, no path to submit.

The dispatch surface guard (`browserFillSecretsTool` in `src/execution/tool-dispatch.ts`) refuses the tool synchronously when the owning chat session has `source.kind === "telegram"` or `"discord"`, returning a structured `{ ok: false, error }` envelope. The agent receives a normal `tool_result` block, the chat-task loop continues to completion, and the agent's assistant text reply ("open the web chat to enter credentials") IS something the messaging mirrors relay back once the task settles. The tool stays visible in the catalog (it isn't hidden per surface) so the agent's reasoning surface is unchanged; only the side-effecting path errors.

## Deferred

- A separate dialog (modal) variant — the inline card is enough for the foreseeable workflow.
- File-upload variants — `browser.upload_file` already handles that surface.
- Multi-page workflows where the agent needs to chain several fills — already covered because the agent can call the tool repeatedly, each call gets its own approval card in chat, and the agent re-snapshots between calls to learn the post-fill DOM state.
- Rendering the credential request *into* Telegram or Discord directly. The blocker is format compatibility — neither bridge has a structured-input affordance equivalent to the amber card, and posting raw credentials through a messaging channel would route them through the bridge provider and the LLM. A future deep-link-back-to-web flow ("open https://gini/chat/<session-id> to enter credentials") could close the UX gap without changing the trust boundary.

## Consequences For Coding Agents

- Sensitive values flow through this tool — they never appear in the agent's tool arguments or tool results. The tool DESCRIBES which fields need filling (locator + label per slot), not what to fill them with.
- The `redacted: true` flag on audit rows is non-negotiable for `browser.fill_secret` — tests must assert that submitted values do not appear in `state.json`, `runtime.jsonl`, or the task's trace JSONL.
- The gateway's `/api/approvals/<id>/connect` handler is now a two-action seam. New fill-style actions added later (e.g. `browser.fill_otp` with a TTL-bound code) follow the same pattern: extend `Approval.action`, add a branch, share the same body shape and BFF route.
- BFF code never sees the bearer token; the existing `/connect` BFF proxy already injects it server-side.

## Acceptance Checks

- Calling `browser_fill_secrets({ slots: [{ name: "username", locator: "input[name=\"username\"]", label: "Username" }, { name: "password", locator: "input[name=\"password\"]", label: "Password", kind: "password" }], reason: "Sign in to the test site" })` creates one pending approval with `action: "browser.fill_secret"` and the agent loop pauses on `waiting_approval`.
- The chat UI renders one card with two input fields. The password field is `type="password"`.
- `POST /api/approvals/<id>/connect` with `{ secrets: { username: "tomsmith", password: "SuperSecretPassword!" } }` fills both DOM fields via `browserType`, writes one redacted audit row with `action: "browser.fill_secret"`, and resolves the approval.
- The on-disk `state.json` and the task's trace JSONL never contain `"tomsmith"` or `"SuperSecretPassword!"` byte sequences.
- Submitting the same approval twice returns `410 Gone`.
- Denying the approval via `POST /api/approvals/<id>/deny` returns the task to the agent loop with a denial tool result and never touches the browser.
- Calling `browser_fill_secrets` from a task whose chat session originates from Telegram or Discord (`session.source.kind === "telegram" | "discord"`) returns a synchronous `{ ok: false, error }` envelope from `dispatchToolCall` without creating any approval row, so the messaging mirror reaches `terminal` and relays the agent's plain-text fallback reply.
