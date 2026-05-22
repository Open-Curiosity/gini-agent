import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

// Drive `proxy()` against the real `runtimeTunnelState()` by writing
// config.json on disk under a scratch GINI_STATE_ROOT. Mocking the
// module instead (via `mock.module`) would persist across the test
// process and leak into sibling test files — runtime.test.ts in
// particular reads the same exports and breaks if it sees a stale
// in-memory stub.

const ROOT = join(tmpdir(), "gini-proxy-test-root");
const INSTANCE = "proxy-test";
const CONFIG_DIR = join(ROOT, "instances", INSTANCE);
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const TOKEN = "test-token";

const envSnapshot: { instance?: string; root?: string; token?: string; url?: string } = {};

beforeAll(() => {
  envSnapshot.instance = process.env.GINI_INSTANCE;
  envSnapshot.root = process.env.GINI_STATE_ROOT;
  envSnapshot.token = process.env.GINI_TOKEN;
  envSnapshot.url = process.env.GINI_RUNTIME_URL;
});

afterAll(() => {
  if (envSnapshot.instance === undefined) delete process.env.GINI_INSTANCE;
  else process.env.GINI_INSTANCE = envSnapshot.instance;
  if (envSnapshot.root === undefined) delete process.env.GINI_STATE_ROOT;
  else process.env.GINI_STATE_ROOT = envSnapshot.root;
  if (envSnapshot.token === undefined) delete process.env.GINI_TOKEN;
  else process.env.GINI_TOKEN = envSnapshot.token;
  if (envSnapshot.url === undefined) delete process.env.GINI_RUNTIME_URL;
  else process.env.GINI_RUNTIME_URL = envSnapshot.url;
  rmSync(ROOT, { recursive: true, force: true });
});

function writeTunnelConfig(tunnel: unknown): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({ instance: INSTANCE, token: TOKEN, tunnel }, null, 2)
  );
}

describe("proxy", () => {
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    process.env.GINI_INSTANCE = INSTANCE;
    process.env.GINI_STATE_ROOT = ROOT;
    process.env.GINI_TOKEN = TOKEN;
    // Pin the runtime URL so isProviderConfigured() always targets the
    // stubbed fetch below — without a static URL the helper would resolve
    // to the real instance's runtime.port and the test would race a live
    // gateway.
    process.env.GINI_RUNTIME_URL = "http://127.0.0.1:9";
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ providerConfigured: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  test("external host with tunnel disabled returns 404", async () => {
    writeTunnelConfig({ enabled: false, secret: "abcdefghij0123456789" });
    const request = new NextRequest(new URL("https://tunnel.example.com/anything"), {
      headers: { host: "tunnel.example.com" }
    });
    const response = await proxy(request);
    expect(response.status).toBe(404);
  });

  test("external host bootstrap to /<secret> redirects to / with Set-Cookie", async () => {
    const secret = "abcdefghij0123456789";
    writeTunnelConfig({ enabled: true, secret });
    const request = new NextRequest(new URL(`https://tunnel.example.com/${secret}`), {
      headers: { host: "tunnel.example.com" }
    });
    const response = await proxy(request);
    expect([307, 308]).toContain(response.status);
    expect(response.headers.get("location")).toBe("https://tunnel.example.com/");
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`gini_tunnel_session=${secret}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=lax");
    expect(setCookie).toContain("Max-Age=86400");
  });

  test("external host bootstrap to /<secret>/settings rewrites with Set-Cookie", async () => {
    const secret = "abcdefghij0123456789";
    writeTunnelConfig({ enabled: true, secret });
    const request = new NextRequest(new URL(`https://tunnel.example.com/${secret}/settings`), {
      headers: { host: "tunnel.example.com" }
    });
    const response = await proxy(request);
    const rewriteHeader = response.headers.get("x-middleware-rewrite");
    expect(rewriteHeader).not.toBeNull();
    expect(new URL(rewriteHeader as string).pathname).toBe("/settings");
    expect(response.status).toBeLessThan(300);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`gini_tunnel_session=${secret}`);
    expect(setCookie).toContain("HttpOnly");
  });

  test("external host with valid cookie + bare path passes through", async () => {
    const secret = "abcdefghij0123456789";
    writeTunnelConfig({ enabled: true, secret });
    const request = new NextRequest(new URL("https://tunnel.example.com/dashboard"), {
      headers: { host: "tunnel.example.com", cookie: `gini_tunnel_session=${secret}` }
    });
    const response = await proxy(request);
    expect(response.status).not.toBe(404);
    const location = response.headers.get("location");
    if (location) expect(location).not.toContain("/setup");
    const rewriteHeader = response.headers.get("x-middleware-rewrite");
    if (rewriteHeader) {
      expect(new URL(rewriteHeader).pathname).toBe("/dashboard");
    }
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("external host with wrong cookie and no prefix returns 404", async () => {
    writeTunnelConfig({ enabled: true, secret: "abcdefghij0123456789" });
    const request = new NextRequest(new URL("https://tunnel.example.com/dashboard"), {
      headers: {
        host: "tunnel.example.com",
        cookie: "gini_tunnel_session=not-the-secret"
      }
    });
    const response = await proxy(request);
    expect(response.status).toBe(404);
  });

  test("suffix-shadow hostname `localhost.attacker.example` still requires tunnel auth", async () => {
    writeTunnelConfig({ enabled: true, secret: "abcdefghij0123456789" });
    const request = new NextRequest(new URL("https://localhost.attacker.example/dashboard"), {
      headers: { host: "localhost.attacker.example" }
    });
    const response = await proxy(request);
    expect(response.status).toBe(404);
  });

  test("localhost host 127.0.0.1:3072 bypasses the tunnel gate", async () => {
    writeTunnelConfig({ enabled: true, secret: "abcdefghij0123456789" });
    const request = new NextRequest(new URL("http://127.0.0.1:3072/whatever"), {
      headers: { host: "127.0.0.1:3072" }
    });
    const response = await proxy(request);
    expect(response.status).not.toBe(404);
    const location = response.headers.get("location");
    if (location) expect(location).not.toContain("/setup");
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  test("external host with trailing-slash bootstrap `/<secret>/` accepts the request", async () => {
    const secret = "abcdefghij0123456789";
    writeTunnelConfig({ enabled: true, secret });
    const request = new NextRequest(new URL(`https://tunnel.example.com/${secret}/`), {
      headers: { host: "tunnel.example.com" }
    });
    const response = await proxy(request);
    expect(response.status).not.toBe(404);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`gini_tunnel_session=${secret}`);

    const isRedirect = response.status >= 300 && response.status < 400;
    const rewriteHeader = response.headers.get("x-middleware-rewrite");
    if (isRedirect) {
      const location = response.headers.get("location") ?? "";
      expect(new URL(location, "https://tunnel.example.com").pathname).toBe("/");
    } else {
      expect(rewriteHeader).not.toBeNull();
      expect(new URL(rewriteHeader as string).pathname).toBe("/");
    }
  });
});
