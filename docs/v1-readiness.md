# Gini V1 Readiness

This document maps the V1 plan to the current Gini runtime surfaces. V1 is scoped to the local runtime, CLI, local web control plane, stable contracts, and Hermes-equivalent runtime primitives. The iOS/Expo app, paired-device mobile UX, remote relay, and push delivery are V2 work.

## Verification

Run:

```sh
bun run typecheck
bun test
bun run gini smoke
```

The smoke output must include:

- `parityOk: true`
- `readinessOk: true`
- an `evidencePath`

For an installed lane, use:

```sh
bun run gini parity hermes
bun run gini readiness v1
bun run gini evidence
```

## Hermes-Equivalent Workflows

| Capability | Gini V1 surface |
| --- | --- |
| CLI task workflow | `gini task submit/list/show/retry/cancel` |
| Local chat/session history | `gini chat new/send/sync/show/list`, `/api/chat` |
| Persistent memory | `gini memory list/add/edit/approve/reject/archive`, `/api/memory` |
| Skills/procedures | `gini skills list/add/show/search/validate/test/trust/disable/rollback`, `/api/skills` |
| Session search | `gini search <query>`, `/api/search` with task/trace/memory/skill/audit citations |
| Jobs/cron | `gini jobs list/add/run/pause/resume/remove/runs/replay`, prompt and script jobs |
| File tools | task inputs: `read`, `list`, `find`, `write`, `patch` |
| Terminal/code tools | task inputs: `shell`, `code js|python :: ...`, approval gated |
| Toolsets/gating | `gini toolsets list/enable/disable`, `/api/toolsets` |
| Provider abstraction | `gini provider show/catalog/set`, Codex OAuth, OpenAI, OpenRouter, local-compatible paths |
| Delegation/subagents | `gini subagents list/spawn`, `/api/subagents` |
| MCP/plugin surface | `gini mcp list/add/health/invoke/disable`, selected exposed tools |
| Messaging bridge | `gini messaging list/add/health/receive/send/messages/disable`, inbound messages create tasks |
| Profiles/config equivalent | `gini profiles list/create/use`, lane-aware config |
| Import/migration basics | `gini import inspect hermes|openclaw <path>`, read-only by default |
| Runtime self-improvement | `gini improvements propose/approve/reject`, trace-backed application |
| Observability | `gini trace`, `gini audit`, `gini events`, `/api/events/stream`, `gini evidence` |
| Local web control plane | `gini start`, then open the printed localhost URL |

## V1/V2 Boundary

V1 intentionally does not build the iOS/Expo app or production remote relay. It stabilizes the runtime contracts those clients consume:

- `/api/state`
- `/api/mobile/bootstrap`
- `/api/events`
- `/api/events/stream`
- `/api/tasks`
- `/api/chat`
- `/api/approvals`
- `/api/memory`
- `/api/skills`
- `/api/jobs`
- `/api/messaging`
- `/api/parity/hermes`
- `/api/readiness/v1`

V2 starts from this runtime foundation and adds the native mobile app, paired-device auth as product UX, remote relay/push, stronger production/sandbox promotion, and deeper long-running operational hardening.
