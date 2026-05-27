// Next.js Proxy. Runs at the network boundary for every request not excluded
// by the matcher below. Two responsibilities, in order:
//
// 1. Tunnel proxy. Classify Host, gate on the secret-path bootstrap or the
//    session cookie, stamp the `x-gini-tunnel-vetted: 1` marker on tunnel-
//    branch forwards, and 404 anything else. Loopback callers (operator's
//    own Mac) pass through without the marker. See PLAN.md "Architecture"
//    + "Tunnel session cookie".
//
// 2. Setup gate. If no provider is configured the operator is bounced to
//    /setup so the rest of the app doesn't render in a broken state.
//
// The proxy reads `tunnel.secret` + `tunnel.enabled` from config.json on
// every request (uncached) — a `rotate-secret` causes every outstanding
// cookie to mismatch on the very next request, and a `disable` 404s the
// next request even with a valid cookie.

import { NextResponse, type NextRequest } from "next/server";
import { runtimeToken, runtimeUrl } from "@/lib/runtime";
import { canonicalizePath, noTrailingSlash } from "@/lib/canonicalize";
import {
  TUNNEL_MARKER_HEADER,
  TUNNEL_MARKER_VALUE,
  TUNNEL_COOKIE_NAME,
  TUNNEL_COOKIE_MAX_AGE_SECONDS,
  buildTunnelCookie,
  isTunnelDenied,
  matchSecretPrefix,
  readTunnelConfigFromDisk,
  readTunnelCookie,
  tunnelSecretEquals,
  withoutTrailingSlash
} from "@/lib/tunnel-policy";

const PROXY_STATUS_TIMEOUT_MS = 1500;

void TUNNEL_COOKIE_NAME;
void TUNNEL_COOKIE_MAX_AGE_SECONDS;

async function isProviderConfigured(): Promise<boolean | null> {
  const url = `${runtimeUrl()}/api/setup/status`;
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${runtimeToken()}` },
      signal: AbortSignal.timeout(PROXY_STATUS_TIMEOUT_MS)
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { providerConfigured?: unknown };
    return data.providerConfigured === true;
  } catch {
    return null;
  }
}

function classifyHost(hostHeader: string | null): "loopback" | "tunnel-or-trusted" | "unknown" {
  if (!hostHeader) return "unknown";
  const lower = hostHeader.toLowerCase();
  const hostOnly = lower.includes("]")
    ? lower.slice(0, lower.lastIndexOf("]") + 1)
    : lower.includes(":") ? lower.slice(0, lower.indexOf(":")) : lower;
  if (hostOnly === "localhost" || hostOnly === "127.0.0.1" || hostOnly === "[::1]") {
    return "loopback";
  }
  // PLAN.md "Host classifier": match live tunnel hostname OR a
  // GINI_TRUSTED_ORIGINS entry. We can't currently see the live tunnel
  // hostname from the proxy without an extra round-trip (the runtime
  // snapshot lives in another process), so we trust the allowlist plus a
  // structural match on the trycloudflare suffix. Operators with a stable
  // hostname use GINI_TRUSTED_ORIGINS; rotating-tunnel hostnames fall under
  // the structural match.
  if (hostOnly.endsWith(".trycloudflare.com")) return "tunnel-or-trusted";
  const allowlist = (process.env.GINI_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const entry of allowlist) {
    try {
      const url = new URL(entry);
      const entryHost = url.host.toLowerCase();
      if (entryHost === lower) return "tunnel-or-trusted";
      // Default-port equivalence (per PLAN.md CSRF section).
      if (!url.port && (lower === `${entryHost}:443` || lower === `${entryHost}:80`)) {
        return "tunnel-or-trusted";
      }
    } catch {
      // Skip malformed entries.
    }
  }
  return "unknown";
}

function notFound(): NextResponse {
  return new NextResponse("Not found", { status: 404 });
}

function stampVettedHeaders(headers: Headers): Headers {
  const cloned = new Headers(headers);
  cloned.delete(TUNNEL_MARKER_HEADER);
  cloned.set(TUNNEL_MARKER_HEADER, TUNNEL_MARKER_VALUE);
  return cloned;
}

function stripVettedHeaders(headers: Headers): Headers {
  const cloned = new Headers(headers);
  cloned.delete(TUNNEL_MARKER_HEADER);
  return cloned;
}

function applyResponsePolicy(res: NextResponse): NextResponse {
  // Outbound clicks send only the origin, never the path with the secret.
  res.headers.set("referrer-policy", "strict-origin");
  return res;
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const url = request.nextUrl.clone();
  const hostHeader = request.headers.get("host");
  const classification = classifyHost(hostHeader);
  const tunnel = readTunnelConfigFromDisk();
  const canon = canonicalizePath(url.pathname);

  // -------- LOOPBACK BRANCH --------
  if (classification === "loopback") {
    // Strip any inbound marker before forwarding — same-UID co-tenants cannot
    // forge it through a loopback caller.
    const headers = stripVettedHeaders(request.headers);
    const next = NextResponse.next({ request: { headers } });
    // Setup gate runs ONLY on loopback. A tunneled phone hitting / should not
    // be redirected to /setup since /setup is a localhost-only experience.
    const { pathname } = url;
    if (!pathname.startsWith("/setup") && !pathname.startsWith("/api/") && !pathname.startsWith("/connect")) {
      const configured = await isProviderConfigured();
      if (configured === false) {
        const setupUrl = new URL("/setup", request.url);
        return applyResponsePolicy(NextResponse.redirect(setupUrl));
      }
    }
    return applyResponsePolicy(next);
  }

  if (classification === "unknown") {
    return notFound();
  }

  // -------- TUNNEL BRANCH --------
  // canon errors land here as a 4xx before any secret/cookie check.
  if (!canon.ok) {
    return new NextResponse("Bad request", { status: 400 });
  }
  if (!tunnel.enabled) return notFound();

  // Try secret-path bootstrap: /<secret>/...
  const segments = canon.path.split("/").filter((s) => s.length > 0);
  if (segments.length >= 1) {
    const candidate = segments[0]!;
    if (tunnelSecretEquals(candidate, tunnel.secret)) {
      // Compose the post-prefix canonical path for deny matching.
      const rest = canon.path.slice(`/${candidate}`.length);
      const postPrefix = rest.length === 0 ? "/" : rest;
      if (isTunnelDenied(postPrefix, request.method)) {
        return notFound();
      }
      const target = new URL(request.url);
      target.pathname = postPrefix === "" ? "/" : postPrefix;
      const redirect = NextResponse.redirect(target, 302);
      redirect.headers.set("set-cookie", buildTunnelCookie(tunnel.secret));
      // The 302 itself carries no-referrer so the brief /<secret>/ URL
      // cannot leak via Referer on subresource fetches the destination
      // page issues. See PLAN.md "URL cleanup after bootstrap".
      redirect.headers.set("referrer-policy", "no-referrer");
      return redirect;
    }
  }

  // Cookie-bearing follow-up requests.
  const cookieValue = readTunnelCookie(request.headers);
  if (cookieValue && tunnelSecretEquals(cookieValue, tunnel.secret)) {
    if (isTunnelDenied(canon.path, request.method)) {
      return notFound();
    }
    const headers = stampVettedHeaders(request.headers);
    const next = NextResponse.next({ request: { headers } });
    return applyResponsePolicy(next);
  }

  // No bootstrap, no cookie — 404 (do NOT reveal the existence of the
  // gateway via a richer error).
  void noTrailingSlash;
  void withoutTrailingSlash;
  return notFound();
}

export const config = {
  // Exclude Next.js static assets — the proxy runs at request time and
  // re-running for every /_next/static asset would be wasteful. The match
  // intentionally covers `/api/*` so the tunnel proxy gates BFF calls too.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
