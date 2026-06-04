/// <reference lib="dom" />

// The /pair page state machine. The page talks only to @/lib/pairing's
// create/poll/claim/cancel fetchers, which hit same-origin /api/pairing/* — so we
// drive the whole device flow by stubbing global fetch and routing per URL+method:
//   create -> pending (code shown) -> poll approved -> claiming -> claim ->
//   window.location.assign("/").
// Plus the terminal states (rejected / expired / cancelled) and Cancel.
//
// Regression pinned here: when poll returns "approved", the claim runs in a
// SEPARATE effect; a prior bug self-cancelled that continuation so the reload
// never fired. We assert window.location.assign("/") IS called after approve.
//
// LEAK SAFETY: this file mocks NO modules — it stubs global fetch (restored in
// afterEach) and window.location.assign (restored in afterEach), so nothing
// bleeds into sibling test files. Mocking @/lib/pairing here would collide with
// PairRequestsPanel.test, which mocks the same specifier's hook exports.

import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PairingRequestStatus } from "@/lib/pairing";
import PairPage from "./page";

const POLL_MS = 2000;

// Per-route response programming. Each test sets the desired outcomes; the fetch
// stub matches on URL + method and returns the configured payload.
type Outcome = { ok?: boolean; body: unknown; status?: number };
let createOutcome: Outcome;
let pollStatus: PairingRequestStatus;
let pollOutcome: Outcome | null;
let claimOutcome: Outcome;
let cancelOutcome: Outcome;

const realFetch = globalThis.fetch;
let assignSpy: ReturnType<typeof mock>;
let originalAssign: typeof window.location.assign;

function jsonResponse({ ok = true, body, status }: Outcome): Response {
  return { ok, status: ok ? 200 : (status ?? 400), json: async () => body } as Response;
}

beforeEach(() => {
  createOutcome = { body: { id: "req-1", code: "428913" } };
  pollStatus = "pending";
  pollOutcome = null;
  claimOutcome = { body: { status: "approved" } };
  cancelOutcome = { body: { ok: true } };

  const fetchStub = (async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    if (url.endsWith("/api/pairing/request") && method === "POST") {
      return jsonResponse(createOutcome);
    }
    if (url.includes("/claim") && method === "POST") return jsonResponse(claimOutcome);
    if (url.includes("/cancel") && method === "POST") return jsonResponse(cancelOutcome);
    // GET /api/pairing/request/:id — the poll. pollOutcome overrides (e.g. a
    // 403/404 hard failure); otherwise return the current pollStatus.
    return jsonResponse(pollOutcome ?? { body: { status: pollStatus } });
  }) as unknown as typeof fetch;
  globalThis.fetch = fetchStub;

  originalAssign = window.location.assign;
  assignSpy = mock((_: string) => {});
  Object.defineProperty(window.location, "assign", { configurable: true, value: assignSpy });
});

afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = realFetch;
  Object.defineProperty(window.location, "assign", { configurable: true, value: originalAssign });
});

// Flush pending microtasks so awaited fetch promises resolve inside act().
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("PairPage", () => {
  test("mounts, creates a request, and shows the code", async () => {
    render(<PairPage />);
    await waitFor(() => expect(screen.queryByText("428913")).not.toBeNull());
    expect(screen.queryByText("Waiting for approval on your computer…")).not.toBeNull();
  });

  test("create failure surfaces the create-error state with a Try again button", async () => {
    createOutcome = { ok: false, body: { error: "relay down" } };
    render(<PairPage />);
    await waitFor(() => expect(screen.queryByText("relay down")).not.toBeNull());
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeNull();
  });

  test("approved poll transitions to claiming, claims, and reloads via location.assign('/')", async () => {
    jest.useFakeTimers();
    pollStatus = "approved";
    render(<PairPage />);
    await flush();
    expect(screen.queryByText("428913")).not.toBeNull();
    // Fire one poll tick -> approved -> claiming -> claim effect.
    await act(async () => {
      jest.advanceTimersByTime(POLL_MS);
    });
    await flush();
    await waitFor(() => expect(assignSpy).toHaveBeenCalledWith("/"), { timeout: 2000, interval: 10 });
  });

  test("claim failure surfaces claim-error without reloading", async () => {
    jest.useFakeTimers();
    pollStatus = "approved";
    claimOutcome = { ok: false, body: { error: "claim boom" } };
    render(<PairPage />);
    await flush();
    await act(async () => {
      jest.advanceTimersByTime(POLL_MS);
    });
    await flush();
    await waitFor(() => expect(screen.queryByText("claim boom")).not.toBeNull(), {
      timeout: 2000,
      interval: 10
    });
    expect(assignSpy).not.toHaveBeenCalled();
  });

  test("a 403/404 poll (e.g. binding cookie overwritten) is terminal, not an infinite spin", async () => {
    jest.useFakeTimers();
    // The request is gone for this browser (bind mismatch). Earlier this was
    // swallowed and the page spun forever; now it surfaces a restartable state.
    pollOutcome = { ok: false, status: 403, body: { error: "bind_mismatch" } };
    render(<PairPage />);
    await flush();
    await act(async () => {
      jest.advanceTimersByTime(POLL_MS);
    });
    await flush();
    await waitFor(
      () => expect(screen.queryByText(/no longer valid/i)).not.toBeNull(),
      { timeout: 2000, interval: 10 }
    );
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeNull();
    expect(assignSpy).not.toHaveBeenCalled();
  });

  test("a transient (network) poll failure keeps waiting, not terminal", async () => {
    jest.useFakeTimers();
    // A non-4xx failure (e.g. a relay blip → 500) must NOT terminate the flow.
    pollOutcome = { ok: false, status: 500, body: { error: "blip" } };
    render(<PairPage />);
    await flush();
    await act(async () => {
      jest.advanceTimersByTime(POLL_MS);
    });
    await flush();
    // Still pending (the spinner copy), no terminal error, no reload.
    expect(screen.queryByText("Waiting for approval on your computer…")).not.toBeNull();
    expect(screen.queryByText(/no longer valid/i)).toBeNull();
    expect(assignSpy).not.toHaveBeenCalled();
  });

  test("rejected poll shows the denied state", async () => {
    jest.useFakeTimers();
    pollStatus = "rejected";
    render(<PairPage />);
    await flush();
    await act(async () => {
      jest.advanceTimersByTime(POLL_MS);
    });
    await flush();
    await waitFor(() => expect(screen.queryByText("Request denied")).not.toBeNull(), {
      timeout: 2000,
      interval: 10
    });
  });

  test("expired poll shows the expired state", async () => {
    jest.useFakeTimers();
    pollStatus = "expired";
    render(<PairPage />);
    await flush();
    await act(async () => {
      jest.advanceTimersByTime(POLL_MS);
    });
    await flush();
    await waitFor(() => expect(screen.queryByText("This code expired")).not.toBeNull(), {
      timeout: 2000,
      interval: 10
    });
  });

  test("cancelled poll shows the cancelled state", async () => {
    jest.useFakeTimers();
    pollStatus = "cancelled";
    render(<PairPage />);
    await flush();
    await act(async () => {
      jest.advanceTimersByTime(POLL_MS);
    });
    await flush();
    await waitFor(() => expect(screen.queryByText("Pairing cancelled")).not.toBeNull(), {
      timeout: 2000,
      interval: 10
    });
  });

  test("a transient poll rejection is swallowed and the loop keeps waiting", async () => {
    jest.useFakeTimers();
    render(<PairPage />);
    await flush();
    // First tick: make the poll throw, then recover to pending — the page should
    // stay on the waiting view rather than entering a terminal state.
    globalThis.fetch = (async () => {
      throw new Error("blip");
    }) as unknown as typeof fetch;
    await act(async () => {
      jest.advanceTimersByTime(POLL_MS);
    });
    await flush();
    expect(screen.queryByText("Waiting for approval on your computer…")).not.toBeNull();
  });

  test("Cancel calls the cancel route and shows the cancelled state", async () => {
    render(<PairPage />);
    await waitFor(() => expect(screen.queryByText("428913")).not.toBeNull());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Pairing cancelled")).not.toBeNull());
  });

  test("a cancel-server-error still resolves to the cancelled state locally", async () => {
    cancelOutcome = { ok: false, body: { error: "already terminal" } };
    render(<PairPage />);
    await waitFor(() => expect(screen.queryByText("428913")).not.toBeNull());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Pairing cancelled")).not.toBeNull());
  });

  test("Try again from a create-error restarts the request", async () => {
    createOutcome = { ok: false, body: { error: "relay down" } };
    render(<PairPage />);
    await waitFor(() => expect(screen.queryByText("relay down")).not.toBeNull());
    createOutcome = { body: { id: "req-2", code: "999000" } };
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByText("999000")).not.toBeNull());
  });
});
