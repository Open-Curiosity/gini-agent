/// <reference lib="dom" />

// Raw @/lib/pairing fetchers. The global fetch is stubbed so we can assert each
// fetcher's URL/method and the shared error path. Device fetchers hit the native
// same-origin /api/pairing/* surface; admin fetchers hit the BFF
// /api/runtime/pairing/* surface (the mirror model — usable by any paired
// session, loopback or relay). See ADR device-pairing-auth.md.
//
// fetch is restored in afterEach.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  approvePairingRequest,
  cancelPairingRequest,
  claimPairingRequest,
  createPairingRequest,
  listPairingRequests,
  pollPairingRequest,
  rejectPairingRequest
} from "./pairing";

const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof mock>;

type FetchCall = { url: string; init: RequestInit };
let lastCall: FetchCall | null;

function stubFetch(body: unknown, { ok = true, status = 200 } = {}) {
  fetchMock = mock(async (url: string, init: RequestInit = {}) => {
    lastCall = { url, init };
    return {
      ok,
      status,
      json: async () => body
    } as Response;
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
}

beforeEach(() => {
  lastCall = null;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("pairing fetchers", () => {
  test("createPairingRequest POSTs to /request with an empty json body", async () => {
    stubFetch({ id: "abc", code: "123456" });
    const out = await createPairingRequest();
    expect(out).toEqual({ id: "abc", code: "123456" });
    expect(lastCall?.url).toBe("/api/pairing/request");
    expect(lastCall?.init.method).toBe("POST");
    expect(lastCall?.init.body).toBe("{}");
    expect(lastCall?.init.credentials).toBe("same-origin");
    expect((lastCall?.init.headers as Record<string, string>)["content-type"]).toBe(
      "application/json"
    );
  });

  test("pollPairingRequest GETs /request/:id (id encoded)", async () => {
    stubFetch({ status: "pending" });
    const out = await pollPairingRequest("a b/c");
    expect(out).toEqual({ status: "pending" });
    expect(lastCall?.url).toBe("/api/pairing/request/a%20b%2Fc");
    expect(lastCall?.init.method).toBeUndefined();
  });

  test("claimPairingRequest POSTs /request/:id/claim", async () => {
    stubFetch({ ok: true });
    const out = await claimPairingRequest("xyz");
    expect(out).toEqual({ ok: true });
    expect(lastCall?.url).toBe("/api/pairing/request/xyz/claim");
    expect(lastCall?.init.method).toBe("POST");
    expect(lastCall?.init.body).toBe("{}");
  });

  test("cancelPairingRequest POSTs /request/:id/cancel", async () => {
    stubFetch({ ok: true });
    await cancelPairingRequest("xyz");
    expect(lastCall?.url).toBe("/api/pairing/request/xyz/cancel");
    expect(lastCall?.init.method).toBe("POST");
  });

  test("listPairingRequests GETs the BFF /pairing/requests", async () => {
    stubFetch({ requests: [] });
    const out = await listPairingRequests();
    expect(out).toEqual({ requests: [] });
    expect(lastCall?.url).toBe("/api/runtime/pairing/requests");
  });

  test("approvePairingRequest POSTs the BFF /pairing/requests/:id/approve", async () => {
    stubFetch({ request: { id: "1" } });
    await approvePairingRequest("1");
    expect(lastCall?.url).toBe("/api/runtime/pairing/requests/1/approve");
    expect(lastCall?.init.method).toBe("POST");
  });

  test("rejectPairingRequest POSTs the BFF /pairing/requests/:id/reject", async () => {
    stubFetch({ request: { id: "1" } });
    await rejectPairingRequest("1");
    expect(lastCall?.url).toBe("/api/runtime/pairing/requests/1/reject");
    expect(lastCall?.init.method).toBe("POST");
  });

  test("a non-ok device response with an error body throws that message", async () => {
    stubFetch({ error: "nope" }, { ok: false, status: 403 });
    await expect(createPairingRequest()).rejects.toThrow("nope");
  });

  test("a non-ok admin response with no error body throws an HTTP fallback", async () => {
    stubFetch({}, { ok: false, status: 500 });
    await expect(listPairingRequests()).rejects.toThrow("HTTP 500");
  });

  test("a device body that fails to parse as json is treated as empty (HTTP fallback on error)", async () => {
    fetchMock = mock(async (url: string, init: RequestInit = {}) => {
      lastCall = { url, init };
      return {
        ok: false,
        status: 502,
        json: async () => {
          throw new Error("invalid json");
        }
      } as unknown as Response;
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(createPairingRequest()).rejects.toThrow("HTTP 502");
  });
});
