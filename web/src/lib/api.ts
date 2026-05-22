// Plain relative paths. When the page is served through the cloudflared
// tunnel, the Next.js proxy sets a HttpOnly session cookie on the very
// first secret-bearing request; subsequent same-origin fetches travel
// authenticated by cookie, so JS never has to know about the secret
// prefix.
export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/runtime${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) }
  });
  const value = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value as T;
}

export function streamUrl(path: string): string {
  return `/api/runtime${path}`;
}
