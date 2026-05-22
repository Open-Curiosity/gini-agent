// Dedicated BFF route for `/api/tunnel`. The generic catch-all would proxy
// the upstream JSON verbatim, but that JSON contains the per-instance
// tunnel secret and the secret-bearing publicUrl — both of which are
// auth-bypass credentials. Per the project's token-isolation boundary
// (browser code must not receive gateway credentials), we redact those
// fields before the response leaves the BFF. The browser UI still gets
// everything it needs to display: cloudflareUrl (the bare host), the
// Apple Notes mirror status, observedAt, and lastError.

import { NextRequest } from "next/server";
import { runtimeToken, runtimeUrl } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function forwardRedacted(
  method: "GET" | "PATCH",
  body?: string,
  search?: string
): Promise<Response> {
  // Forward the query string verbatim so the operator can opt into the
  // documented `?refreshNotes=1` Apple Notes re-sync trigger. GET
  // without the flag stays read-only — important because the Settings
  // card polls this endpoint every 5s and we don't want to queue an
  // osascript subprocess on each poll.
  const upstream = await fetch(`${runtimeUrl()}/api/tunnel${search ?? ""}`, {
    method,
    headers: {
      authorization: `Bearer ${runtimeToken()}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {})
    },
    body
  });
  if (!upstream.ok) {
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" }
    });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await upstream.text());
  } catch {
    return new Response("{}", { status: 502, headers: { "content-type": "application/json" } });
  }
  const redacted = redactTunnelSnapshot(payload);
  return Response.json(redacted);
}

export function redactTunnelSnapshot(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  // Allow-list projection. The upstream snapshot may grow new fields over
  // time; this DTO opts each safe field in explicitly so any new
  // credential-bearing field (e.g. a future signed-redirect URL) fails
  // closed — the browser receives nothing it wasn't approved to see.
  // `secret` and `publicUrl` are emitted as explicit nulls so legacy
  // clients can still check `!!secret` / `!!publicUrl` against the
  // expected shape.
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : null,
    publicUrl: null,
    cloudflareUrl: typeof record.cloudflareUrl === "string" ? record.cloudflareUrl : null,
    secret: null,
    targetUrl: typeof record.targetUrl === "string" ? record.targetUrl : null,
    observedAt: typeof record.observedAt === "string" ? record.observedAt : null,
    appleNotes: redactAppleNotes(record.appleNotes),
    lastError: typeof record.lastError === "string" ? record.lastError : null
  };
}

function redactAppleNotes(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : null,
    folder: typeof record.folder === "string" ? record.folder : null,
    noteName: typeof record.noteName === "string" ? record.noteName : null,
    available: typeof record.available === "boolean" ? record.available : null,
    lastSyncedAt: typeof record.lastSyncedAt === "string" ? record.lastSyncedAt : null,
    lastError: typeof record.lastError === "string" ? record.lastError : null
  };
}

export const GET = async (request: NextRequest) => {
  const search = new URL(request.url).search;
  return forwardRedacted("GET", undefined, search);
};
export const PATCH = async (request: NextRequest) => {
  let body = "";
  try { body = await request.text(); } catch { body = ""; }
  return forwardRedacted("PATCH", body || "{}");
};
