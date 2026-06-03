import { describe, expect, test } from "bun:test";
import { createEmptyState, expirePairingRequests } from "./store";
import { hashSecret } from "./security";
import {
  approvePairingRequest,
  cancelPairingRequest,
  claimPairingRequest,
  createPairingRequest,
  deviceNameFromUserAgent,
  findActiveSessionByToken,
  getPairingRequest,
  listPendingPairingRequests,
  redactPairingRequest,
  rejectPairingRequest,
  touchSessionLastSeen
} from "./records";

const SECRET = "bind-secret-abc";
const BIND = hashSecret(SECRET);
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

function makeRequest(state = createEmptyState("sandbox"), overrides: { userAgent?: string; relayHost?: string; ttlSeconds?: number } = {}) {
  return createPairingRequest(state, {
    userAgent: overrides.userAgent ?? SAFARI_IPHONE,
    relayHost: overrides.relayHost ?? "sub.gini-relay.lilaclabs.ai",
    bindHash: BIND,
    ttlSeconds: overrides.ttlSeconds
  });
}

describe("deviceNameFromUserAgent", () => {
  test.each([
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120", "Edge · Windows"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120 Safari/537.36 OPR/106", "Opera · Mac"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel) Chrome/120 Mobile Safari/537.36 Brave/1.0", "Brave · Android"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0", "Firefox · Linux"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36", "Chrome · Mac"],
    [SAFARI_IPHONE, "Safari · iPhone"],
    ["Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605 Version/17.0 Safari/604.1", "Safari · iPad"],
    ["Firefox/121.0", "Firefox"],
    ["curl/8.4 (Windows)", "Windows"],
    ["SomeRandomBot/1.0", "Unknown device"],
    ["", "Unknown device"]
  ])("maps %p -> %p", (ua, expected) => {
    expect(deviceNameFromUserAgent(ua)).toBe(expected);
  });

  test("tolerates a null-ish user agent", () => {
    expect(deviceNameFromUserAgent(undefined as unknown as string)).toBe("Unknown device");
  });
});

describe("createPairingRequest", () => {
  test("creates a pending request with a comparison code and emits a pairing tick", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    expect(request.status).toBe("pending");
    expect(request.code).toMatch(/^\d{3}-\d{3}$/);
    expect(request.bindHash).toBe(BIND);
    expect(request.deviceName).toBe("Safari · iPhone");
    expect(request.relayHost).toBe("sub.gini-relay.lilaclabs.ai");
    expect(state.pairingRequests[0]?.id).toBe(request.id);
    expect(state.audit.some((event) => event.action === "pairing.requested")).toBe(true);
    // The first appended event is the "pairing" tick; the audit mirror is a
    // "runtime" event beneath it.
    expect(state.events[0]?.kind).toBe("pairing");
    expect(state.events[0]?.action).toBe("request");
    // The plaintext code must not leak into the broadcast event payload.
    expect(JSON.stringify(state.events[0]?.data ?? {})).not.toContain(request.code);
  });

  test("clamps the ttl to the 60-3600s window", () => {
    const low = makeRequest(createEmptyState("sandbox"), { ttlSeconds: 5 });
    const lowTtl = (new Date(low.expiresAt).getTime() - new Date(low.createdAt).getTime()) / 1000;
    expect(lowTtl).toBeGreaterThanOrEqual(59);
    expect(lowTtl).toBeLessThanOrEqual(62);

    const high = makeRequest(createEmptyState("sandbox"), { ttlSeconds: 999_999 });
    const highTtl = (new Date(high.expiresAt).getTime() - new Date(high.createdAt).getTime()) / 1000;
    expect(highTtl).toBeGreaterThanOrEqual(3599);
    expect(highTtl).toBeLessThanOrEqual(3602);
  });
});

describe("getPairingRequest / listPendingPairingRequests", () => {
  test("getPairingRequest returns the row or undefined", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    expect(getPairingRequest(state, request.id)?.id).toBe(request.id);
    expect(getPairingRequest(state, "preq_missing")).toBeUndefined();
  });

  test("listPendingPairingRequests excludes resolved and expired rows", () => {
    const state = createEmptyState("sandbox");
    const a = makeRequest(state);
    const b = makeRequest(state);
    approvePairingRequest(state, b.id);
    // Force a to be expired by backdating its expiry.
    const stored = state.pairingRequests.find((r) => r.id === a.id)!;
    stored.expiresAt = new Date(Date.now() - 1000).toISOString();
    const pending = listPendingPairingRequests(state);
    expect(pending.map((r) => r.id)).not.toContain(a.id);
    expect(pending.map((r) => r.id)).not.toContain(b.id);
    expect(stored.status).toBe("expired");
  });
});

describe("approvePairingRequest", () => {
  test("transitions pending -> approved and emits a resolved tick", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    const approved = approvePairingRequest(state, request.id);
    expect(approved.status).toBe("approved");
    expect(approved.resolvedAt).toBeDefined();
    expect(state.audit.some((event) => event.action === "pairing.approved")).toBe(true);
    expect(state.events[0]?.kind).toBe("pairing");
    expect(state.events[0]?.action).toBe("resolved");
  });

  test("throws on a missing request", () => {
    const state = createEmptyState("sandbox");
    expect(() => approvePairingRequest(state, "preq_missing")).toThrow("not found");
  });

  test("throws when the request is no longer pending", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    approvePairingRequest(state, request.id);
    expect(() => approvePairingRequest(state, request.id)).toThrow("already approved");
  });
});

describe("rejectPairingRequest", () => {
  test("transitions pending -> rejected", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    const rejected = rejectPairingRequest(state, request.id);
    expect(rejected.status).toBe("rejected");
    expect(state.audit.some((event) => event.action === "pairing.rejected")).toBe(true);
  });

  test("throws on a missing request", () => {
    const state = createEmptyState("sandbox");
    expect(() => rejectPairingRequest(state, "preq_missing")).toThrow("not found");
  });

  test("throws when the request is no longer pending", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    rejectPairingRequest(state, request.id);
    expect(() => rejectPairingRequest(state, request.id)).toThrow("already rejected");
  });
});

describe("cancelPairingRequest", () => {
  test("cancels a pending request when the binding secret matches", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    const result = cancelPairingRequest(state, request.id, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.status).toBe("cancelled");
  });

  test("cancels an approved-but-unclaimed request", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    approvePairingRequest(state, request.id);
    const result = cancelPairingRequest(state, request.id, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.status).toBe("cancelled");
  });

  test("is a no-op (still ok) for an already-resolved request", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    rejectPairingRequest(state, request.id);
    const result = cancelPairingRequest(state, request.id, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.status).toBe("rejected");
  });

  test("rejects a missing request", () => {
    const state = createEmptyState("sandbox");
    const result = cancelPairingRequest(state, "preq_missing", SECRET);
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  test("rejects a binding-secret mismatch", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    const result = cancelPairingRequest(state, request.id, "wrong-secret");
    expect(result).toEqual({ ok: false, reason: "bind_mismatch" });
    expect(state.pairingRequests[0]?.status).toBe("pending");
  });
});

describe("claimPairingRequest", () => {
  test("mints a session device and returns the raw token once", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    approvePairingRequest(state, request.id);
    const result = claimPairingRequest(state, request.id, SECRET);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected claim to succeed");
    expect(result.token).toMatch(/^gini_device_[0-9a-f]{32}$/);
    expect(result.device.tokenHash).toBe(hashSecret(result.token));
    expect(result.device.status).toBe("active");
    expect(result.device.origin).toBe(request.relayHost);
    expect(result.device.userAgent).toBe(SAFARI_IPHONE);
    expect(result.device.expiresAt).toBeDefined();
    expect(state.devices[0]?.id).toBe(result.device.id);
    const stored = state.pairingRequests.find((r) => r.id === request.id)!;
    expect(stored.status).toBe("claimed");
    expect(stored.deviceId).toBe(result.device.id);
    expect(state.audit.some((event) => event.action === "device.paired")).toBe(true);
  });

  test("rejects a missing request", () => {
    const state = createEmptyState("sandbox");
    expect(claimPairingRequest(state, "preq_missing", SECRET)).toEqual({ ok: false, reason: "not_found" });
  });

  test("rejects a binding-secret mismatch", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    approvePairingRequest(state, request.id);
    expect(claimPairingRequest(state, request.id, "wrong")).toEqual({ ok: false, reason: "bind_mismatch" });
  });

  test("rejects a not-yet-approved request", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    expect(claimPairingRequest(state, request.id, SECRET)).toEqual({ ok: false, reason: "not_approved" });
  });
});

describe("findActiveSessionByToken / touchSessionLastSeen", () => {
  function mintSession() {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    approvePairingRequest(state, request.id);
    const result = claimPairingRequest(state, request.id, SECRET);
    if (!result.ok) throw new Error("expected claim to succeed");
    return { state, token: result.token, device: result.device };
  }

  test("resolves an active, unexpired session without bumping lastSeenAt", () => {
    const { state, token, device } = mintSession();
    const before = device.lastSeenAt;
    const found = findActiveSessionByToken(state, token);
    expect(found?.id).toBe(device.id);
    // read-only: lastSeenAt is untouched
    expect(state.devices[0]?.lastSeenAt).toBe(before);
  });

  test("returns undefined for an unknown token", () => {
    const { state } = mintSession();
    expect(findActiveSessionByToken(state, "gini_device_unknown")).toBeUndefined();
  });

  test("returns undefined for a revoked session", () => {
    const { state, token } = mintSession();
    state.devices[0]!.status = "revoked";
    expect(findActiveSessionByToken(state, token)).toBeUndefined();
  });

  test("returns undefined for an expired session", () => {
    const { state, token } = mintSession();
    state.devices[0]!.expiresAt = new Date(Date.now() - 1000).toISOString();
    expect(findActiveSessionByToken(state, token)).toBeUndefined();
  });

  test("touchSessionLastSeen bumps lastSeenAt for an active session", () => {
    const { state, token } = mintSession();
    state.devices[0]!.lastSeenAt = "2020-01-01T00:00:00.000Z";
    expect(touchSessionLastSeen(state, token)).toBe(true);
    expect(state.devices[0]?.lastSeenAt).not.toBe("2020-01-01T00:00:00.000Z");
  });

  test("touchSessionLastSeen returns false for an unknown token", () => {
    const { state } = mintSession();
    expect(touchSessionLastSeen(state, "gini_device_unknown")).toBe(false);
  });
});

describe("redactPairingRequest", () => {
  test("drops the binding hash but keeps the comparison code", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    const redacted = redactPairingRequest(request);
    expect(redacted.code).toBe(request.code);
    expect(redacted.deviceName).toBe(request.deviceName);
    expect("bindHash" in redacted).toBe(false);
    expect("userAgent" in redacted).toBe(false);
  });
});

describe("expirePairingRequests", () => {
  test("expires pending rows past their deadline and leaves others alone", () => {
    const state = createEmptyState("sandbox");
    const fresh = makeRequest(state);
    const stale = makeRequest(state);
    const approved = makeRequest(state);
    approvePairingRequest(state, approved.id);
    state.pairingRequests.find((r) => r.id === stale.id)!.expiresAt = new Date(Date.now() - 1).toISOString();

    expirePairingRequests(state);

    expect(state.pairingRequests.find((r) => r.id === fresh.id)?.status).toBe("pending");
    expect(state.pairingRequests.find((r) => r.id === stale.id)?.status).toBe("expired");
    expect(state.pairingRequests.find((r) => r.id === approved.id)?.status).toBe("approved");
  });
});
