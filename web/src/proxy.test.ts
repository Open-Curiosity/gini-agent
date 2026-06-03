// Proxy unit tests. Exercise the Host-classifier lanes (loopback / trusted /
// unknown) and the loopback-only setup gate by driving proxy() with a
// synthetic NextRequest.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

const originalTrusted = process.env.GINI_TRUSTED_ORIGINS;
const originalRelayDomain = process.env.GINI_RELAY_DOMAIN;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  delete process.env.GINI_TRUSTED_ORIGINS;
  // Force the default relay domain so the literal *.gini-relay.lilaclabs.ai
  // expectations hold regardless of any GINI_RELAY_DOMAIN set in the CI/dev env.
  delete process.env.GINI_RELAY_DOMAIN;
});

afterEach(() => {
  if (originalTrusted === undefined) delete process.env.GINI_TRUSTED_ORIGINS;
  else process.env.GINI_TRUSTED_ORIGINS = originalTrusted;
  if (originalRelayDomain === undefined) delete process.env.GINI_RELAY_DOMAIN;
  else process.env.GINI_RELAY_DOMAIN = originalRelayDomain;
  globalThis.fetch = originalFetch;
});

function makeRequest(opts: { url: string; host: string; method?: string }): NextRequest {
  return new NextRequest(opts.url, {
    method: opts.method ?? "GET",
    headers: { host: opts.host }
  });
}

// Stub the provider-status probe the loopback setup gate calls.
function stubSetupStatus(providerConfigured: boolean): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ providerConfigured }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as unknown as typeof fetch;
}

function failIfFetched(reason: string): void {
  globalThis.fetch = (async () => {
    throw new Error(reason);
  }) as unknown as typeof fetch;
}

describe("proxy Host classifier", () => {
  test("unknown Host → 404", async () => {
    const res = await proxy(makeRequest({ url: "https://evil.example/", host: "evil.example" }));
    expect(res.status).toBe(404);
  });

  test("trusted Host (GINI_TRUSTED_ORIGINS) passes through without the setup gate", async () => {
    process.env.GINI_TRUSTED_ORIGINS = "https://gini.example";
    // A trusted-lane request must NOT hit the loopback-only setup probe.
    failIfFetched("setup status must not be probed on the trusted lane");
    const res = await proxy(makeRequest({ url: "https://gini.example/chat", host: "gini.example" }));
    expect(res.status).toBe(200);
  });
});

describe("proxy loopback setup gate", () => {
  test("loopback + /api/* skips the setup gate", async () => {
    failIfFetched("setup status must not be probed for /api/* paths");
    const res = await proxy(makeRequest({ url: "http://localhost/api/runtime/chat", host: "localhost" }));
    expect(res.status).toBe(200);
  });

  test("loopback + /setup is not redirected (avoids a redirect loop)", async () => {
    stubSetupStatus(false);
    const res = await proxy(makeRequest({ url: "http://localhost/setup", host: "localhost" }));
    expect(res.status).toBe(200);
  });

  test("loopback + unconfigured provider → redirect to /setup", async () => {
    stubSetupStatus(false);
    const res = await proxy(makeRequest({ url: "http://localhost/chat", host: "localhost" }));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toContain("/setup");
  });

  test("loopback + configured provider → pass (no redirect)", async () => {
    stubSetupStatus(true);
    const res = await proxy(makeRequest({ url: "http://localhost/chat", host: "localhost" }));
    expect(res.status).toBe(200);
  });
});
