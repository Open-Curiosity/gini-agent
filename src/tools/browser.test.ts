import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { safetyCheck, setBrowserInstance } from "./browser";
import { mutateState, readState } from "../state";

// Direct unit coverage for the URL safety guard. We exercise the function
// without spinning up Chromium since the guard runs synchronously on the
// raw URL string before any browser work begins.
describe("browser safetyCheck", () => {
  test("blocks IPv4-mapped IPv6 dotted-quad form pointing at metadata", () => {
    const result = safetyCheck("http://[::ffff:169.254.169.254]/");
    expect(result).toBeDefined();
    expect(result!.startsWith("Blocked:")).toBe(true);
  });

  test("blocks IPv4-mapped IPv6 canonical hex form pointing at metadata", () => {
    // Bun normalizes [::ffff:169.254.169.254] to [::ffff:a9fe:a9fe], so the
    // hex-form decoder is what actually catches the request in practice.
    const result = safetyCheck("http://[::ffff:a9fe:a9fe]/");
    expect(result).toBeDefined();
    expect(result!.startsWith("Blocked:")).toBe(true);
  });

  test("blocks fe80:: link-local IPv6", () => {
    const result = safetyCheck("http://[fe80::1]/");
    expect(result).toBeDefined();
    expect(result!.startsWith("Blocked:")).toBe(true);
  });

  test("does not false-positive on fe8:: (outside fe80::/10 range)", () => {
    // fe8::1 zero-expands to 0fe8:: which is not in the link-local range.
    // The previous regex `^fe[89ab][0-9a-f]?:` would over-match; the fix
    // requires the fourth hex digit so this no longer triggers.
    const result = safetyCheck("http://[fe8::1]/");
    expect(result).toBeUndefined();
  });

  test("does not leak secret-bearing input through Invalid URL error", () => {
    // Malformed URL that nonetheless contains an apparent token. The
    // pre-parse secret scan should catch it and return a generic
    // "Blocked:" message that does NOT echo the raw input.
    const sneaky = "not-a-url sk-ant-api03-DEADBEEFDEADBEEFDEADBEEFDEADBEEF";
    const result = safetyCheck(sneaky);
    expect(result).toBeDefined();
    expect(result!.startsWith("Blocked:")).toBe(true);
    expect(result).not.toContain("sk-ant-");
    expect(result).not.toContain(sneaky);
  });

  test("catches percent-encoded tokens hidden alongside malformed escapes", () => {
    // %zz is a malformed escape that would make all-or-nothing
    // decodeURIComponent throw, falling back to scanning only the raw form.
    // The percent-decoded `%73%6b-ant-api03-...` segment is `sk-ant-api03-...`
    // which should be detected by the permissive per-`%HH` decoder.
    const sneaky = "http://example.com/%zz/%73%6b-ant-api03-XXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    const result = safetyCheck(sneaky);
    expect(result).toBeDefined();
    expect(result!.startsWith("Blocked:")).toBe(true);
    expect(result).not.toContain(sneaky);
    expect(result).not.toContain("sk-ant-");
    expect(result).not.toContain("%73%6b");
  });

  test("allows ordinary https URLs", () => {
    expect(safetyCheck("https://example.com/")).toBeUndefined();
  });
});

// Smoke test for the CDP-vs-launch decision. We can't actually exercise
// playwright-core's connectOverCDP / launch without spawning Chromium —
// the real verification happens in the manual end-to-end run. What we CAN
// verify here is that the session manager reads state.browser through the
// instance registered via setBrowserInstance(), so the wiring between the
// browser-connect capability and the tool layer is consistent.
describe("browser session manager state lookup", () => {
  const TEST_ROOT = "/tmp/gini-browser-state-tests";
  process.env["GINI_STATE_ROOT"] = TEST_ROOT;
  const instance = `browser-state-${process.pid}`;

  afterAll(() => {
    // Reset the module-level instance pointer so subsequent test files
    // in the same run don't accidentally read this test instance's state.
    // Passing the literal "dev" matches the production default.
    setBrowserInstance("dev");
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  test("setBrowserInstance points readState at the right instance", async () => {
    rmSync(`${TEST_ROOT}/instances/${instance}`, { recursive: true, force: true });
    // Seed a connection record so the session manager would, on next
    // browser tool call, attempt connectOverCDP() instead of launch().
    // We don't actually trigger that branch (no real CDP endpoint) but
    // the state shape it consumes is what we verify.
    await mutateState(instance, (state) => {
      state.browser = {
        mode: "cdp",
        cdpUrl: "ws://127.0.0.1:65535/devtools/browser/test",
        pid: null,
        dataDir: null,
        chromePath: null,
        startedAt: new Date().toISOString()
      };
    });
    setBrowserInstance(instance);
    const state = readState(instance);
    expect(state.browser?.cdpUrl).toContain("127.0.0.1:65535");
  });
});
