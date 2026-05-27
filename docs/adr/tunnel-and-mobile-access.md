# ADR: Tunnel + mobile access via Cloudflare quick tunnel

## Decision

The runtime exposes a public surface for mobile / off-LAN clients through a
single Cloudflare quick tunnel managed by the gateway. Authorization is
provided by a per-instance 192-bit secret embedded in the bootstrap URL and
exchanged for a host-only `gini_tunnel_session` cookie on the first hit.
The Next.js proxy is the chokepoint: it classifies inbound `Host`, validates
the secret or cookie in constant time, and stamps an internal marker
(`x-gini-tunnel-vetted: 1`) on requests that pass before the BFF guard sees
them.

The full design contract lives in `PLAN.md`. This ADR captures the
architecture decisions, trust boundary changes, and operational invariants
the contract pins.

## Context

The local-first runtime has historically been loopback-only. Operators who
want their phone to reach the gateway have three options:

1. Tailscale / VPN — works for the operator but requires per-device setup
   and shares the same trust model as direct loopback.
2. Pairing flow — mints device-scoped bearers, but the operator still has
   to be on the LAN to consume the pairing code.
3. A public reverse proxy — moves the trust boundary to the operator's
   infrastructure.

Cloudflare quick tunnels are a fourth, lighter-weight option: a single
managed subprocess (`cloudflared`) bridges the gateway's loopback port to
a rotating `*.trycloudflare.com` URL. The cost is that any code path
reachable from that URL must defend itself against the public internet,
not against same-UID localhost callers.

## Architecture (summary)

```
phone → Cloudflare edge → cloudflared subprocess → Next.js proxy
                                                     │
                                          [Host classifier]
                                          [secret-path bootstrap | cookie]
                                          [stamp vetted=1]
                                                     │
                                                 BFF guard
                                          [canonicalize → deny → CSRF
                                           → rewrite-to-redacted → bearer]
                                                     │
                                               Runtime API
```

Key invariants the proxy enforces per PLAN.md:

- **Host classification**: inbound Host must equal the live tunnel hostname
  (read from the sibling file the runtime writes on enable) or an explicit
  `GINI_TRUSTED_ORIGINS` allowlist entry. Anything else 404s before any
  secret/cookie check — defends against DNS-rebinding to an attacker host.
- **Secret-path bootstrap**: a request to `/<secret>/<rest>` mints a
  `gini_tunnel_session` cookie (HttpOnly, Secure, SameSite=Lax, no Domain,
  Max-Age=86400 — value byte-equals the live secret) and 302-redirects to
  the clean URL with `Referrer-Policy: no-referrer`.
- **Cookie validation**: every subsequent request is constant-time-compared
  against the live secret read from `config.json` (uncached). A
  `rotate-secret` causes outstanding cookies to mismatch on the next hit.
- **Marker un-forgeability**: the proxy strips any inbound
  `x-gini-tunnel-vetted` value BEFORE its branch decisions and only stamps
  the marker on requests that passed the secret/cookie gate. The BFF reads
  the marker only on forwarded headers, never on inbound.
- **Deny list**: tunneled requests to `/api/runtime/pairing/*` (the device
  pairing surface), `/api/runtime/tunnel/<sub>` (QR endpoints, Apple Notes
  refresh — anything that would let a tunnel holder mint device bearers or
  fetch the QR pixels that encode the bootstrap URL), and the bare
  `/api/runtime/tunnel` path with method other than GET are all 404'd at
  the proxy and again at the BFF. Loopback callers bypass the deny list.
- **Rewrite**: bare `GET /api/runtime/tunnel` under `vetted=1` is rewritten
  by the BFF to `/api/tunnel/redacted` on the runtime so the tunneled
  browser receives only `secret: null` / `publicUrl: null`.
- **Operational lifecycle**: `cloudflared` lifetime equals gateway lifetime;
  shutdown stops the subprocess within a 5000 ms SIGKILL cap. Disable
  commits `enabled:false` to config FIRST, then kills cloudflared so the
  proxy's per-request config read closes the cookie-validity window
  immediately. The hostname rotates on every cloudflared restart, so the
  host-only cookie self-invalidates after a gateway restart.
- **Log redaction**: every server-side emission path is scrubbed through a
  `redact()` helper that knows the live secret, prior secrets within the
  rotation window, the live publicUrl, and the trycloudflare.com suffix.
  The Next.js child's stdout is teed through the same redactor before the
  CLI writes `web.log`.

## Trust radius

| Holder | Authority | Rotation |
|---|---|---|
| URL holder (knows `/<secret>/`) | full operator access MINUS deny list | `rotate-secret` or hostname rotation on restart |
| Session-cookie holder | same as URL holder | same |
| Tunnel-vetted browser JS | full operator access MINUS deny list; receives redacted snapshot shape only | same |
| Paired-device bearer | full operator access | device revoke |
| Loopback bearer | full operator access | config edit |

The QR-pixel-decoding leak ("anyone with an over-shoulder photo of the QR
can claim the tunnel") is accepted as in-scope for the local-first
single-operator pattern. The same-UID-local-process threat is out of scope
(`config.json` is mode 0600 and the runtime bearer lives there anyway).

## Consequences

- The BFF guard relaxes its loopback-Host requirement on Origin-less GETs
  when the marker is stamped. See `bff-trust-boundary.md` for the full
  interaction.
- Apple Notes mirror is an opt-in trust-radius extension: the iCloud note
  body intentionally carries the bootstrap URL, so enabling it extends the
  secret's trust radius to iCloud sync. Defaults OFF.
- SSE buffers fully on Cloudflare quick tunnels — live activity / chat
  streaming over the public URL is not real-time. Polling covers it.
- Cloudflare's free quick tunnels reject beyond 200 simultaneous in-flight
  requests with a 429. Gini surfaces the 429 to the client without retry.

## Alternatives considered

- **Named tunnel (paid Cloudflare account).** Removes the SSE-buffering and
  hostname-rotation pain but requires the operator to maintain a Cloudflare
  account and bind a stable hostname. The quick tunnel keeps the local-first
  story intact.
- **Reverse proxy on a stable hostname (`GINI_TRUSTED_ORIGINS` lane).**
  Already supported; orthogonal to the tunnel. Operators who run their own
  front can ignore the tunnel entirely.
- **A bearer-only public surface (no cookie).** Would require the secret in
  every URL, which leaks via Referer and browser history. The cookie-mint +
  302-to-clean-URL design avoids both.

## Acceptance Checks

PLAN.md "Test surface" enumerates the per-invariant observable checks. The
short version:

- Tunnel-branch requests with no secret-prefix and no cookie return 404.
- Tunnel-branch with the secret-prefix returns 302 + Set-Cookie + a clean
  URL; subsequent requests with the cookie pass and are stamped vetted=1.
- Disable causes the next cookie-bearing request to 404, independent of the
  cloudflared-termination window.
- Rotation invalidates outstanding cookies on the next hit.
- Tunneled GET `/api/runtime/tunnel` returns the redacted snapshot.
- Tunneled requests to `/api/runtime/pairing/*` and
  `/api/runtime/tunnel/<sub>` return the deny status (404).
- Loopback callers of the same routes pass.
- The marker is stripped from any inbound request before branch decisions
  and is never forwarded to the runtime.
- Log files under `~/.gini/instances/<inst>/logs/` contain no occurrence of
  the live secret value (or the prior secret within the rotation window)
  after a request that included the secret in the path.
