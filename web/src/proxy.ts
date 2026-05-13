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

import { NextResponse, type NextRequest } from "next/server";
import { runtimeToken, runtimeUrl } from "@/lib/runtime";

// Cache the status answer briefly so /api/runtime/* proxying isn't
// followed by a separate roundtrip on every navigation. 2s matches the
// runtime.ts file cache so the BFF and proxy stay in step.
let cachedAt = 0;
let cachedConfigured: boolean | null = null;
const cacheTtlMs = 2000;

async function isProviderConfigured(): Promise<boolean | null> {
  const now = Date.now();
  if (cachedConfigured !== null && now - cachedAt < cacheTtlMs) {
    return cachedConfigured;
  }
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
    const configured = data.providerConfigured === true;
    cachedAt = now;
    cachedConfigured = configured;
    return configured;
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
