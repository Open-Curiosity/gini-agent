import { NextRequest } from "next/server";
import { proxyRequest, runtimeInstance, runtimeToken, runtimeUrl } from "@/lib/runtime";

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
  // Refuse to proxy anything under /api/runtime/tunnel/*. The bare
  // `/tunnel` route is handled by web/src/app/api/runtime/tunnel/route.ts
  // (which redacts the secret); any other tunnel path would forward the
  // gateway's unredacted QR/SVG/ANSI content (which encodes the
  // secret-bearing URL) straight to browser JS, defeating the
  // token-isolation boundary. The dedicated route can take precedence
  // here even after percent-decoding (`%74unnel` etc.) because the
  // canonicalizer in proxyRequest normalizes segments and we compare on
  // the canonical lowercase value.
  if (canonicalFirstSegmentIsTunnel(path)) {
    return Response.json(
      { error: "Tunnel endpoints are not proxied through the BFF. Use the gateway directly or `gini tunnel qr`." },
      { status: 404 }
    );
  }
  return proxyRequest(request, path, {
    runtimeUrl: runtimeUrl(),
    token: runtimeToken(),
    signal: request.signal
  });
}

function canonicalFirstSegmentIsTunnel(path: readonly string[]): boolean {
  if (path.length === 0) return false;
  let segment = path[0] ?? "";
  // Decode up to a few times so a request to `/%74unnel/qr.svg` or
  // `/%2574unnel/qr.svg` (double-encoded) is rejected just like a
  // literal `tunnel`. Five iterations is enough to outrun any realistic
  // nesting and matches the canonicalizer depth used downstream.
  for (let i = 0; i < 5; i += 1) {
    let next: string;
    try { next = decodeURIComponent(segment); } catch { return false; }
    if (next === segment) break;
    segment = next;
  }
  return segment.toLowerCase() === "tunnel";
}

export const GET = (request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => forward(request, ctx.params);
export const POST = (request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => forward(request, ctx.params);
export const PATCH = (request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => forward(request, ctx.params);
export const DELETE = (request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => forward(request, ctx.params);
export const PUT = (request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => forward(request, ctx.params);
