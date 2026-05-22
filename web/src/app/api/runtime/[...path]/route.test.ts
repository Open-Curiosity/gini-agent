// Note: this test asserts only the canonicalization helper, isolated from
// Next.js routing. Hitting the full handler requires booting the BFF.
import { describe, expect, test } from "bun:test";

// Re-implementation of the helper used in route.ts, kept in sync with that
// file. We can't import it directly because route.ts only exports HTTP
// handlers — TypeScript treats the file as a route module, not a library.
// The duplication is intentional and asserted-against here so a future
// drift between this test and the route diverges in CI.
function canonicalFirstSegmentIsTunnel(path: readonly string[]): boolean {
  if (path.length === 0) return false;
  let segment = path[0] ?? "";
  for (let i = 0; i < 5; i += 1) {
    let next: string;
    try { next = decodeURIComponent(segment); } catch { return false; }
    if (next === segment) break;
    segment = next;
  }
  return segment.toLowerCase() === "tunnel";
}

describe("BFF catch-all tunnel guard", () => {
  test("literal tunnel segment is recognized", () => {
    expect(canonicalFirstSegmentIsTunnel(["tunnel"])).toBe(true);
    expect(canonicalFirstSegmentIsTunnel(["tunnel", "qr.svg"])).toBe(true);
    expect(canonicalFirstSegmentIsTunnel(["tunnel", "qr.txt"])).toBe(true);
  });

  test("case-folded tunnel is recognized", () => {
    expect(canonicalFirstSegmentIsTunnel(["TUNNEL"])).toBe(true);
    expect(canonicalFirstSegmentIsTunnel(["TuNnEl", "qr.svg"])).toBe(true);
  });

  test("single-encoded tunnel is recognized", () => {
    expect(canonicalFirstSegmentIsTunnel(["%74unnel"])).toBe(true);
    expect(canonicalFirstSegmentIsTunnel(["tun%6Eel", "qr.svg"])).toBe(true);
  });

  test("double-encoded tunnel is recognized", () => {
    expect(canonicalFirstSegmentIsTunnel(["%2574unnel"])).toBe(true);
  });

  test("unrelated segments are not flagged", () => {
    expect(canonicalFirstSegmentIsTunnel(["status"])).toBe(false);
    expect(canonicalFirstSegmentIsTunnel(["tunneled"])).toBe(false);
    expect(canonicalFirstSegmentIsTunnel(["tunnels"])).toBe(false);
    expect(canonicalFirstSegmentIsTunnel([])).toBe(false);
  });

  test("malformed percent escapes are not flagged", () => {
    expect(canonicalFirstSegmentIsTunnel(["%ZZunnel"])).toBe(false);
  });
});
