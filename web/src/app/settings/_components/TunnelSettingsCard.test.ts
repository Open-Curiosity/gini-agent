import { describe, expect, test } from "bun:test";
import { resolveSelfSeveringDisable } from "./TunnelSettingsCard";
import { HttpError } from "@/lib/api";

// The self-severing race exists to handle the disable-from-tunnel
// case: tearing cloudflared down severs the response channel BEFORE
// the browser sees the PATCH reply. The intent is to treat that
// specific failure shape (no HTTP response) as optimistic success
// because the server committed the change. But it must NOT swallow
// a real 4xx/5xx — the server reached the browser with a status code
// and an error body, so the UI must surface that as a failure
// instead of falsely toasting "Tunnel disabled".

describe("resolveSelfSeveringDisable", () => {
  test("returns the resolved value when the fetch wins the race", async () => {
    const snapshot = { enabled: false };
    const result = await resolveSelfSeveringDisable(Promise.resolve(snapshot), 100);
    expect(result).toEqual(snapshot);
  });

  test("re-throws HttpError so onError surfaces real 5xx server failures", async () => {
    // A 500 from the BFF or runtime is a real failure — the server
    // reached us with a status and a body, so we must NOT swallow it
    // as optimistic success. Otherwise the operator sees "Tunnel
    // disabled" while the tunnel is still up.
    const httpError = new HttpError("internal server error", 500);
    const rejected = Promise.reject(httpError);
    await expect(resolveSelfSeveringDisable(rejected, 100)).rejects.toBe(httpError);
  });

  test("re-throws HttpError for 4xx auth failures too", async () => {
    const httpError = new HttpError("unauthorized", 401);
    const rejected = Promise.reject(httpError);
    await expect(resolveSelfSeveringDisable(rejected, 100)).rejects.toBe(httpError);
  });

  test("treats a network-level TypeError (no HTTP response) as success", async () => {
    // Fetch raises a plain TypeError when the connection is reset,
    // DNS fails, or the request is aborted mid-flight — exactly the
    // expected shape when cloudflared closes the channel after
    // committing the config write. Return null so the optimistic
    // cache update + 5s refetch becomes the truth source.
    const networkError = new TypeError("Failed to fetch");
    const rejected = Promise.reject(networkError);
    const result = await resolveSelfSeveringDisable(rejected, 100);
    expect(result).toBeNull();
  });

  test("treats a plain Error (no status property) as a network failure", async () => {
    const plainError = new Error("connection reset");
    const rejected = Promise.reject(plainError);
    const result = await resolveSelfSeveringDisable(rejected, 100);
    expect(result).toBeNull();
  });

  test("returns null when the ceiling fires before the fetch resolves", async () => {
    // The fetch never resolves within the ceiling — same outcome as
    // a long hang after cloudflared severed the channel. The
    // optimistic flip stays; the next snapshot refetch reconciles.
    const { promise: neverResolves } = Promise.withResolvers<unknown>();
    const result = await resolveSelfSeveringDisable(neverResolves, 25);
    expect(result).toBeNull();
  });

  test("ceiling does NOT swallow an HttpError that arrives within the window", async () => {
    // Sanity: if the server responds quickly with a 500, we still
    // re-throw rather than letting the ceiling win.
    const httpError = new HttpError("boom", 500);
    const rejectedFast = Promise.reject(httpError);
    await expect(resolveSelfSeveringDisable(rejectedFast, 1000)).rejects.toBe(httpError);
  });
});
