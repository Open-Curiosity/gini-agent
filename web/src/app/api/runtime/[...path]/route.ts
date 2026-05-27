import { NextRequest } from "next/server";
import { proxyRequest, runtimeInstance, runtimeToken, runtimeUrl } from "@/lib/runtime";
import { canonicalizePath } from "@/lib/canonicalize";
import { isTunnelDenied, rewriteForTunnel, TUNNEL_MARKER_HEADER, TUNNEL_MARKER_VALUE } from "@/lib/tunnel-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function forward(request: NextRequest, params: Promise<{ path: string[] }>): Promise<Response> {
  const { path } = await params;
  // Defensive guard — Next.js routes static segments before catch-alls, but if
  // someone reorganizes the tree we want the healthz route to remain owned by
  // the local handler rather than being proxied to the runtime (which has no
  // such endpoint).
  if (path.length === 1 && path[0] === "__healthz") {
    return Response.json({ ok: true, service: "gini-web", instance: runtimeInstance() });
  }
  // Re-canonicalize the BFF-visible form so the deny + rewrite checks operate
  // on the same string the runtime would see. The proxy already canonicalized
  // the inbound pathname before stamping vetted=1, but checking again here is
  // intentional defense-in-depth — see PLAN.md "Deny list through the tunnel".
  const inboundPath = `/api/runtime/${path.join("/")}`;
  const canon = canonicalizePath(inboundPath);
  if (!canon.ok) return Response.json({ error: "Invalid path" }, { status: 400 });
  const isVetted = request.headers.get(TUNNEL_MARKER_HEADER) === TUNNEL_MARKER_VALUE;
  if (isVetted && isTunnelDenied(canon.path, request.method)) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const outboundPath = isVetted ? (rewriteForTunnel(canon.path, request.method) ?? path) : path;
  return proxyRequest(request, outboundPath, {
    runtimeUrl: runtimeUrl(),
    token: runtimeToken(),
    signal: request.signal
  });
}

export const GET = (request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => forward(request, ctx.params);
export const POST = (request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => forward(request, ctx.params);
export const PATCH = (request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => forward(request, ctx.params);
export const DELETE = (request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => forward(request, ctx.params);
export const PUT = (request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => forward(request, ctx.params);
