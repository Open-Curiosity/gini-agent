import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  __test as browserTest,
  browserDrag,
  browserHover,
  browserNavigate,
  browserSelectOption,
  browserVision,
  closeAll,
  disconnectSharedBrowser,
  safetyCheck,
  setBrowserInstance,
  withTeardownLock
} from "./browser";
import { clearEchoVisionResponses, setEchoVisionResponse } from "../provider";
import { mutateState, readState } from "../state";
import type { RuntimeConfig } from "../types";

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

// Persistent-profile pivot: SharedHandle collapsed to { persistent | cdp }.
// "headless" no longer exists as a separate variant — both the default
// headless agent path and the visible Connect window share one persistent
// BrowserContext arm; only the `headed` flag at launch differs.
describe("browser disconnect lifecycle", () => {
  afterEach(() => {
    // Clean up any synthetic state the previous test installed so
    // subsequent tests start from zero.
    browserTest.uninstallFakeBrowserForTest();
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
    browserTest.clearPendingSharedForTest();
  });

  test("in-flight disconnect rejects new browser_navigate admissions", async () => {
    browserTest.setInFlightDisconnectsForTest(1);
    const result = await browserNavigate("disconnect-test-task", { url: "https://example.com/" });
    const parsed = JSON.parse(result) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/disconnecting/i);
  });

  test("disconnectSharedBrowser does not call close() on a CDP browser missing disconnect()", async () => {
    let closeCalled = false;
    browserTest.installFakeCdpBrowserForTest({
      // Intentionally no disconnect() — exactly the playwright-core
      // shape that previously triggered the buggy fallback. close()
      // over CDP terminates the user's Chrome, which we must avoid.
      close: async () => {
        closeCalled = true;
      }
    });
    await disconnectSharedBrowser();
    expect(closeCalled).toBe(false);
  });

  test("disconnectSharedBrowser calls disconnect() when available on CDP browser", async () => {
    let disconnectCalled = false;
    let closeCalled = false;
    browserTest.installFakeCdpBrowserForTest({
      disconnect: async () => {
        disconnectCalled = true;
      },
      close: async () => {
        closeCalled = true;
      }
    });
    await disconnectSharedBrowser();
    expect(disconnectCalled).toBe(true);
    expect(closeCalled).toBe(false);
  });

  test("disconnectSharedBrowser closes the visible persistent context (terminating Chromium)", async () => {
    // Visibility-toggle disconnect path: closing the BrowserContext is how
    // we shut down the Chromium process Playwright launched. The same arm
    // handles the next-call relaunch with `headless: true` against the
    // same profile dir, so sign-ins persist.
    let contextCloseCalled = false;
    browserTest.installFakeManagedContextForTest({
      close: async () => {
        contextCloseCalled = true;
      }
    });
    await disconnectSharedBrowser();
    expect(contextCloseCalled).toBe(true);
  });

  test("disconnectSharedBrowser also closes the HEADLESS persistent context", async () => {
    // Same teardown arm regardless of headed flag — when the user calls
    // wipe-profile, the headless persistent context must come down too so
    // the rm -rf isn't fighting an open Chromium handle. Tests the
    // headed=false variant explicitly so we don't regress that branch.
    let contextCloseCalled = false;
    browserTest.installFakeHeadlessPersistentContextForTest({
      close: async () => {
        contextCloseCalled = true;
      }
    });
    await disconnectSharedBrowser();
    expect(contextCloseCalled).toBe(true);
  });

  test("closeAll skips close() on a CDP browser missing disconnect()", async () => {
    let closeCalled = false;
    browserTest.installFakeCdpBrowserForTest({
      close: async () => {
        closeCalled = true;
      }
    });
    await closeAll();
    expect(closeCalled).toBe(false);
  });

  test("disconnectSharedBrowser drains in-flight before tearing down", async () => {
    let closeCalled = false;
    browserTest.installFakeManagedContextForTest({
      close: async () => {
        closeCalled = true;
      }
    });
    // Install a synthetic session reporting an in-flight call.
    browserTest.installFakeSessionForTest("drain-task", 1);
    // Schedule the in-flight to drop to zero after a short delay, well
    // under the 5s deadline. disconnect should observe the drop and
    // proceed.
    setTimeout(() => {
      browserTest.setFakeSessionInFlight("drain-task", 0);
    }, 150);
    const started = Date.now();
    await disconnectSharedBrowser();
    const elapsed = Date.now() - started;
    expect(closeCalled).toBe(true);
    // The wait loop sleeps in 50ms increments, so we should have slept
    // at least ~100ms but well under the 5s deadline.
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(2_000);
  });

  // Round-3 review fix: epoch counter. withSession captures the current
  // disconnect generation before awaiting getOrCreate; after the await
  // resumes it compares the current generation to the captured one and
  // bails out cleanly if a disconnect ran (or completed) in the gap.
  // This is deterministic — we control the pendingBrowser promise so
  // getOrCreate's await suspends until we resolve it AFTER bumping the
  // generation.
  test("withSession bails when disconnect generation advances during admission", async () => {
    // Install a pendingShared that we control so ensureShared's await
    // suspends at our latch instead of hitting playwright-core's real
    // launch (which would fail with "Chromium not found" and obscure
    // the assertion). The fake persistent handle is what getOrCreate
    // would see after the await resolves — but the test bumps the
    // generation BEFORE we resolve, so the post-await re-check bails
    // before getOrCreate ever touches it.
    let resolveShared: (handle: unknown) => void = () => undefined;
    const fakeContext = {
      pages: () => [],
      newPage: async () => ({
        on: () => undefined,
        close: () => Promise.resolve(),
        goto: () => Promise.resolve(null),
        url: () => "about:blank",
        title: () => Promise.resolve(""),
        evaluate: () => Promise.resolve([])
      }),
      close: () => Promise.resolve()
    };
    const fakeHandle = {
      kind: "persistent" as const,
      context: fakeContext,
      headed: false
    };
    const pending = new Promise<unknown>((resolve) => {
      resolveShared = resolve;
    });
    browserTest.installPendingSharedForTest(pending as Promise<never>);

    // Kick off the navigation. withSession captures the generation,
    // bumps pendingAdmissions, awaits getOrCreate -> ensureShared ->
    // pendingShared, and suspends.
    const navigatePromise = browserNavigate("admission-race", { url: "https://example.com/" });

    // Yield a microtask so withSession has actually entered the await
    // chain before we bump the generation.
    await new Promise((resolve) => setImmediate(resolve));

    // Simulate a disconnect completing while our admission was
    // suspended. Bump the generation; this is exactly what the real
    // disconnectSharedBrowser does at its top.
    browserTest.bumpDisconnectGenerationForTest();

    // Now resolve the pendingShared so the suspended admission resumes
    // and runs the post-await re-check. It should observe the
    // generation mismatch and bail.
    resolveShared(fakeHandle);

    const result = await navigatePromise;
    const parsed = JSON.parse(result) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/disconnecting/i);
  });
});

// Walker behavior: <select> options should land in the snapshot as sibling
// rows immediately after the select itself, each with its own @eN ref and a
// value="..." annotation. We sidestep Chromium by mocking the page.evaluate
// surface — it just runs the walker's function literal locally against a
// hand-built fake document. The walker only relies on a small slice of DOM
// APIs (tagName, attributes, children, computed style, bounding rect), so
// the stubs stay compact.
describe("snapshot walker — <select> option surfacing", () => {
  test("emits <option> children as @eN-refed siblings after the select", async () => {
    type FakeEl = {
      tagName: string;
      type?: string;
      value?: string;
      disabled?: boolean;
      hidden?: boolean;
      label?: string;
      text?: string;
      _attrs: Record<string, string>;
      _children: FakeEl[];
      _textContent: string;
      getAttribute(name: string): string | null;
      setAttribute(name: string, value: string): void;
      removeAttribute(name: string): void;
      getBoundingClientRect(): { width: number; height: number };
      get children(): FakeEl[];
      get textContent(): string;
      querySelectorAll(selector: string): FakeEl[];
    };
    const makeEl = (init: Partial<FakeEl> & { tagName: string; visible?: boolean; children?: FakeEl[]; textContent?: string }): FakeEl => {
      const visible = init.visible ?? true;
      const children = init.children ?? [];
      const el: FakeEl = {
        tagName: init.tagName,
        type: init.type,
        value: init.value,
        disabled: init.disabled,
        hidden: init.hidden,
        label: init.label,
        text: init.text,
        _attrs: { ...(init as { _attrs?: Record<string, string> })._attrs },
        _children: children,
        _textContent: init.textContent ?? "",
        getAttribute(name: string) {
          return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name]! : null;
        },
        setAttribute(name: string, value: string) {
          this._attrs[name] = value;
        },
        removeAttribute(name: string) {
          delete this._attrs[name];
        },
        getBoundingClientRect() {
          return visible ? { width: 100, height: 20 } : { width: 0, height: 0 };
        },
        get children() {
          return this._children;
        },
        get textContent() {
          return this._textContent;
        },
        querySelectorAll(selector: string) {
          // Only used by the walker for `option` (and the cleanup
          // `[data-gini-ref]` selector at the top of snapshot()).
          const matches: FakeEl[] = [];
          const recurse = (node: FakeEl) => {
            if (selector === "option") {
              if (node.tagName === "OPTION") matches.push(node);
            } else if (selector.startsWith("[") && selector.endsWith("]")) {
              const attr = selector.slice(1, -1);
              if (Object.prototype.hasOwnProperty.call(node._attrs, attr)) matches.push(node);
            }
            for (const child of node._children) recurse(child);
          };
          for (const child of this._children) recurse(child);
          return matches;
        }
      };
      return el;
    };

    // <body>
    //   <select name="size">
    //     <option value="s">Small</option>
    //     <option value="m">Medium</option>
    //     <option value="l" disabled>Large</option>
    //   </select>
    // </body>
    const optS = makeEl({ tagName: "OPTION", value: "s", text: "Small", label: "Small", textContent: "Small" });
    const optM = makeEl({ tagName: "OPTION", value: "m", text: "Medium", label: "Medium", textContent: "Medium" });
    const optL = makeEl({ tagName: "OPTION", value: "l", text: "Large", label: "Large", disabled: true, textContent: "Large" });
    const select = makeEl({
      tagName: "SELECT",
      value: "s",
      children: [optS, optM, optL],
      textContent: "Small Medium Large"
    });
    const body = makeEl({ tagName: "BODY", children: [select] });

    const docQueryAll = (selector: string): FakeEl[] => body.querySelectorAll(selector);
    const originalDocument = (globalThis as Record<string, unknown>).document;
    const originalWindow = (globalThis as Record<string, unknown>).window;
    const originalCSS = (globalThis as Record<string, unknown>).CSS;
    (globalThis as unknown as { document: unknown }).document = {
      body,
      querySelectorAll: docQueryAll,
      querySelector: (_sel: string) => null,
      getElementById: (_id: string) => null
    };
    (globalThis as unknown as { window: unknown }).window = {
      getComputedStyle: (_el: unknown) => ({ display: "block", visibility: "visible" })
    };
    (globalThis as unknown as { CSS: unknown }).CSS = { escape: (s: string) => s };

    // Fake Page whose page.evaluate(fn, arg) simply runs fn(arg) locally.
    let pageCallCount = 0;
    const fakePage = {
      evaluate: <A, R>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R> => {
        pageCallCount++;
        return Promise.resolve(fn(arg as A));
      },
      locator: (_sel: string) => ({} as unknown)
    } as unknown as import("playwright-core").Page;

    try {
      const result = await browserTest.snapshotForTest(fakePage, false);
      expect(pageCallCount).toBeGreaterThanOrEqual(1);
      // The select itself must be present as a combobox.
      expect(result.text).toContain("combobox");
      // The two enabled options should each show as an `option "<name>"
      // value="<v>"` row.
      const optionLines = result.text.split("\n").filter((line) => line.includes(" option "));
      expect(optionLines.length).toBeGreaterThanOrEqual(2);
      expect(result.text).toContain('option "Small" value="s"');
      expect(result.text).toContain('option "Medium" value="m"');
      // Disabled option is filtered.
      expect(result.text).not.toContain('value="l"');
      // Distinct refs per option (we just check that each option line
      // carries its own [@eN] token and they're not the same).
      const refs = optionLines
        .map((line) => /\[(@e\d+)\]/.exec(line)?.[1])
        .filter((r): r is string => Boolean(r));
      expect(refs.length).toBeGreaterThanOrEqual(2);
      expect(new Set(refs).size).toBe(refs.length);
    } finally {
      if (originalDocument === undefined) {
        delete (globalThis as Record<string, unknown>).document;
      } else {
        (globalThis as Record<string, unknown>).document = originalDocument;
      }
      if (originalWindow === undefined) {
        delete (globalThis as Record<string, unknown>).window;
      } else {
        (globalThis as Record<string, unknown>).window = originalWindow;
      }
      if (originalCSS === undefined) {
        delete (globalThis as Record<string, unknown>).CSS;
      } else {
        (globalThis as Record<string, unknown>).CSS = originalCSS;
      }
    }
  });
});

describe("chromeProfileDirFor", () => {
  test("derives the per-instance profile path from instance name", async () => {
    const { chromeProfileDirFor } = await import("./browser");
    const dir = chromeProfileDirFor("dev");
    expect(dir.endsWith("chrome-profile")).toBe(true);
    expect(dir.includes("dev")).toBe(true);
  });
});

// Round-1 fix: withTeardownLock holds the admission gate closed across
// the disconnect-then-launch (Connect) and disconnect-then-rm (Wipe)
// critical sections. Without it, an admission landing between the two
// awaits could re-acquire the profile lock with a fresh headless
// persistent context and fight the caller for the dir.
describe("withTeardownLock", () => {
  afterEach(() => {
    browserTest.uninstallFakeBrowserForTest();
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
    browserTest.clearPendingSharedForTest();
  });

  test("rejects parallel withSession admissions while the lock is held", async () => {
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lockPromise = withTeardownLock(async () => {
      await released;
    });
    // Yield so withTeardownLock has actually entered (incremented the
    // generation + inFlightDisconnects) before we attempt the admission.
    await new Promise((resolve) => setImmediate(resolve));
    const result = await browserNavigate("teardown-lock-task", { url: "https://example.com/" });
    const parsed = JSON.parse(result) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/disconnecting/i);
    release();
    await lockPromise;
  });

  test("restores the gate when fn throws so future admissions can land", async () => {
    await expect(
      withTeardownLock(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow(/boom/);
    expect(browserTest.inFlightDisconnectsForTest()).toBe(0);
  });
});

// Round-1 fix: disconnectSharedBrowser must await any in-flight launch
// (pendingShared) before tearing down. A slow launchPersistentContext
// started just before disconnect can otherwise complete after the drain
// and install itself into `shared`, holding the profile lock against
// the Connect/Wipe that's running this teardown.
describe("disconnectSharedBrowser pending-launch handling", () => {
  afterEach(() => {
    browserTest.uninstallFakeBrowserForTest();
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
    browserTest.clearPendingSharedForTest();
  });

  test("waits for an in-flight pendingShared launch and clears the resulting handle", async () => {
    // Build a pendingShared that resolves to a fake persistent context
    // AFTER disconnect has bumped the generation but before disconnect
    // has finished its drain. The natural ensureShared post-await
    // re-check would normally throw and tear down the freshly-built
    // handle, but we install pendingShared directly without going
    // through ensureShared so that re-check never runs. The disconnect
    // path itself must observe the leftover `shared` and tear it down.
    let contextCloseCalled = false;
    const fakeContext = {
      pages: () => [],
      close: async () => {
        contextCloseCalled = true;
      }
    };
    let resolvePending: (handle: unknown) => void = () => undefined;
    const pending = new Promise<unknown>((resolve) => {
      resolvePending = resolve;
    });
    browserTest.installPendingSharedForTest(pending as Promise<never>);

    // Kick off disconnect. It bumps the generation, increments
    // inFlightDisconnects, then enters the drain loop. pendingAdmissions
    // is 0, so the drain loop exits immediately. Then it should await
    // pendingShared and observe whatever the launch installs.
    const disconnectPromise = disconnectSharedBrowser();

    // Give disconnect a tick to enter the drain loop and reach the
    // pendingShared await.
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Simulate a slow launch finishing AND installing itself into
    // shared. We have to do the install ourselves because the test
    // bypassed ensureShared's installer.
    browserTest.installFakeHeadlessPersistentContextForTest(fakeContext);
    resolvePending(fakeContext);

    await disconnectPromise;
    // The disconnect path must have observed the freshly-installed
    // shared handle and torn it down (closing the context).
    expect(contextCloseCalled).toBe(true);
  });
});

// Round-1 fix 5: realistic coverage that the no-record default tool
// path launches launchPersistentContext against the per-instance profile
// dir with headless: true. Mocks playwright-core at the module level so
// ensureShared exercises its persistent arm without spawning Chrome.
describe("ensureShared default headless persistent launch", () => {
  afterEach(() => {
    browserTest.uninstallFakeBrowserForTest();
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
    browserTest.clearPendingSharedForTest();
  });

  test("launches launchPersistentContext(profileDir, { headless: true }) when no state.browser exists", async () => {
    const TEST_ROOT = "/tmp/gini-browser-default-headless";
    process.env["GINI_STATE_ROOT"] = TEST_ROOT;
    const instance = `default-headless-${process.pid}`;
    rmSync(`${TEST_ROOT}/instances/${instance}`, { recursive: true, force: true });
    setBrowserInstance(instance);

    const launchCalls: Array<{ dataDir: string; options: Record<string, unknown> }> = [];
    mock.module("playwright-core", () => ({
      chromium: {
        executablePath: () => "/fake/path/to/chromium",
        launchPersistentContext: async (dataDir: string, options: Record<string, unknown>) => {
          launchCalls.push({ dataDir, options });
          return {
            pages: () => [],
            newPage: async () => ({
              on: () => undefined,
              close: () => Promise.resolve(),
              goto: () => Promise.resolve(null),
              url: () => "about:blank",
              title: () => Promise.resolve(""),
              evaluate: () => Promise.resolve([])
            }),
            close: async () => undefined
          };
        }
      }
    }));
    browserTest.resetChromiumImportForTest();

    try {
      // Trigger the default tool path. We don't care about navigation
      // semantics here — the snapshot may fail since our fake page
      // isn't a real Playwright Page — but launchPersistentContext should
      // have been invoked exactly once with the per-instance profile dir
      // and headless: true before any of that.
      await browserNavigate("default-headless-task", { url: "https://example.com/" });
    } catch {
      // Snapshot wiring may throw; the assertion below is what matters.
    } finally {
      mock.restore();
      browserTest.uninstallFakeBrowserForTest();
      browserTest.clearFakeSessionsForTest();
      browserTest.resetChromiumImportForTest();
      setBrowserInstance("dev");
      rmSync(TEST_ROOT, { recursive: true, force: true });
    }

    expect(launchCalls.length).toBe(1);
    const call = launchCalls[0]!;
    expect(call.options.headless).toBe(true);
    expect(call.dataDir).toContain("chrome-profile");
    expect(call.dataDir).toContain(instance);
  });
});

// browser_vision: screenshots the current page and asks the configured vision
// model a question. We install a fake session with a stub `page.screenshot`
// so we don't need a real Chromium, and route the provider through the echo
// stub so the model response is deterministic.
describe("browserVision", () => {
  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
    clearEchoVisionResponses();
  });

  test("screenshots the current page and threads the question through generateVisionAnalysis", async () => {
    let screenshotCalls = 0;
    const fakePage = {
      screenshot: async (_opts: { type: "png"; fullPage?: boolean }) => {
        screenshotCalls++;
        // Tiny PNG header bytes — any non-empty Buffer is sufficient since
        // the provider call is stubbed.
        return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      },
      url: () => "https://example.com/dashboard"
    };
    browserTest.installFakeSessionWithPageForTest("vision-task", fakePage);

    setEchoVisionResponse({ text: "There is a login form in the center of the page." });

    const config: RuntimeConfig = {
      instance: "test",
      port: 7337,
      token: "test",
      provider: { name: "echo", model: "gini-echo-v0" },
      workspaceRoot: "/tmp",
      stateRoot: "/tmp/gini-vision-test",
      logRoot: "/tmp/gini-vision-test-logs"
    };
    const raw = await browserVision("vision-task", { question: "What is on this page?" }, config);
    const parsed = JSON.parse(raw) as {
      success: boolean;
      answer?: string;
      bytes?: number;
      url?: string;
      full?: boolean;
    };
    expect(parsed.success).toBe(true);
    expect(parsed.answer).toContain("login form");
    expect(parsed.bytes).toBeGreaterThan(0);
    expect(parsed.url).toBe("https://example.com/dashboard");
    expect(parsed.full).toBe(false);
    expect(screenshotCalls).toBe(1);
  });

  test("rejects calls missing the required question argument", async () => {
    const fakePage = {
      screenshot: async () => Buffer.from([0x89]),
      url: () => "https://example.com/"
    };
    browserTest.installFakeSessionWithPageForTest("vision-missing-q", fakePage);
    const config: RuntimeConfig = {
      instance: "test",
      port: 7337,
      token: "test",
      provider: { name: "echo", model: "gini-echo-v0" },
      workspaceRoot: "/tmp",
      stateRoot: "/tmp/gini-vision-test",
      logRoot: "/tmp/gini-vision-test-logs"
    };
    const raw = await browserVision("vision-missing-q", {}, config);
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/question/i);
  });
});

// Shared helper: build a minimal fake Page that satisfies the surface our
// tool entry points exercise (evaluate for snapshot, title/url, optional
// waitForLoadState). Tests planted refs directly via setFakeSessionRefsForTest
// so the walker doesn't need to run — they pass `fullMode: false` and we
// return an empty raw array which yields an empty snapshot.
function makeFakePageForRefTools(url = "https://example.com/"): Partial<import("playwright-core").Page> {
  return {
    url: () => url,
    title: () => Promise.resolve("Example"),
    // Walker invokes page.evaluate twice (clear stale refs, then walk). We
    // resolve to undefined for the cleanup pass and an empty array for the
    // walk so the snapshot text is just empty.
    evaluate: (async () => []) as unknown as import("playwright-core").Page["evaluate"],
    waitForLoadState: (async () => undefined) as unknown as import("playwright-core").Page["waitForLoadState"]
  };
}

describe("browserHover", () => {
  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
  });

  test("resolves the ref and calls locator.hover with a 10s timeout", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("hover-task", fakePage);
    const hoverCalls: Array<{ timeout?: number }> = [];
    const fakeLocator = {
      hover: async (opts?: { timeout?: number }) => {
        hoverCalls.push(opts ?? {});
      }
    };
    const refs = new Map<string, unknown>();
    refs.set("@e3", fakeLocator);
    browserTest.setFakeSessionRefsForTest("hover-task", refs);

    const raw = await browserHover("hover-task", { ref: "@e3" });
    const parsed = JSON.parse(raw) as { success: boolean; url?: string };
    expect(parsed.success).toBe(true);
    expect(parsed.url).toBe("https://example.com/");
    expect(hoverCalls.length).toBe(1);
    expect(hoverCalls[0]!.timeout).toBe(10_000);
  });

  test("returns the standard 'Unknown ref' error for missing refs", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("hover-missing", fakePage);
    const raw = await browserHover("hover-missing", { ref: "@e99" });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("Unknown ref @e99");
    expect(parsed.error).toContain("fresh snapshot");
  });

  test("rejects missing ref argument", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("hover-noarg", fakePage);
    const raw = await browserHover("hover-noarg", {});
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/ref/i);
  });
});

describe("browserDrag", () => {
  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
  });

  test("calls dragTo(toLoc, { timeout: 10000 }) on the from-locator", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("drag-task", fakePage);
    const fromLoc = {
      dragTo: async (target: unknown, opts?: { timeout?: number }) => {
        (fromLoc as unknown as { _called: { target: unknown; opts?: { timeout?: number } } })._called = {
          target,
          opts: opts ?? {}
        };
      }
    };
    const toLoc = { _marker: "to" };
    const refs = new Map<string, unknown>();
    refs.set("@e1", fromLoc);
    refs.set("@e2", toLoc);
    browserTest.setFakeSessionRefsForTest("drag-task", refs);

    const raw = await browserDrag("drag-task", { fromRef: "@e1", toRef: "@e2" });
    const parsed = JSON.parse(raw) as { success: boolean };
    expect(parsed.success).toBe(true);
    const captured = (fromLoc as unknown as { _called?: { target: unknown; opts?: { timeout?: number } } })._called;
    expect(captured).toBeDefined();
    expect(captured!.target).toBe(toLoc);
    expect(captured!.opts!.timeout).toBe(10_000);
  });

  test("returns 'Unknown ref' when fromRef is missing", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("drag-bad-from", fakePage);
    const refs = new Map<string, unknown>();
    refs.set("@e2", { dragTo: async () => undefined });
    browserTest.setFakeSessionRefsForTest("drag-bad-from", refs);

    const raw = await browserDrag("drag-bad-from", { fromRef: "@e1", toRef: "@e2" });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("Unknown ref @e1");
  });

  test("returns 'Unknown ref' when toRef is missing", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("drag-bad-to", fakePage);
    const fromLoc = { dragTo: async () => undefined };
    const refs = new Map<string, unknown>();
    refs.set("@e1", fromLoc);
    browserTest.setFakeSessionRefsForTest("drag-bad-to", refs);

    const raw = await browserDrag("drag-bad-to", { fromRef: "@e1", toRef: "@e2" });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("Unknown ref @e2");
  });

  test("rejects missing arguments", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("drag-noargs", fakePage);
    const rawMissingFrom = await browserDrag("drag-noargs", { toRef: "@e2" });
    expect(JSON.parse(rawMissingFrom).error).toMatch(/fromRef/);
    const rawMissingTo = await browserDrag("drag-noargs", { fromRef: "@e1" });
    expect(JSON.parse(rawMissingTo).error).toMatch(/toRef/);
  });
});

describe("browserSelectOption", () => {
  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
  });

  test("forwards single value to locator.selectOption", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("sel-single", fakePage);
    let captured: { selection: unknown; timeout?: number } | undefined;
    const loc = {
      selectOption: async (selection: unknown, opts?: { timeout?: number }) => {
        captured = { selection, timeout: opts?.timeout };
        return [];
      }
    };
    const refs = new Map<string, unknown>();
    refs.set("@e3", loc);
    browserTest.setFakeSessionRefsForTest("sel-single", refs);

    const raw = await browserSelectOption("sel-single", { ref: "@e3", value: "medium" });
    const parsed = JSON.parse(raw) as { success: boolean; selected?: unknown };
    expect(parsed.success).toBe(true);
    expect(parsed.selected).toBe("medium");
    expect(captured).toBeDefined();
    expect(captured!.selection).toBe("medium");
    expect(captured!.timeout).toBe(10_000);
  });

  test("forwards values[] to locator.selectOption for multi-select", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("sel-multi", fakePage);
    let captured: { selection: unknown } | undefined;
    const loc = {
      selectOption: async (selection: unknown) => {
        captured = { selection };
        return [];
      }
    };
    const refs = new Map<string, unknown>();
    refs.set("@e3", loc);
    browserTest.setFakeSessionRefsForTest("sel-multi", refs);

    const raw = await browserSelectOption("sel-multi", { ref: "@e3", values: ["a", "b"] });
    const parsed = JSON.parse(raw) as { success: boolean; selected?: unknown };
    expect(parsed.success).toBe(true);
    expect(parsed.selected).toEqual(["a", "b"]);
    expect(captured!.selection).toEqual(["a", "b"]);
  });

  test("rejects when neither value nor values is supplied", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("sel-neither", fakePage);
    const refs = new Map<string, unknown>();
    refs.set("@e3", { selectOption: async () => [] });
    browserTest.setFakeSessionRefsForTest("sel-neither", refs);

    const raw = await browserSelectOption("sel-neither", { ref: "@e3" });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/value/i);
  });

  test("rejects when both value and values are supplied", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("sel-both", fakePage);
    const refs = new Map<string, unknown>();
    refs.set("@e3", { selectOption: async () => [] });
    browserTest.setFakeSessionRefsForTest("sel-both", refs);

    const raw = await browserSelectOption("sel-both", { ref: "@e3", value: "a", values: ["b"] });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/either.*'value'.*or.*'values'/i);
  });

  test("rejects when values is not an array of strings", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("sel-bad-values", fakePage);
    const refs = new Map<string, unknown>();
    refs.set("@e3", { selectOption: async () => [] });
    browserTest.setFakeSessionRefsForTest("sel-bad-values", refs);

    // Non-array
    const rawNotArray = await browserSelectOption("sel-bad-values", { ref: "@e3", values: "not-an-array" });
    expect(JSON.parse(rawNotArray).error).toMatch(/array of strings/i);

    // Array with a non-string element
    const rawMixed = await browserSelectOption("sel-bad-values", { ref: "@e3", values: ["a", 1] });
    expect(JSON.parse(rawMixed).error).toMatch(/array of strings/i);
  });

  test("returns 'Unknown ref' when the ref isn't in the latest snapshot", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("sel-bad-ref", fakePage);
    const raw = await browserSelectOption("sel-bad-ref", { ref: "@e99", value: "x" });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("Unknown ref @e99");
  });

  test("rejects missing ref argument", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("sel-no-ref", fakePage);
    const raw = await browserSelectOption("sel-no-ref", { value: "x" });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/ref/);
  });
});
