"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PairingRequestStatus } from "@runtime/types";
import { api } from "@/lib/api";

// Re-export the runtime contract's status union so callers keep importing it from
// here, but the single source of truth stays in @runtime/types (no hand-copied
// duplicate that could drift from the wire).
export type { PairingRequestStatus };

// Two surfaces, deliberately split (see ADR device-pairing-auth.md):
//   - DEVICE handshake (request/poll/claim/cancel): the UNPAIRED device on /pair
//     has no session, so it cannot use the bearer-injecting BFF. These hit the
//     gateway's NATIVE /api/pairing/* SAME-ORIGIN (public, gini_pair-bound).
//   - ADMIN routes (list/approve/reject): used by a PAIRED session. They go
//     through the BFF (/api/runtime/pairing/*) so a paired relay session reaches
//     them exactly like loopback — once paired, the relay is a mirror of
//     127.0.0.1; the only relay-specific gate is the initial pairing handshake.
// The gini_pair / gini_session cookies are HttpOnly, managed by the gateway.

export interface PairingRequestView {
  id: string;
  code: string;
  status: PairingRequestStatus;
  deviceName: string;
  relayHost: string;
  createdAt: string;
  expiresAt: string;
}

async function pairingFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/pairing${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    credentials: "same-origin"
  });
  const value = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    // Attach the HTTP status so callers (e.g. the /pair poll loop) can tell a
    // terminal 403/404 from a transient network blip.
    const error = new Error(value.error ?? `HTTP ${response.status}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return value as T;
}

// --- Device side (the /pair page over the relay) ---------------------------
export function createPairingRequest(): Promise<{ id: string; code: string }> {
  return pairingFetch("/request", { method: "POST", body: "{}" });
}
export function pollPairingRequest(id: string): Promise<{ status: PairingRequestStatus }> {
  return pairingFetch(`/request/${encodeURIComponent(id)}`);
}
export function claimPairingRequest(id: string): Promise<{ ok: true }> {
  return pairingFetch(`/request/${encodeURIComponent(id)}/claim`, { method: "POST", body: "{}" });
}
export function cancelPairingRequest(id: string): Promise<{ ok: true }> {
  return pairingFetch(`/request/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" });
}

// --- Admin side (the approval panel — any paired session, loopback or relay) ---
// Routed through the BFF (/api/runtime/pairing/*, via the api() helper) so a
// paired relay session reaches these exactly like loopback: the BFF re-presents
// the request to the gateway over loopback. An unpaired relay visitor has no
// session and is 401'd at the relay gate before reaching the BFF, so it can never
// hit these. See ADR device-pairing-auth.md ("Relay sessions mirror loopback").
export function listPairingRequests(): Promise<{ requests: PairingRequestView[] }> {
  return api<{ requests: PairingRequestView[] }>("/pairing/requests");
}
export function approvePairingRequest(id: string): Promise<{ request: PairingRequestView }> {
  return api<{ request: PairingRequestView }>(`/pairing/requests/${encodeURIComponent(id)}/approve`, { method: "POST", body: "{}" });
}
export function rejectPairingRequest(id: string): Promise<{ request: PairingRequestView }> {
  return api<{ request: PairingRequestView }>(`/pairing/requests/${encodeURIComponent(id)}/reject`, { method: "POST", body: "{}" });
}

// Live list of pending pairing requests for the admin approval panel. Polls
// every 3s as a durability backstop; the SSE "pairing" tick also invalidates
// ["pairingRequests"] for instant updates. The panel mounts only inside the
// (open-gated) Pair-device dialog, so this query is active only while shown —
// on loopback OR any paired relay session (both are admins).
export function usePairingRequests() {
  return useQuery({
    queryKey: ["pairingRequests"],
    queryFn: async () => (await listPairingRequests()).requests,
    refetchInterval: 3000
  });
}

export function useApprovePairing() {
  const qc = useQueryClient();
  return useMutation<PairingRequestView, Error, string>({
    mutationFn: async (id: string) => (await approvePairingRequest(id)).request,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pairingRequests"] });
      qc.invalidateQueries({ queryKey: ["devices"] });
    }
  });
}

export function useRejectPairing() {
  const qc = useQueryClient();
  return useMutation<PairingRequestView, Error, string>({
    mutationFn: async (id: string) => (await rejectPairingRequest(id)).request,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pairingRequests"] })
  });
}
