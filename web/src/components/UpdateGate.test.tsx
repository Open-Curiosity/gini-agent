/// <reference lib="dom" />

// UpdateGate phase machine. The hazard pinned here: POST /update applies the
// new revision on disk in the OLD gateway process, so /status reports the new
// sha while both servers are about to restart — reloading on the sha alone
// lands the browser on a dead web server. The gate must hold in "restarting"
// until a status response provably comes from the restarted stack (a new
// gateway pid, or — when the starting pid is unknown — the first poll that
// succeeds after entering the phase).
//
// LEAK SAFETY: no module mocks — global fetch, window.location.reload and
// sessionStorage are stubbed/cleared per test and restored in afterEach.

import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, setSystemTime, test } from "bun:test";
import { act, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UpdateGateProvider, useUpdateGate } from "./UpdateGate";
import type { GiniUpdateResult, GiniVersionInfo } from "@runtime/types";

// react-query delivers observer notifications through a setTimeout(0)
// scheduler by default, which makes microtask-based flushing racy and
// deadlocks under fake timers. Deliver synchronously for this file; restored
// in afterAll (the suite's --isolate run is the structural backstop).
notifyManager.setScheduler((cb) => cb());
afterAll(() => notifyManager.setScheduler((cb) => setTimeout(cb, 0)));

const STORAGE_KEY = "gini.update.gate";

function versionInfo(sha: string): GiniVersionInfo {
  return {
    packageVersion: "1.0.0",
    runtimeDir: "/tmp/gini-runtime",
    git: { sha, shortSha: sha.slice(0, 7), branch: "main", origin: null, upstreamSha: null, updateAvailable: true },
    installedRuntimePresent: true,
    update: { supported: true }
  };
}

function updateResult(over: Partial<GiniUpdateResult> = {}): GiniUpdateResult {
  return {
    beforeSha: "sha-old",
    afterSha: "sha-new",
    commitCount: "1",
    upToDate: false,
    runtimeDir: "/tmp/gini-runtime",
    version: versionInfo("sha-new"),
    restart: { requested: true },
    ...over
  };
}

// Per-test mutable backend state the fetch stub serves from. Tests flip these
// between polls to walk the gate through the update lifecycle.
let statusSha: string;
let statusPid: number | null;
let statusFailing: boolean;
let updateResponse: () => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const realFetch = globalThis.fetch;
let reloadSpy: ReturnType<typeof mock>;
let originalReload: typeof window.location.reload;

beforeEach(() => {
  statusSha = "sha-old";
  statusPid = 111;
  statusFailing = false;
  updateResponse = async () => jsonResponse(updateResult());

  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/update/check")) return jsonResponse(versionInfo(statusSha));
    if (url.includes("/update")) return updateResponse();
    if (url.includes("/status")) {
      if (statusFailing) throw new TypeError("connection refused");
      return jsonResponse({ ok: true, pid: statusPid ?? undefined, version: versionInfo(statusSha) });
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;

  window.sessionStorage.clear();
  originalReload = window.location.reload;
  reloadSpy = mock(() => {});
  Object.defineProperty(window.location, "reload", { configurable: true, value: reloadSpy });
});

afterEach(() => {
  jest.useRealTimers();
  setSystemTime();
  globalThis.fetch = realFetch;
  window.sessionStorage.clear();
  Object.defineProperty(window.location, "reload", { configurable: true, value: originalReload });
});

// Minimal consumer so tests can read the phase and trigger start() the same
// way the sidebar's update row does.
function Probe() {
  const gate = useUpdateGate();
  return (
    <div>
      <span data-testid="phase">{gate.phase}</span>
      <button onClick={gate.start}>start-update</button>
    </div>
  );
}

function renderGate() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = rtlRender(
    <QueryClientProvider client={client}>
      <UpdateGateProvider>
        <Probe />
      </UpdateGateProvider>
    </QueryClientProvider>
  );
  return { client, view };
}

const phase = () => screen.getByTestId("phase").textContent;

// Flush pending microtasks so awaited fetch promises resolve inside act().
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// Force one status poll tick (the component's own interval is irrelevant to
// the assertions — what matters is what each response does to the phase).
async function pollStatus(client: QueryClient) {
  await act(async () => {
    await client.refetchQueries({ queryKey: ["status"] }).catch(() => {});
  });
}

describe("UpdateGate", () => {
  test("holds in restarting while the old stack reports the new sha, survives failed polls, and reloads only after a new gateway pid answers", async () => {
    jest.useFakeTimers();
    const { client } = renderGate();
    await flush();
    expect(phase()).toBe("idle");

    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    // The gate blurs immediately, before the slow POST settles.
    expect(phase()).toBe("updating");
    expect(screen.getByRole("alertdialog", { name: "Updating Gini" })).not.toBeNull();
    await flush();

    // The OLD gateway reports the new sha (version info comes from git on
    // disk) with its OLD pid — proof of nothing but the checkout. Hold.
    statusSha = "sha-new";
    await pollStatus(client);
    expect(phase()).toBe("restarting");
    expect(screen.getByRole("alertdialog", { name: "Restarting Gini" })).not.toBeNull();
    expect(reloadSpy).not.toHaveBeenCalled();

    // Both servers down: polls reject. The gate stays up.
    statusFailing = true;
    await pollStatus(client);
    await pollStatus(client);
    expect(phase()).toBe("restarting");
    expect(reloadSpy).not.toHaveBeenCalled();

    // The restarted gateway answers with a new pid → complete → reload after
    // the confirmation delay.
    statusFailing = false;
    statusPid = 222;
    await pollStatus(client);
    expect(phase()).toBe("complete");
    expect(screen.getByRole("alertdialog", { name: "Update complete" })).not.toBeNull();
    expect(reloadSpy).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    // The persisted gate is cleared first so the reloaded page comes up clean.
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("completes on the sha flip without waiting for a pid change when no restart was scheduled", async () => {
    updateResponse = async () => jsonResponse(updateResult({ restart: { requested: false } }));
    const { client } = renderGate();
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    await flush();
    statusSha = "sha-new";
    await pollStatus(client);
    // Servers never go down, so the old pid is fine to reload onto.
    expect(phase()).toBe("complete");
  });

  test("upToDate releases the gate without reloading", async () => {
    updateResponse = async () => jsonResponse(updateResult({ upToDate: true }));
    renderGate();
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    expect(phase()).toBe("updating");
    await flush();
    expect(phase()).toBe("idle");
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("a resumed restarting gate waits for a pid change even while polls succeed", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    setSystemTime(t0);
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ phase: "restarting", beforePid: 111 }));
    const { client } = renderGate();
    await flush();
    expect(phase()).toBe("restarting");

    // Later successful polls still carrying the old pid are the dying old
    // stack — the known starting pid must win over the time-based fallback.
    setSystemTime(new Date(t0.getTime() + 5_000));
    await pollStatus(client);
    expect(phase()).toBe("restarting");

    statusPid = 222;
    await pollStatus(client);
    expect(phase()).toBe("complete");
  });

  test("a resumed gate without a starting pid completes on the first poll after entering restarting", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    setSystemTime(t0);
    statusPid = null;
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ phase: "restarting" }));
    const { client } = renderGate();
    await flush();
    // The mount-time response landed at the same instant the phase was
    // entered — not yet proof of anything newer.
    expect(phase()).toBe("restarting");

    setSystemTime(new Date(t0.getTime() + 5_000));
    await pollStatus(client);
    expect(phase()).toBe("complete");
  });

  test("a persisted complete gate resumes and reloads after the delay", async () => {
    jest.useFakeTimers();
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ phase: "complete" }));
    renderGate();
    await flush();
    expect(phase()).toBe("complete");

    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("invalid persisted gates are ignored", async () => {
    window.sessionStorage.setItem(STORAGE_KEY, "not json");
    const first = renderGate();
    await flush();
    expect(phase()).toBe("idle");
    first.view.unmount();

    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ phase: "bogus" }));
    renderGate();
    await flush();
    expect(phase()).toBe("idle");
  });

  test("a structured gateway error releases the gate; a transport failure keeps it up", async () => {
    updateResponse = async () => jsonResponse({ error: "update failed" }, 500);
    renderGate();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    await flush();
    // The gateway replied non-2xx — a genuine pre-flight failure.
    expect(phase()).toBe("idle");

    // A rejected fetch means the gateway likely restarted before the response
    // flushed: keep the blur and let the detectors / stall timer resolve it.
    updateResponse = async () => {
      throw new TypeError("socket closed");
    };
    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    await flush();
    expect(phase()).toBe("updating");
  });

  test("the stall timer releases a gate that never completes", async () => {
    jest.useFakeTimers();
    // A POST that never settles, with status forever on the old sha.
    updateResponse = () => new Promise<Response>(() => {});
    renderGate();
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    expect(phase()).toBe("updating");

    await act(async () => {
      jest.advanceTimersByTime(120_000);
    });
    await flush();
    expect(phase()).toBe("idle");
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  test("useUpdateGate outside the provider fails loudly", () => {
    expect(() => rtlRender(<Probe />)).toThrow("useUpdateGate must be used within <UpdateGateProvider>");
  });
});

// The sha-only completion fallback (a reload interrupted the POST, so no
// targetSha or restartExpected was persisted) must still hold for the restart:
// restartExpected defaults to true on resume.
describe("UpdateGate resume without a recorded target", () => {
  test("a resumed updating gate moves to restarting on HEAD moving, then completes on the pid change", async () => {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ phase: "updating", beforeSha: "sha-old", beforePid: 111 })
    );
    const { client } = renderGate();
    await flush();
    expect(phase()).toBe("updating");

    statusSha = "sha-new";
    await pollStatus(client);
    expect(phase()).toBe("restarting");

    statusPid = 222;
    await pollStatus(client);
    expect(phase()).toBe("complete");
  });
});
