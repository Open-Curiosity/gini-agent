import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { GET, redactTunnelSnapshot, scrubSecrets, scrubTunnelUrlPattern } from "./route";
import { POST as REFRESH_POST } from "./refresh-notes/route";

describe("BFF tunnel snapshot redaction", () => {
  test("nulls the secret and publicUrl fields before forwarding", () => {
    const snapshot = {
      publicUrl: "https://x.trycloudflare.com/secret-abc-123/",
      cloudflareUrl: "https://x.trycloudflare.com",
      secret: "secret-abc-123",
      targetUrl: "http://127.0.0.1:7778",
      observedAt: "2026-01-01T00:00:00Z",
      appleNotes: { enabled: true, folder: "gini", noteName: "tunnel-url", available: true, lastSyncedAt: null, lastError: null },
      lastError: null
    };
    const out = redactTunnelSnapshot(snapshot) as Record<string, unknown>;
    expect(out.secret).toBeNull();
    expect(out.publicUrl).toBeNull();
    expect(out.cloudflareUrl).toBe("https://x.trycloudflare.com");
    expect((out.appleNotes as Record<string, unknown>).enabled).toBe(true);
  });

  test("returns non-object payloads unchanged", () => {
    expect(redactTunnelSnapshot(null)).toBeNull();
    expect(redactTunnelSnapshot("oops")).toBe("oops");
    expect(redactTunnelSnapshot([1, 2, 3])).toEqual([1, 2, 3]);
  });

  test("does not mutate the input", () => {
    const input = { secret: "abc", publicUrl: "https://x/abc/", cloudflareUrl: "https://x" };
    redactTunnelSnapshot(input);
    expect(input.secret).toBe("abc");
    expect(input.publicUrl).toBe("https://x/abc/");
  });

  test("allow-list drops unrecognized credential-shaped fields", () => {
    // A hypothetical future field that contains an auth-bearing value
    // must not slip through. The allow-list approach drops it entirely.
    const snapshot = {
      secret: "abc",
      publicUrl: "https://x/abc/",
      cloudflareUrl: "https://x",
      hypotheticalNewSignedUrl: "https://x/another-secret-form/"
    };
    const out = redactTunnelSnapshot(snapshot) as Record<string, unknown>;
    expect(out).not.toHaveProperty("hypotheticalNewSignedUrl");
  });
});

describe("scrubSecrets", () => {
  test("replaces every occurrence of each known secret", () => {
    const result = scrubSecrets(
      "Failed to start cloudflared: https://abc.trycloudflare.com/secret-abc-123/ refused",
      ["secret-abc-123", "https://abc.trycloudflare.com/secret-abc-123/", "https://abc.trycloudflare.com"]
    );
    expect(result).not.toContain("secret-abc-123");
    expect(result).not.toContain("abc.trycloudflare.com");
    expect(result).toContain("(secret values redacted)");
  });

  test("is a no-op when no secret substring is present", () => {
    const input = "Something else went wrong.";
    expect(scrubSecrets(input, ["nope", "missing"])).toBe(input);
  });

  test("skips empty / non-string values in the secrets list", () => {
    const result = scrubSecrets("hello world", ["", "world"]);
    expect(result).toContain("hello");
    expect(result).not.toContain("world");
    expect(result).toContain("(secret values redacted)");
  });
});

describe("scrubTunnelUrlPattern", () => {
  test("strips the full publicUrl form including secret path segment", () => {
    const input = "Failed to start cloudflared: https://abc.trycloudflare.com/SECRET123/ unreachable";
    const out = scrubTunnelUrlPattern(input);
    expect(out).not.toContain("abc.trycloudflare.com");
    expect(out).not.toContain("SECRET123");
    expect(out).toContain("[redacted-tunnel-url]");
  });

  test("strips the bare host form even when no path is present", () => {
    const input = "Reached https://abc.trycloudflare.com and got 502.";
    const out = scrubTunnelUrlPattern(input);
    expect(out).not.toContain("trycloudflare.com");
    expect(out).toContain("[redacted-tunnel-url]");
  });

  test("strips multiple occurrences in a single error string", () => {
    const input = "primary https://a.trycloudflare.com/SEC/ fallback https://b.trycloudflare.com/OTHER/";
    const out = scrubTunnelUrlPattern(input);
    expect(out).not.toContain("trycloudflare.com");
    expect(out).not.toContain("SEC");
    expect(out).not.toContain("OTHER");
    // Two URLs => two replacements.
    expect((out.match(/\[redacted-tunnel-url\]/g) ?? []).length).toBe(2);
  });

  test("is case-insensitive on the host portion", () => {
    const input = "https://ABC.TryCloudflare.com/SECRET/ blew up";
    const out = scrubTunnelUrlPattern(input);
    expect(out).not.toContain("ABC.TryCloudflare.com");
    expect(out).not.toContain("SECRET");
    expect(out).toContain("[redacted-tunnel-url]");
  });

  test("leaves unrelated text untouched", () => {
    const input = "Some generic error message with no URL.";
    expect(scrubTunnelUrlPattern(input)).toBe(input);
  });

  test("stops at JSON-style quote delimiters so surrounding shape survives", () => {
    const input = '{"lastError":"start failed at https://abc.trycloudflare.com/SECRET/ end"}';
    const out = scrubTunnelUrlPattern(input);
    expect(out).not.toContain("abc.trycloudflare.com");
    expect(out).not.toContain("SECRET");
    // Surrounding JSON shape must remain parseable.
    expect(out.startsWith("{")).toBe(true);
    expect(out.endsWith("}")).toBe(true);
  });
});

// Drive GET /api/runtime/tunnel and POST /api/runtime/tunnel/refresh-notes
// against a stubbed global fetch. Pins that a non-2xx upstream body is run
// through scrubTunnelUrlPattern before the BFF forwards it to the browser,
// so a cloudflared startup error that quotes the live publicUrl cannot
// leak the credential through this surface.
describe("BFF tunnel error-forwarding scrubs trycloudflare URLs", () => {
  const originalFetch = globalThis.fetch;
  const envSnapshot: { token?: string; url?: string; instance?: string; root?: string } = {};
  let suiteRoot: string;

  beforeAll(() => {
    envSnapshot.token = process.env.GINI_TOKEN;
    envSnapshot.url = process.env.GINI_RUNTIME_URL;
    envSnapshot.instance = process.env.GINI_INSTANCE;
    envSnapshot.root = process.env.GINI_STATE_ROOT;
    suiteRoot = mkdtempSync(join(tmpdir(), "gini-bff-tunnel-error-"));
    // Pin runtime URL + token so the route's runtimeUrl()/runtimeToken()
    // helpers don't try to read ~/.gini state from a real instance.
    process.env.GINI_RUNTIME_URL = "http://127.0.0.1:9";
    process.env.GINI_TOKEN = "test-token";
    process.env.GINI_INSTANCE = "bff-tunnel-error-test";
    process.env.GINI_STATE_ROOT = suiteRoot;
    // Seed an empty config so runtimeToken() / runtimeTunnelState() don't
    // accidentally pick up a host machine's state.
    const dir = join(suiteRoot, "instances", "bff-tunnel-error-test");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ token: "test-token" }));
  });

  afterAll(() => {
    // Restore env so sibling test files inherit the original values, not
    // this suite's overrides.
    if (envSnapshot.token === undefined) delete process.env.GINI_TOKEN;
    else process.env.GINI_TOKEN = envSnapshot.token;
    if (envSnapshot.url === undefined) delete process.env.GINI_RUNTIME_URL;
    else process.env.GINI_RUNTIME_URL = envSnapshot.url;
    if (envSnapshot.instance === undefined) delete process.env.GINI_INSTANCE;
    else process.env.GINI_INSTANCE = envSnapshot.instance;
    if (envSnapshot.root === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = envSnapshot.root;
    globalThis.fetch = originalFetch;
    rmSync(suiteRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    // Restore the original fetch after each test so a sibling test
    // that runs between hooks doesn't observe the stub. proxy.test.ts
    // documents the same posture and shows why a leaked stub breaks
    // unrelated callers (e.g. providerConfigured probes turning into
    // spurious successes).
    globalThis.fetch = originalFetch;
  });

  function stubFetchReturning(status: number, body: string, contentType = "application/json"): void {
    globalThis.fetch = mock(async () =>
      new Response(body, { status, headers: { "content-type": contentType } })
    ) as unknown as typeof fetch;
  }

  test("GET /api/runtime/tunnel scrubs trycloudflare URLs from a 500 body before forwarding", async () => {
    const leakyBody = JSON.stringify({
      error: "Failed to start cloudflared: https://abc.trycloudflare.com/SECRET123/ refused connection"
    });
    stubFetchReturning(500, leakyBody);
    const request = new NextRequest(new URL("http://127.0.0.1:3072/api/runtime/tunnel"), {
      method: "GET",
      headers: { host: "127.0.0.1:3072", origin: "http://127.0.0.1:3072" }
    });
    const response = await GET(request);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("abc.trycloudflare.com");
    expect(text).not.toContain("SECRET123");
    expect(text).toContain("[redacted-tunnel-url]");
  });

  test("GET /api/runtime/tunnel forwards a non-leaky non-2xx body unchanged", async () => {
    const benignBody = JSON.stringify({ error: "Internal server error" });
    stubFetchReturning(503, benignBody);
    const request = new NextRequest(new URL("http://127.0.0.1:3072/api/runtime/tunnel"), {
      method: "GET",
      headers: { host: "127.0.0.1:3072", origin: "http://127.0.0.1:3072" }
    });
    const response = await GET(request);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toBe(benignBody);
  });

  test("GET /api/runtime/tunnel rejects mismatched Origin with 403", async () => {
    stubFetchReturning(200, JSON.stringify({}));
    const request = new NextRequest(new URL("http://127.0.0.1:3072/api/runtime/tunnel"), {
      method: "GET",
      headers: { host: "127.0.0.1:3072", origin: "https://attacker.example" }
    });
    const response = await GET(request);
    expect(response.status).toBe(403);
  });

  test("POST /api/runtime/tunnel/refresh-notes scrubs trycloudflare URLs from a 500 body before forwarding", async () => {
    const leakyBody = JSON.stringify({
      error: "osascript echoed body: <a href=\"https://abc.trycloudflare.com/SECRET123/\">link</a>"
    });
    stubFetchReturning(500, leakyBody);
    const request = new NextRequest(new URL("http://127.0.0.1:3072/api/runtime/tunnel/refresh-notes"), {
      method: "POST",
      headers: {
        host: "127.0.0.1:3072",
        origin: "http://127.0.0.1:3072"
      }
    });
    const response = await REFRESH_POST(request);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("abc.trycloudflare.com");
    expect(text).not.toContain("SECRET123");
    expect(text).toContain("[redacted-tunnel-url]");
  });

  test("POST /api/runtime/tunnel/refresh-notes still 403s when Origin does not match Host", async () => {
    // Regression guard: the new scrubbing path must NOT bypass the
    // Origin/Host guard. A cross-site POST should still be rejected
    // BEFORE we call upstream.
    let upstreamCalls = 0;
    globalThis.fetch = mock(async () => {
      upstreamCalls += 1;
      return new Response("{}", { status: 500 });
    }) as unknown as typeof fetch;
    const request = new NextRequest(new URL("http://127.0.0.1:3072/api/runtime/tunnel/refresh-notes"), {
      method: "POST",
      headers: {
        host: "127.0.0.1:3072",
        origin: "https://attacker.example"
      }
    });
    const response = await REFRESH_POST(request);
    expect(response.status).toBe(403);
    expect(upstreamCalls).toBe(0);
  });
});
