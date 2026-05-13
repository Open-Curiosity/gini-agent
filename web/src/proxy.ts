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

async function isProviderConfigured(): Promise<boolean | null> {
  const url = `${runtimeUrl()}/api/setup/status`;
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${runtimeToken()}` },
      signal: AbortSignal.timeout(1500)
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

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  // Public surfaces that must not be gated:
  //   - /setup itself (otherwise infinite redirect)
  //   - All /api/* (BFF must always be reachable for the /setup page to
  //     hit /api/runtime/setup/status and /api/runtime/setup/provider)
  //   - Next.js internals (_next/, favicon, etc.) — covered by the matcher
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
  // Exclude API routes (the BFF), Next.js static + image assets, and the
  // favicon — proxy runs at request time and re-running it for every
  // _next/static asset would be wasteful. We DO match the bare root path
  // and any app route so the gating works end-to-end.
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico).*)"
  ]
};
