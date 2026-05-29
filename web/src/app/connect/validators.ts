// Validators for the /connect deep-link interstitial. Extracted so the
// security-sensitive parsing rules can be exercised by focused unit tests
// without pulling in the Next.js page render path.

export const DEFAULT_SCHEME = "gini://connect";
export const DEFAULT_FALLBACK_MS = 1500;

export function singleParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function validateHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

// The scheme value lands on `window.location.href` inside the
// ConnectClient component. A `javascript:` URL with a crafted body
// would execute same-origin JS that can fetch `/api/runtime/*` and
// pivot through the BFF's bearer injection. Defenses, in order:
//
// 1. Reject by length cap so a degenerate-long payload doesn't even
//    enter validation.
// 2. Explicit case-insensitive blocklist for known script-execution
//    schemes — `javascript:`, `data:`, `vbscript:`, `file:`, `blob:`,
//    `about:`. The blocklist runs BEFORE the regex so a percent-encoded
//    variant like `javascript%3A...` (which decodes once via Next.js
//    searchParams to `javascript:...`) is caught before the next step.
// 3. Structural shape: a real deep-link scheme is `<scheme>://<path>`
//    with the scheme starting with a lowercase letter and the post-`://`
//    body limited to alphanumerics + `.-_/+`. `javascript:` URLs cannot
//    pass this shape because they don't have `://` followed by a
//    well-formed path (and `javascript://...` is also blocklisted above).
// 4. The shape disallows `%` so a doubly-encoded payload that only
//    decodes once can't sneak the body past the regex.
export const DANGEROUS_SCHEME_PREFIXES = ["javascript:", "data:", "vbscript:", "file:", "blob:", "about:"];
export function validateScheme(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  if (value.length > 256) return fallback;
  const lower = value.toLowerCase();
  for (const bad of DANGEROUS_SCHEME_PREFIXES) {
    if (lower.startsWith(bad)) return fallback;
  }
  if (!/^[a-z][a-z0-9+.\-]*:\/\/[A-Za-z0-9._\-/]+$/.test(value)) return fallback;
  return value;
}

// The bearer token rides through to the app as a query param on the deep
// link. We don't want to embed arbitrary attacker-controlled characters
// into the URL we set on `window.location.href`, so restrict to the
// printable character set that legitimate tokens use. Empty / invalid
// inputs simply drop the param — the app will route the user to /setup
// to paste the token by hand instead of silently saving garbage.
export function validateToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length > 512) return undefined;
  if (!/^[A-Za-z0-9._~+/=:-]+$/.test(value)) return undefined;
  return value;
}

export function clampMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(250, Math.min(10_000, Math.floor(n)));
}

// The deep-link interstitial only makes sense on platforms that can route
// a custom URL scheme (`gini://`) to an installed app. On a desktop
// browser the scheme handoff is guaranteed to fail and the "Opening
// Gini…" placeholder is just noise before the timed fallback ships the
// user to the web app. Server-render a `redirect()` to `webUrl` directly
// when the User-Agent isn't iOS / iPadOS / Android so the operator never
// sees the interstitial flicker — the mobile path keeps the existing
// scheme handoff + fallback machinery.
//
// iPadOS Safari (since iPadOS 13) sends a Mac-shaped User-Agent with no
// `iPad`/`Mobile` token, indistinguishable from macOS Safari. We accept
// macOS Safari too so iPad users with the native app get the scheme
// handoff. macOS Safari users without the app see a `DEFAULT_FALLBACK_MS`
// interstitial flicker before the client-side timed fallback ships them
// to the web app — acceptable tradeoff. Other Mac browsers (Chrome,
// Firefox, Edge) are excluded so they don't see the flicker.
export const MOBILE_UA_PATTERN =
  /\b(iPhone|iPad|iPod|Android)\b|Macintosh(?!.*Chrome).*Safari\//i;
export function userAgentLooksMobile(ua: string | null | undefined): boolean {
  if (!ua) return false;
  return MOBILE_UA_PATTERN.test(ua);
}
