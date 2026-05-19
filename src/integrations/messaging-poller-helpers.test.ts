import { describe, expect, test } from "bun:test";
import { sanitizeBridgeStatusMessage } from "./messaging-poller-helpers";

describe("sanitizeBridgeStatusMessage", () => {
  test("scrubs Discord 'Bot <token>' auth-header echoes", () => {
    const raw = "Header 'authorization' has invalid value: 'Bot abc.def.ghi'";
    expect(sanitizeBridgeStatusMessage(raw)).not.toContain("abc.def.ghi");
    expect(sanitizeBridgeStatusMessage(raw)).toContain("Bot <redacted>");
  });

  test("scrubs Telegram URL-path tokens '/bot<token>/'", () => {
    const raw = "fetch failed: https://api.telegram.org/bot123456:ABC-def_GHI/getMe";
    const out = sanitizeBridgeStatusMessage(raw);
    expect(out).not.toContain("123456:ABC-def_GHI");
    expect(out).toContain("/bot<redacted>/getMe");
  });

  test("scrubs absolute secret-store paths from ENOENT-shaped errors", () => {
    const raw = "ENOENT: no such file or directory, open '/Users/x/.gini/instances/dev/secrets/bridge_abc.bot-token.json'";
    const out = sanitizeBridgeStatusMessage(raw);
    expect(out).not.toContain("/.gini/instances/dev/secrets/");
    expect(out).toContain("<secret-path>");
    // The "ENOENT" diagnostic itself survives so the operator can see
    // the underlying cause.
    expect(out).toContain("ENOENT");
  });

  test("leaves messages without redactable patterns alone", () => {
    const raw = "401 Unauthorized: token revoked";
    expect(sanitizeBridgeStatusMessage(raw)).toBe(raw);
  });

  test("handles multiple distinct redactions in a single message", () => {
    const raw = "Bot abc123 then /bot789:xyz/sendMessage from '/tmp/x/secrets/bridge_y.token.json'";
    const out = sanitizeBridgeStatusMessage(raw);
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("789:xyz");
    expect(out).not.toContain("/tmp/x/secrets/");
  });

  test("runs in linear time on slash-heavy input without a /secrets/ segment (no ReDoS)", () => {
    // Pathological input: tens of thousands of slashes, no
    // "/secrets/" anywhere. The prior regex backtracked
    // catastrophically here (160k chars → 17s). Linear scan
    // should finish in milliseconds.
    const evil = "/".repeat(80_000);
    const start = Date.now();
    const out = sanitizeBridgeStatusMessage(evil);
    const elapsed = Date.now() - start;
    expect(out).toBe(evil);
    // 200ms gives plenty of headroom on slow CI; the actual
    // linear pass is well under 10ms locally.
    expect(elapsed).toBeLessThan(200);
  });

  test("scrubs a /secrets/ segment in slash-heavy input", () => {
    const raw = "/".repeat(1000) + "/Users/x/.gini/instances/dev/secrets/bridge.bot-token.json" + "/".repeat(1000);
    const out = sanitizeBridgeStatusMessage(raw);
    expect(out).toContain("<secret-path>");
    expect(out).not.toContain("/.gini/instances/dev/secrets/");
  });
});
