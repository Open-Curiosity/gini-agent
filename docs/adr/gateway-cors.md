# ADR: Gateway CORS for browser-origin clients

## Decision

The gateway HTTP layer (`src/http.ts`) accepts cross-origin requests
from an operator-configurable allowlist. Allowed origins are read from
`GINI_CORS_ORIGINS` (comma-separated full origins) at request time.
When the env var is unset, the gateway falls back to a built-in
local-dev allowlist:

- `http://localhost:3045` / `http://127.0.0.1:3045` — Next.js web app
- `http://localhost:8081` / `http://127.0.0.1:8081` — Expo dev server
- `http://localhost:8090` / `http://127.0.0.1:8090` — Expo web target

Behavior:

- **Origin matches allowlist** — every response (including 4xx/5xx
  and `text/event-stream`) gets `Access-Control-Allow-Origin: <that
  origin>`, `Access-Control-Allow-Credentials: true`, `Vary: Origin`,
  and `Access-Control-Expose-Headers: Last-Event-ID`.
- **Origin missing** — no CORS headers are added. Non-browser callers
  (CLI, MCP, curl) are unaffected.
- **Origin present but not in allowlist** — no CORS headers are added,
  so the browser blocks the response. The actual GET/POST still runs
  through auth and may return data — but the browser drops it before
  JS sees it.
- **Preflight (`OPTIONS` with `Access-Control-Request-Method`)** —
  short-circuits before auth and returns 204 with
  `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers`
  (`Authorization, Content-Type, X-Device-Token, Last-Event-ID,
  Accept`), and `Access-Control-Max-Age: 600`. Origin-stamping rules
  apply as above.

A single helper (`withCors(request, response)`) wraps every Response
in the request handler so CORS treatment can't drift across routes.

## Context

The mobile workspace has a React Native Web target. When Playwright
or MCP drives the mobile UI through a browser, the page is served by
Expo at `localhost:8090` and tries to call the gateway at
`127.0.0.1:7396`. Native iOS/Android don't enforce CORS, so production
mobile builds were never affected — but browser-based end-to-end
testing of the mobile UI was impossible.

The Next.js BFF doesn't need this either: it calls the gateway
server-side and never carries the gateway bearer in the browser (see
ADR bff-trust-boundary.md). CORS is purely for clients that talk to
the gateway *directly* from a browser origin.

## Security posture

- **Allowlist-only.** No `*` wildcard is supported because we send
  `Access-Control-Allow-Credentials: true`, and browsers reject the
  wildcard-plus-credentials combination outright.
- **Auth is unchanged.** Preflight returns 204 unauthenticated (that
  is how CORS works), but the actual GET/POST/PUT/PATCH/DELETE still
  runs through `authorized()` and still requires a valid bearer.
- **CORS headers on 401/4xx/5xx.** Without them, a denied browser
  request collapses into a generic network error instead of the
  status code the JS expected. Surfacing the status doesn't leak any
  more than the allowlisted origin already gets from a successful
  call.
- **Empty `GINI_CORS_ORIGINS`** (e.g. `GINI_CORS_ORIGINS=`) parses to
  an empty allowlist — every origin is denied. Operators who want to
  disable CORS entirely set the var to an empty string; operators who
  want defaults leave it unset.

## Consequences

- Mobile-on-web (Expo web target) can now hit the gateway directly,
  which unblocks Playwright/MCP-driven mobile testing.
- Operators deploying the gateway behind a non-default browser origin
  must set `GINI_CORS_ORIGINS` explicitly. The defaults are
  loopback-only.
- The Next.js BFF route at `/api/runtime/*` is unaffected: it runs
  server-side, never triggers preflight, and continues to enforce the
  BFF trust boundary independently.

## Acceptance checks

- `bun test src/http.test.ts` covers preflight (allowed/disallowed),
  normal GET, no-Origin pass-through, 401 CORS-stamping, and the env
  var override.
- Live: with the gateway running,
  `curl -i -H "Origin: http://localhost:8090" -H "Access-Control-Request-Method: GET" -X OPTIONS http://127.0.0.1:7396/api/status`
  returns 204 with `Access-Control-Allow-Origin: http://localhost:8090`.
