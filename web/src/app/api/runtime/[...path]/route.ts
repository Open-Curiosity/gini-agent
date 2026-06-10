import { NextRequest } from "next/server";
import { proxyRequest, runtimeInstance, runtimeToken, runtimeUrl } from "@/lib/runtime";
import { canonicalizePath } from "@/lib/canonicalize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function forward(request: NextRequest, params: Promise<{ path: string[] }>): Promise<Response> {
  const { path } = await params;
  // THE healthz handler. Underscore-prefixed App Router folders are private
  // and never route, so a sibling __healthz/route.ts can't serve this path —
  // the catch-all must answer it locally rather than proxying to the runtime
  // (which has no such endpoint). It lets the CLI probe a Next.js-specific
  // marker rather than trusting that any HTTP server on the chosen port is
  // ours: the CLI matches on `service: "gini-web"` AND the spawned child PID
  // being alive — see src/cli/process.ts:waitForWebHealthz. It also serves as
  // the web-server identity marker for the update gate
  // (web/src/components/UpdateGate.tsx). `pid` (the worker serving this
  // request) is diagnostic only: it is NOT a restart proof, because the next
  // CLI respawns the worker — new pid, same server tree — on any
  // next.config.* change, which an update's checkout can trigger without the
  // tree restarting. `ppid` is the supervising next CLI process and is the
  // tree's identity: stable across worker respawns, replaced only when the
  // whole tree is restarted (launchctl kickstart / stop+start).
  if (path.length === 1 && path[0] === "__healthz") {
    return Response.json({
      ok: true,
      service: "gini-web",
      instance: runtimeInstance(),
      pid: process.pid,
      ppid: process.ppid
    });
  }
  // Re-canonicalize the BFF-visible form so the path the runtime receives
  // matches what the BFF validated — defense-in-depth against traversal and
  // encoding tricks before the request is forwarded.
  const inboundPath = `/api/runtime/${path.join("/")}`;
  const canon = canonicalizePath(inboundPath);
  if (!canon.ok) return Response.json({ error: "Invalid path" }, { status: 400 });
  return proxyRequest(request, canon.path.replace(/^\/api\/runtime\//, "").split("/"), {
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
