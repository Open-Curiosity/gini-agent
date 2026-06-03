import type { NextConfig } from "next";
import { resolve } from "node:path";

// Per-instance distDir lets the CLI run multiple `next dev` instances in
// parallel without them fighting over the same `<distDir>/lock`. The CLI
// passes `GINI_DIST_DIR=.next-<instance>` (always relative, kept inside `web/`
// per Next.js' distDir constraint). Defaulting to `.next` preserves the
// standalone `bun run dev` workflow for anyone running the web app
// outside `gini start`.
const distDir = process.env.GINI_DIST_DIR ?? ".next";

// The relay domain whose per-device subdomains the BFF trusts. Mirror the same
// GINI_RELAY_DOMAIN default the proxy/runtime guards read (web/src/proxy.ts,
// web/src/lib/runtime.ts) so a custom relay domain's dev `/_next/*` resources
// aren't blocked while the proxy accepts the tunneled requests.
const relayDomain = process.env.GINI_RELAY_DOMAIN ?? "gini-relay.lilaclabs.ai";

const nextConfig: NextConfig = {
  distDir,
  // Next.js 16 defaults to blocking dev-resource requests from any origin
  // other than `localhost`, which silently breaks HMR + client-component
  // hydration when the user lands on http://127.0.0.1:<port>. The Gini
  // installer and CLI consistently open the app via 127.0.0.1, so we
  // allow both forms explicitly. Production builds don't read this —
  // it's a dev-server concern only.
  // The relay-domain wildcard lets Next's dev-only `/_next/*` resources load
  // when the app is reached through a gini-relay tunnel (the operator's own
  // per-device subdomain); without it tunneled page loads can't pull HMR /
  // client chunks. Production builds don't read this — dev-server concern only.
  allowedDevOrigins: ["127.0.0.1", "localhost", `*.${relayDomain}`],
  turbopack: {
    root: resolve(import.meta.dirname)
  }
};

export default nextConfig;
