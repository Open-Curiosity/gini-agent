// Plain relative paths. When the page is served through the cloudflared
// tunnel, the Next.js proxy sets a HttpOnly session cookie on the very
// first secret-bearing request; subsequent same-origin fetches travel
// authenticated by cookie, so JS never has to know about the secret
// prefix.

// Distinct subclass for HTTP-level failures (4xx/5xx). Callers can use
// `instanceof HttpError` to separate "the server replied with an error
// status" (a real failure with a meaningful body) from "fetch never
// got a response" (network failure / abort / TypeError) — which matter
// to the tunnel toggle whose disable path can self-sever the response
// channel. The default `Error` shape stays for non-HTTP failures so a
// dropped connection still surfaces as a plain Error to onError.
export class HttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/runtime${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) }
  });
  const value = (await response.json()) as { error?: string };
  if (!response.ok) throw new HttpError(value.error ?? `HTTP ${response.status}`, response.status);
  return value as T;
}

export function streamUrl(path: string): string {
  return `/api/runtime${path}`;
}
