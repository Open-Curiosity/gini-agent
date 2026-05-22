// Next.js Proxy (renamed from middleware). Runs before each request and
// gates everything except /setup and the API surface on the provider
// being configured. If the gateway reports providerConfigured:false the
// user is bounced to /setup so they can pick a provider before doing
// anything else.
//
// We hit the runtime directly through the BFF helpers (env override
// falls back to ~/.gini/instances/<inst>/runtime.port + config.json),
// the same source of truth the rest of the BFF reads from. Failures
// (gateway down, network glitch) let the request through — we'd rather
// show a degraded UI than a redirect loop when the runtime is the
// problem.
//
// No cache on the status answer. A previous version cached the result
// for 2s, but that caused a race: when /setup POSTs a successful
// provider, the page calls router.replace('/') *immediately* —
// within the cache window. The proxy on `/` would then read stale
// `providerConfigured:false` and bounce the user back to /setup. The
// cost of always hitting the gateway is one sub-millisecond local
// HTTP call per gated request — cheap, because the runtime is on the
// same machine and the call hits a tiny in-memory check
// (providerHealth + config). The matcher already excludes
// /_next/static and /_next/image so static asset loading is unaffected.

import { NextResponse, type NextRequest } from "next/server";
import { runtimeToken, runtimeUrl } from "@/lib/runtime";

// Upper bound on the round-trip to the local gateway's /api/setup/status.
// The gateway is on 127.0.0.1 and the call hits a tiny in-memory check, so
// the typical latency is sub-ms. We're guarding against a hung gateway —
// don't make the user wait long when the runtime is genuinely down.
const PROXY_STATUS_TIMEOUT_MS = 1500;

async function isProviderConfigured(): Promise<boolean | null> {
  const url = `${runtimeUrl()}/api/setup/status`;
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${runtimeToken()}` },
      signal: AbortSignal.timeout(PROXY_STATUS_TIMEOUT_MS)
    });
    if (!response.ok) {
      // 401 / 5xx — let the request through so the page can surface
      // the real error rather than redirecting in a loop.
      return null;
    }
    const data = await response.json() as { providerConfigured?: unknown };
    return data.providerConfigured === true;
  } catch {
    // Network error / gateway down — same logic as 5xx: don't redirect.
    return null;
  }
}

// Per-instance tunnel secret. Injected by the runtime when it spawns the
// Next.js child (see src/cli/process.ts `GINI_TUNNEL_SECRET`). Empty
// string when the feature is not configured; in that case the
// secret-path strip is skipped entirely and external requests are
// 404'd.
const TUNNEL_SECRET = process.env.GINI_TUNNEL_SECRET ?? "";

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const host = request.headers.get("host") ?? "";
  const isLocalHost = host.startsWith("localhost") || host.startsWith("127.0.0.1");
  const { pathname } = request.nextUrl;

  if (!isLocalHost) {
    // External host (cloudflared): every request must carry the secret
    // prefix, including API calls. Previously the matcher excluded
    // `/api/*`, which meant anyone who knew the trycloudflare hostname
    // could reach `/api/runtime/state`, `/tasks`, `/memory`, etc. — the
    // BFF would forward to the runtime with the operator's bearer token
    // injected server-side. Now the proxy runs for every path (the
    // matcher gates only on `_next/static`, `_next/image`, and
    // `favicon.ico`), and tunneled requests without the secret prefix
    // 404 here before any auth-bearing BFF route is reached.
    if (!TUNNEL_SECRET) return new NextResponse("Not Found", { status: 404 });
    const prefix = `/${TUNNEL_SECRET}`;
    // Bare `/<secret>` (no trailing slash) — Next 16 normalizes away the
    // trailing slash on outbound URLs, which turned a previous
    // `redirect("/<secret>/")` into a 308 that pointed back to
    // `/<secret>` and locked the browser in a redirect loop.
    // Treat the bare form as an unmatched path; clients (including the
    // QR-encoded URL) always include the trailing slash so this only
    // affects hand-typed inputs, where a clean 404 beats a broken loop.
    if (!pathname.startsWith(`${prefix}/`)) {
      return new NextResponse("Not Found", { status: 404 });
    }
    const stripped = pathname.slice(prefix.length) || "/";
    // After strip: API calls go straight through with the secret-stripped
    // path so the BFF routes match. Page navigations rewrite to the
    // un-prefixed app-router path and continue through the setup gate.
    if (stripped.startsWith("/api/")) {
      const rewritten = request.nextUrl.clone();
      rewritten.pathname = stripped;
      return NextResponse.rewrite(rewritten);
    }
    // Page request: rewrite and then run the same setup gate localhost
    // requests use, so a tunneled `/setup` flow still works.
    if (stripped.startsWith("/setup")) {
      const rewritten = request.nextUrl.clone();
      rewritten.pathname = stripped;
      return NextResponse.rewrite(rewritten);
    }
    const configured = await isProviderConfigured();
    if (configured === false) {
      const setupUrl = new URL(`${prefix}/setup`, request.url);
      return NextResponse.redirect(setupUrl);
    }
    const rewritten = request.nextUrl.clone();
    rewritten.pathname = stripped;
    return NextResponse.rewrite(rewritten);
  }

  // Localhost: existing setup gate.
  if (pathname.startsWith("/setup") || pathname.startsWith("/api/")) {
    return NextResponse.next();
  }
  const configured = await isProviderConfigured();
  if (configured === false) {
    const setupUrl = new URL("/setup", request.url);
    return NextResponse.redirect(setupUrl);
  }
  return NextResponse.next();
}

export const config = {
  // Match everything except Next.js static assets and the favicon. API
  // routes are NOT excluded — they need to go through the secret-path
  // gate when arriving via the cloudflared tunnel, otherwise the BFF's
  // bearer-token-injecting proxy hands authenticated access to anyone
  // who knows the trycloudflare hostname.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)"
  ]
};
