import type { NextConfig } from "next";
import { resolve } from "node:path";

// Per-instance distDir lets the CLI run multiple `next dev` instances in
// parallel without them fighting over the same `<distDir>/lock`. The CLI
// passes `GINI_DIST_DIR=.next-<instance>` (always relative, kept inside `web/`
// per Next.js' distDir constraint). Defaulting to `.next` preserves the
// standalone `bun run dev` workflow for anyone running the web app
// outside `gini start`.
const distDir = process.env.GINI_DIST_DIR ?? ".next";

const nextConfig: NextConfig = {
  distDir,
  // The CLI advertises the dev server as http://127.0.0.1:<port>, but Next 16
  // initializes the dev server with `localhost` and blocks cross-origin
  // requests to internal dev resources (HMR, chunk fetches) from any other
  // host — including 127.0.0.1. When those requests are blocked, hydration
  // silently fails: SSR HTML renders but React never wires up event handlers
  // or fires effects, so buttons go inert.
  allowedDevOrigins: ["127.0.0.1"],
  turbopack: {
    root: resolve(import.meta.dirname)
  }
};

export default nextConfig;
