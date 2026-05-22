// Recognize the tunnel secret URL prefix when the page is being served
// through cloudflared. The Next.js proxy rewrites `/<secret>/<rest>` →
// `/<rest>` internally but the browser's URL bar still shows the
// prefix, so relative paths like `/api/runtime/...` issued from the
// page would arrive at the proxy without the prefix and 404 (the proxy
// now gates ALL paths on the prefix for non-localhost hosts so a leaked
// trycloudflare hostname does not grant authenticated API access).
// Read the prefix off `window.location.pathname` and re-attach it to
// every API call so the BFF receives the secret-stripped path it
// expects.
function tunnelPrefix(): string {
  if (typeof window === "undefined") return "";
  const match = window.location.pathname.match(/^(\/[A-Za-z0-9_-]{16,128})\//);
  return match ? match[1] : "";
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${tunnelPrefix()}/api/runtime${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) }
  });
  const value = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value as T;
}

export function streamUrl(path: string): string {
  return `${tunnelPrefix()}/api/runtime${path}`;
}
