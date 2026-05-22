import { NextResponse, type NextRequest } from "next/server";

// Recognizes a per-instance tunnel secret URL prefix on tunneled requests
// and rewrites the path so the rest of the Next.js app router sees the
// un-prefixed shape. Localhost requests pass through untouched — the
// secret is only required when the request arrives via the public
// Cloudflare tunnel host.
//
// The secret is injected as an env var when the runtime spawns Next.js
// (src/cli/process.ts), so middleware never reads from disk and stays
// compatible with the edge runtime if Next.js promotes us there.

const SECRET = process.env.GINI_TUNNEL_SECRET ?? "";
const SECRET_PREFIX = SECRET ? `/${SECRET}` : null;

export function middleware(request: NextRequest): NextResponse {
  const host = request.headers.get("host") ?? "";
  const isLocalHost = host.startsWith("localhost") || host.startsWith("127.0.0.1");
  if (isLocalHost) {
    return NextResponse.next();
  }
  // External host: require the secret prefix and rewrite. The Cloudflare
  // tunnel forwards the verbatim pathname, so a tunneled GET
  // `https://<hostname>/<secret>/settings` arrives here as
  // pathname=/<secret>/settings.
  if (!SECRET_PREFIX) {
    return new NextResponse("Not Found", { status: 404 });
  }
  const { pathname } = request.nextUrl;
  // Bare `/<secret>` (no trailing slash) → redirect to slash form so
  // relative links resolve under the prefix.
  if (pathname === SECRET_PREFIX) {
    const url = request.nextUrl.clone();
    url.pathname = `${SECRET_PREFIX}/`;
    return NextResponse.redirect(url, 308);
  }
  if (!pathname.startsWith(`${SECRET_PREFIX}/`)) {
    return new NextResponse("Not Found", { status: 404 });
  }
  const rewritten = request.nextUrl.clone();
  rewritten.pathname = pathname.slice(SECRET_PREFIX.length) || "/";
  return NextResponse.rewrite(rewritten);
}

export const config = {
  // Match everything except Next.js static assets and the BFF tunnel-block
  // catch-all (which still gets to do its own decoding work after the
  // middleware has stripped the prefix).
  matcher: "/((?!_next/static|_next/image|favicon.ico).*)"
};
