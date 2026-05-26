// Shared Origin/Host guard for tunnel mutation routes. Both
// `/api/runtime/tunnel` (PATCH) and `/api/runtime/tunnel/refresh-notes`
// (POST) auto-inject the runtime bearer, so a co-tenant process on
// localhost could otherwise drive osascript or flip the tunnel without
// the operator's consent. SameSite=Lax stops cross-site BROWSER POSTs,
// but not a same-host process. Requiring the request's Origin (or
// Referer fallback) to match its Host header closes that surface: the
// Settings card and any mobile browser hitting the tunnel both send
// same-origin Origin, while a hostile localhost service has no
// browser-set Origin and is rejected.
//
// Centralising the helper means a future tweak (e.g. allowing a
// configured allow-list of external origins) applies uniformly to
// every tunnel-mutation endpoint instead of drifting between copies.
//
// `GINI_TRUSTED_ORIGINS` precedence mirrors the BFF catch-all's
// `guardCsrf` (web/src/lib/runtime.ts). When the operator configures
// an allowlist, that allowlist is authoritative: the Origin must be
// in it, and the Host-equality fallback is skipped entirely. Without
// this precedence, an operator who configured a strict allowlist
// would still be DNS-rebindable on these dedicated routes because
// the rebound page legitimately sends Origin == Host == attacker
// hostname. The catch-all handles this correctly; these dedicated
// routes must not be weaker than the catch-all, otherwise the
// "stricter than catch-all" framing is inverted.

import type { NextRequest } from "next/server";
import { trustedOrigins } from "@/lib/runtime";

export function originHostMatchesRequest(request: NextRequest): boolean {
  const originRaw = request.headers.get("origin") ?? request.headers.get("referer");
  if (!originRaw) return false;
  let origin: URL;
  try {
    origin = new URL(originRaw);
  } catch {
    return false;
  }
  // Allowlist takes precedence over Host-equality. A request whose Origin
  // is in `GINI_TRUSTED_ORIGINS` is accepted regardless of Host; a request
  // whose Origin is NOT in the allowlist is rejected even when Origin
  // matches Host (which is the DNS-rebinding shape the allowlist exists to
  // defeat). When the env var is unset (null), fall through to the local-
  // dev Host-equality fallback. When the env var is set but every entry
  // is malformed (empty Set), fail closed to match the catch-all's
  // posture for a typo in a security-critical env var.
  const allowlist = trustedOrigins();
  if (allowlist) {
    const normalized = `${origin.protocol}//${origin.host}`;
    return allowlist.has(normalized);
  }
  const host = request.headers.get("host");
  if (!host) return false;
  // Match host (which can be `name:port`) against the parsed
  // origin's authority (host:port, with port elided when default).
  const originHost = origin.port
    ? `${origin.hostname}:${origin.port}`
    : origin.hostname;
  return originHost === host || origin.host === host;
}
