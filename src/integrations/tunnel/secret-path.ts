// Per-instance secret URL prefix that gates tunneled requests.
//
// The trust model: when the gateway is reachable through a public Cloudflare
// quick tunnel, the URL itself is the credential. A request whose pathname
// begins with `/<secret>/` is treated as fully authorized; the prefix is
// stripped before the rest of the routing layer sees the URL. Direct
// localhost access continues to use the bearer token in
// `src/governance/pairing.ts` and is untouched by this module.
//
// Secret material is 192 bits of cryptographically random data, base64url
// encoded (32 characters). The short string keeps the displayed URL compact
// while staying well above any brute-force ceiling for an attacker who
// learns the tunnel hostname before cloudflared rotates it on the next
// restart.

/**
 * Generate a fresh URL-safe secret. 32 characters of base64url.
 */
export function generateSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * Format a path segment safely. Returns `null` when the input does not look
 * like base64url material — used to validate persisted secrets before they
 * are wired into the request guard.
 */
export function normalizeSecret(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length < 16 || trimmed.length > 128) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Build the full prefix string a tunneled request must match. Always shaped
 * as `/<secret>/` so equality + prefix tests stay obvious at call sites.
 */
export function tunnelPathPrefix(secret: string): string {
  return `/${secret}/`;
}

/**
 * Returns the pathname remainder when `pathname` matches the tunnel prefix
 * for `secret`, or `null` when it does not. The bare `/<secret>` form (no
 * trailing slash) is reported separately via `stripTunnelPrefixWithKind`
 * because callers must redirect to the slash form before serving the
 * landing — otherwise relative links on that landing resolve against
 * `/` instead of `/<secret>/` and lose the prefix.
 */
export function stripTunnelPrefix(pathname: string, secret: string): string | null {
  const prefix = tunnelPathPrefix(secret);
  if (pathname.startsWith(prefix)) return pathname.slice(prefix.length - 1);
  return null;
}

/**
 * Detect whether `pathname` is the bare-secret form (no trailing slash).
 * The HTTP guard uses this to 301 the browser to `/<secret>/` so links
 * like `./api/status` rendered on the landing page resolve to
 * `/<secret>/api/status` instead of `/api/status`.
 */
export function isBareTunnelPrefix(pathname: string, secret: string): boolean {
  return pathname === `/${secret}`;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
