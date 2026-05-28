// Parity check: the runtime transport classifier
// (`src/runtime/tunnel/transport.ts`) and the BFF transport classifier
// (`web/src/lib/transport.ts`) are intentionally duplicated because
// Next.js refuses to bundle modules outside its `web/` project root.
// Both copies decide whether the active `publicUrl` is a quick-tunnel
// hostname (`*.trycloudflare.com`, SSE-stripping) so server pickers and
// client renderers can downgrade to long-polling consistently. A quiet
// drift between the two would let the server pick SSE and the client
// pick polling (or vice versa) for the same tunnel, breaking streams.
//
// This test pins the byte-equal-output contract: for every input below,
// both implementations must return the same `"sse" | "poll"` value.
// Mirrors `canonicalize.parity.test.ts` — add new inputs here whenever
// a transport edge case is patched in either file so the two never
// diverge silently.
//
// The web bundle prohibits the runtime side from importing the web
// helper at runtime, but at TEST time we run under `bun test` outside
// Next.js, so relative imports across the tree work fine.

import { describe, expect, test } from "bun:test";
import { inferTunnelTransport as runtimeInfer } from "./transport";
import { inferTunnelTransport as webInfer } from "../../../web/src/lib/transport";

const TRANSPORT_INPUTS: ReadonlyArray<string | null> = [
  // Null / empty — fail-safe to "sse" on both sides.
  null,
  "",
  // Quick-tunnel hostnames, lowercase and uppercase — must both be "poll".
  "https://abc.trycloudflare.com",
  "https://ABC.TRYCLOUDFLARE.COM",
  // Apex / regular hostnames — must both be "sse".
  "https://foo.example.com",
  "https://gini.lilaclabs.ai",
  // Unparseable URL — fail-safe to "sse" on both sides.
  "not a url",
  // Trailing-dot edge case — the hostname suffix check sees `.com.`, not
  // `.com`, so this must NOT be classified as a quick tunnel even though
  // it's textually adjacent. Both sides have to agree.
  "https://x.trycloudflare.com."
];

describe("inferTunnelTransport — runtime / BFF parity", () => {
  for (const input of TRANSPORT_INPUTS) {
    test(`agrees on input: ${JSON.stringify(input)}`, () => {
      const runtime = runtimeInfer(input);
      const web = webInfer(input);
      expect(web).toBe(runtime);
    });
  }
});
