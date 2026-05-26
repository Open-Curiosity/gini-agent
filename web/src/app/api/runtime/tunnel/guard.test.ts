// Unit tests for the shared Origin/Host guard used by the dedicated
// tunnel mutation routes (`/api/runtime/tunnel` PATCH and
// `/api/runtime/tunnel/refresh-notes` POST). Pins that:
//
//   - When `GINI_TRUSTED_ORIGINS` is configured, the allowlist is
//     authoritative. An Origin in the list passes; an Origin that
//     matches Host but is NOT in the list (the DNS-rebinding shape)
//     fails closed.
//   - When `GINI_TRUSTED_ORIGINS` is unset, the local-dev Host-
//     equality fallback applies — preserving the existing behavior
//     for operators running on loopback.
//   - Origin-less unsafe requests are refused regardless of allowlist
//     state.
//
// The catch-all proxy already enforces these semantics via
// `guardCsrf` (web/src/lib/runtime.ts). These tests pin that the
// dedicated guard is never *weaker* than the catch-all when the
// operator has opted into a strict allowlist.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { originHostMatchesRequest } from "./guard";

describe("originHostMatchesRequest", () => {
  let originsSnapshot: string | undefined;

  beforeEach(() => {
    originsSnapshot = process.env.GINI_TRUSTED_ORIGINS;
    delete process.env.GINI_TRUSTED_ORIGINS;
  });

  afterEach(() => {
    if (originsSnapshot === undefined) delete process.env.GINI_TRUSTED_ORIGINS;
    else process.env.GINI_TRUSTED_ORIGINS = originsSnapshot;
  });

  test("allowlist configured + Origin in list → pass", () => {
    process.env.GINI_TRUSTED_ORIGINS = "https://workmate.example";
    const request = new NextRequest(new URL("https://workmate.example/api/runtime/tunnel"), {
      method: "PATCH",
      headers: {
        host: "workmate.example",
        origin: "https://workmate.example"
      }
    });
    expect(originHostMatchesRequest(request)).toBe(true);
  });

  test("allowlist configured + Origin matches Host but NOT in allowlist (DNS rebind shape) → fail", () => {
    // The exact attack the allowlist exists to defeat: a DNS-rebinding
    // page on attacker.example resolves to 127.0.0.1, the browser
    // honestly sends Host=attacker.example and Origin=https://attacker.example,
    // and the Host-equality check alone would pass. The allowlist
    // takes that codepath off the table.
    process.env.GINI_TRUSTED_ORIGINS = "https://workmate.example";
    const request = new NextRequest(new URL("https://attacker.example/api/runtime/tunnel"), {
      method: "PATCH",
      headers: {
        host: "attacker.example",
        origin: "https://attacker.example"
      }
    });
    expect(originHostMatchesRequest(request)).toBe(false);
  });

  test("allowlist configured with garbage entries → fail closed", () => {
    // A typo that leaves zero parseable origins must refuse every
    // request, matching the fail-closed posture the catch-all uses
    // for the same shape.
    process.env.GINI_TRUSTED_ORIGINS = "not a url, also not a url";
    const request = new NextRequest(new URL("https://workmate.example/api/runtime/tunnel"), {
      method: "PATCH",
      headers: {
        host: "workmate.example",
        origin: "https://workmate.example"
      }
    });
    expect(originHostMatchesRequest(request)).toBe(false);
  });

  test("allowlist unset + Origin=Host → pass (local-dev fallback)", () => {
    const request = new NextRequest(new URL("http://127.0.0.1:3072/api/runtime/tunnel"), {
      method: "PATCH",
      headers: {
        host: "127.0.0.1:3072",
        origin: "http://127.0.0.1:3072"
      }
    });
    expect(originHostMatchesRequest(request)).toBe(true);
  });

  test("allowlist unset + Origin missing → fail", () => {
    const request = new NextRequest(new URL("http://127.0.0.1:3072/api/runtime/tunnel"), {
      method: "PATCH",
      headers: { host: "127.0.0.1:3072" }
    });
    expect(originHostMatchesRequest(request)).toBe(false);
  });

  test("allowlist unset + Origin mismatches Host → fail", () => {
    const request = new NextRequest(new URL("http://127.0.0.1:3072/api/runtime/tunnel"), {
      method: "PATCH",
      headers: {
        host: "127.0.0.1:3072",
        origin: "https://attacker.example"
      }
    });
    expect(originHostMatchesRequest(request)).toBe(false);
  });

  test("allowlist unset + Referer fallback used when Origin missing", () => {
    const request = new NextRequest(new URL("http://127.0.0.1:3072/api/runtime/tunnel"), {
      method: "PATCH",
      headers: {
        host: "127.0.0.1:3072",
        referer: "http://127.0.0.1:3072/settings"
      }
    });
    expect(originHostMatchesRequest(request)).toBe(true);
  });

  test("allowlist configured + Referer used as Origin fallback", () => {
    process.env.GINI_TRUSTED_ORIGINS = "https://workmate.example";
    const request = new NextRequest(new URL("https://workmate.example/api/runtime/tunnel"), {
      method: "PATCH",
      headers: {
        host: "workmate.example",
        referer: "https://workmate.example/settings"
      }
    });
    expect(originHostMatchesRequest(request)).toBe(true);
  });

  test("allowlist configured + Referer host not in allowlist → fail", () => {
    process.env.GINI_TRUSTED_ORIGINS = "https://workmate.example";
    const request = new NextRequest(new URL("https://attacker.example/api/runtime/tunnel"), {
      method: "PATCH",
      headers: {
        host: "attacker.example",
        referer: "https://attacker.example/settings"
      }
    });
    expect(originHostMatchesRequest(request)).toBe(false);
  });

  test("allowlist configured with multiple entries → any match passes", () => {
    process.env.GINI_TRUSTED_ORIGINS = "https://workmate.example, https://other.example";
    const request = new NextRequest(new URL("https://other.example/api/runtime/tunnel"), {
      method: "PATCH",
      headers: {
        host: "other.example",
        origin: "https://other.example"
      }
    });
    expect(originHostMatchesRequest(request)).toBe(true);
  });

  test("malformed Origin header → fail", () => {
    const request = new NextRequest(new URL("http://127.0.0.1:3072/api/runtime/tunnel"), {
      method: "PATCH",
      headers: {
        host: "127.0.0.1:3072",
        origin: "not-a-valid-url"
      }
    });
    expect(originHostMatchesRequest(request)).toBe(false);
  });

  test("allowlist unset + Origin with explicit default port matches Host without port", () => {
    // origin.port is "" when the URL uses the scheme's default port, so
    // the helper must compare correctly across that normalization.
    const request = new NextRequest(new URL("https://example.test/api/runtime/tunnel"), {
      method: "PATCH",
      headers: {
        host: "example.test",
        origin: "https://example.test:443"
      }
    });
    // When the port is the default for the scheme, URL parsing strips it,
    // so originHost is just "example.test", matching host "example.test".
    expect(originHostMatchesRequest(request)).toBe(true);
  });
});
