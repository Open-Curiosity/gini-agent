import { describe, expect, test } from "bun:test";
import {
  buildTunnelCookie,
  isTunnelDenied,
  looksLikeSecretSegment,
  matchSecretPrefix,
  readTunnelCookie,
  rewriteForTunnel,
  tunnelSecretEquals,
  withoutTrailingSlash
} from "./tunnel-policy";

describe("isTunnelDenied", () => {
  test("denies entire /api/runtime/pairing subtree", () => {
    expect(isTunnelDenied("/api/runtime/pairing", "POST")).toBe(true);
    expect(isTunnelDenied("/api/runtime/pairing/", "POST")).toBe(true);
    expect(isTunnelDenied("/api/runtime/pairing/claim", "POST")).toBe(true);
    expect(isTunnelDenied("/api/runtime/pairing/anything", "GET")).toBe(true);
  });

  test("allows GET on bare /api/runtime/tunnel (rewrite carve-out)", () => {
    expect(isTunnelDenied("/api/runtime/tunnel", "GET")).toBe(false);
    expect(isTunnelDenied("/api/runtime/tunnel/", "GET")).toBe(false);
  });

  test("denies non-GET on bare /api/runtime/tunnel", () => {
    expect(isTunnelDenied("/api/runtime/tunnel", "PATCH")).toBe(true);
    expect(isTunnelDenied("/api/runtime/tunnel/", "POST")).toBe(true);
    expect(isTunnelDenied("/api/runtime/tunnel", "DELETE")).toBe(true);
  });

  test("denies the entire /api/runtime/tunnel/<sub> subtree", () => {
    expect(isTunnelDenied("/api/runtime/tunnel/qr.svg", "GET")).toBe(true);
    expect(isTunnelDenied("/api/runtime/tunnel/refresh-notes", "POST")).toBe(true);
    expect(isTunnelDenied("/api/runtime/tunnel/anything-new", "PATCH")).toBe(true);
  });

  test("allows unrelated paths", () => {
    expect(isTunnelDenied("/api/runtime/chat", "POST")).toBe(false);
    expect(isTunnelDenied("/api/runtime/state", "GET")).toBe(false);
  });
});

describe("rewriteForTunnel", () => {
  test("rewrites bare GET /api/runtime/tunnel to /api/tunnel/redacted", () => {
    expect(rewriteForTunnel("/api/runtime/tunnel", "GET")).toEqual(["tunnel", "redacted"]);
    expect(rewriteForTunnel("/api/runtime/tunnel/", "GET")).toEqual(["tunnel", "redacted"]);
  });

  test("does not rewrite non-GET methods", () => {
    expect(rewriteForTunnel("/api/runtime/tunnel", "PATCH")).toBeNull();
  });

  test("does not rewrite sub-paths", () => {
    expect(rewriteForTunnel("/api/runtime/tunnel/qr.svg", "GET")).toBeNull();
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
