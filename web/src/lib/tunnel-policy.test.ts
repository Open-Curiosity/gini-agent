import { describe, expect, test } from "bun:test";
import {
  buildTunnelCookie,
  isTunnelDenied,
  looksLikeSecretSegment,
  matchSecretPrefix,
  readTunnelCookie,
  tunnelSecretEquals,
  withoutTrailingSlash
} from "./tunnel-policy";

describe("isTunnelDenied", () => {
  test("denies entire /api/runtime/pairing subtree on every method", () => {
    expect(isTunnelDenied("/api/runtime/pairing", "POST")).toBe(true);
    expect(isTunnelDenied("/api/runtime/pairing/", "POST")).toBe(true);
    expect(isTunnelDenied("/api/runtime/pairing/claim", "POST")).toBe(true);
    expect(isTunnelDenied("/api/runtime/pairing/anything", "GET")).toBe(true);
  });

  test("allows bare /api/runtime/tunnel on GET (snapshot) and PATCH (mutate) only", () => {
    expect(isTunnelDenied("/api/runtime/tunnel", "GET")).toBe(false);
    expect(isTunnelDenied("/api/runtime/tunnel/", "GET")).toBe(false);
    expect(isTunnelDenied("/api/runtime/tunnel", "PATCH")).toBe(false);
    expect(isTunnelDenied("/api/runtime/tunnel/", "PATCH")).toBe(false);
  });

  test("denies bare /api/runtime/tunnel on methods the live API doesn't support", () => {
    expect(isTunnelDenied("/api/runtime/tunnel/", "POST")).toBe(true);
    expect(isTunnelDenied("/api/runtime/tunnel", "DELETE")).toBe(true);
    expect(isTunnelDenied("/api/runtime/tunnel", "PUT")).toBe(true);
  });

  test("allows QR endpoints on GET only — operator gates them via click-to-reveal", () => {
    expect(isTunnelDenied("/api/runtime/tunnel/qr.svg", "GET")).toBe(false);
    expect(isTunnelDenied("/api/runtime/tunnel/qr.txt", "GET")).toBe(false);
  });

  test("denies QR endpoints on methods other than GET", () => {
    expect(isTunnelDenied("/api/runtime/tunnel/qr.svg", "POST")).toBe(true);
    expect(isTunnelDenied("/api/runtime/tunnel/qr.txt", "DELETE")).toBe(true);
  });

  test("allows /refresh-notes on POST only — GET shouldn't mutate iCloud", () => {
    expect(isTunnelDenied("/api/runtime/tunnel/refresh-notes", "POST")).toBe(false);
    expect(isTunnelDenied("/api/runtime/tunnel/refresh-notes", "GET")).toBe(true);
    expect(isTunnelDenied("/api/runtime/tunnel/refresh-notes", "PUT")).toBe(true);
  });

  test("denies unknown /api/runtime/tunnel/<sub> by default", () => {
    expect(isTunnelDenied("/api/runtime/tunnel/anything-new", "PATCH")).toBe(true);
    expect(isTunnelDenied("/api/runtime/tunnel/diagnostics", "GET")).toBe(true);
  });

  test("allows unrelated paths", () => {
    expect(isTunnelDenied("/api/runtime/chat", "POST")).toBe(false);
    expect(isTunnelDenied("/api/runtime/state", "GET")).toBe(false);
  });

  test("denies POST /api/runtime/push/devices — APNs registration must not be tunnelable", () => {
    expect(isTunnelDenied("/api/runtime/push/devices", "POST")).toBe(true);
    expect(isTunnelDenied("/api/runtime/push/devices/", "POST")).toBe(true);
    // DELETE on a sub-path would otherwise let a leaked URL holder
    // unregister another device; deny every write verb.
    expect(isTunnelDenied("/api/runtime/push/devices/tok_phone", "DELETE")).toBe(true);
    expect(isTunnelDenied("/api/runtime/push/devices", "PUT")).toBe(true);
    expect(isTunnelDenied("/api/runtime/push/devices", "PATCH")).toBe(true);
  });

  test("allows GET /api/runtime/push/devices — read-only enumeration is safe", () => {
    expect(isTunnelDenied("/api/runtime/push/devices", "GET")).toBe(false);
    expect(isTunnelDenied("/api/runtime/push/devices/", "GET")).toBe(false);
  });
});

describe("matchSecretPrefix", () => {
  test("matches /<secret>", () => {
    expect(matchSecretPrefix("/abc", "abc")).toEqual({ match: true, suffix: "/" });
  });

  test("matches /<secret>/", () => {
    expect(matchSecretPrefix("/abc/", "abc")).toEqual({ match: true, suffix: "/" });
  });

  test("matches /<secret>/<rest>", () => {
    expect(matchSecretPrefix("/abc/foo/bar", "abc")).toEqual({ match: true, suffix: "/foo/bar" });
  });

  test("does not match an unrelated path", () => {
    expect(matchSecretPrefix("/abc-other", "abc")).toBeNull();
  });

  test("does not match an empty secret", () => {
    expect(matchSecretPrefix("/abc", "")).toBeNull();
  });
});

describe("tunnelSecretEquals", () => {
  test("equal secrets compare equal", () => {
    expect(tunnelSecretEquals("X".repeat(32), "X".repeat(32))).toBe(true);
  });

  test("different secrets compare unequal", () => {
    expect(tunnelSecretEquals("X".repeat(32), "Y".repeat(32))).toBe(false);
  });

  test("length mismatch is unequal", () => {
    expect(tunnelSecretEquals("abc", "abcd")).toBe(false);
  });
});

describe("cookie helpers", () => {
  test("buildTunnelCookie sets HttpOnly + Secure + SameSite=Lax + no Domain", () => {
    const c = buildTunnelCookie("X".repeat(32));
    expect(c).toContain("gini_tunnel_session=XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
    expect(c).toContain("Path=/");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Max-Age=86400");
    expect(c).not.toContain("Domain=");
  });

  test("readTunnelCookie extracts the named cookie from a multi-cookie header", () => {
    const headers = new Headers({ cookie: "foo=bar; gini_tunnel_session=ABCDEF; baz=qux" });
    expect(readTunnelCookie(headers)).toBe("ABCDEF");
  });

  test("readTunnelCookie returns null when missing", () => {
    expect(readTunnelCookie(new Headers())).toBeNull();
    expect(readTunnelCookie(new Headers({ cookie: "foo=bar" }))).toBeNull();
  });
});

describe("looksLikeSecretSegment", () => {
  test("accepts a 32-char base64url string", () => {
    expect(looksLikeSecretSegment("A".repeat(32))).toBe(true);
  });

  test("rejects too short", () => {
    expect(looksLikeSecretSegment("abc")).toBe(false);
  });

  test("rejects non base64url characters", () => {
    expect(looksLikeSecretSegment("AAAA====")).toBe(false);
  });
});

describe("withoutTrailingSlash", () => {
  test("strips trailing slash", () => {
    expect(withoutTrailingSlash("/api/runtime/tunnel/")).toBe("/api/runtime/tunnel");
  });

  test("leaves bare slash alone", () => {
    expect(withoutTrailingSlash("/")).toBe("/");
  });
});
