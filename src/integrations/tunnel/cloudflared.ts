// Cloudflare Quick Tunnel subprocess manager.
//
// `cloudflared tunnel --url http://127.0.0.1:<port>` opens an anonymous public
// HTTPS tunnel to a localhost origin. The binary writes a banner to stderr
// shortly after start that contains a `https://<words>.trycloudflare.com`
// URL — that URL is the only published handle for the tunnel, and it rotates
// every restart. This module owns spawning, parsing the URL, observing the
// child for exit, and tearing it down cleanly on shutdown.
//
// The tunnel itself is unauthenticated; the gateway gates requests by URL
// prefix (see secret-path.ts) so the URL alone is enough to grant access
// to anyone holding it. Cloudflare's quick tunnels rotate on every restart,
// so leaked URLs do not survive the next gateway boot.

import { mkdirSync } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

export interface SpawnTunnelOptions {
  /** Where cloudflared should send its origin requests. */
  targetUrl: string;
  /** Path to the `cloudflared` binary. Defaults to `cloudflared` on PATH. */
  binary?: string;
  /** Append cloudflared's stderr to this file (created if absent). */
  logPath?: string;
  /** Cap on how long to wait for the first URL to appear. Defaults to 25s. */
  startupTimeoutMs?: number;
  /**
   * Optional abort signal. When triggered, the in-flight spawn rejects
   * promptly, the cloudflared child is SIGTERM'd, and the log handle is
   * closed. Used by the TunnelManager so a SIGTERM in the gateway's
   * shutdown drain can cancel a pending spawn without waiting for the
   * full `startupTimeoutMs`.
   */
  signal?: AbortSignal;
  /**
   * Injectable spawner for tests. Receives the resolved command + args and
   * must return a Bun-compatible Subprocess. The default uses Bun.spawn.
   */
  spawn?: (command: string[], opts: { stderr: "pipe"; stdout: "ignore" | "inherit" }) =>
    {
      readonly stderr: ReadableStream<Uint8Array> | null;
      readonly exited: Promise<number>;
      kill(signal?: string | number): void;
      readonly pid?: number;
    };
  /**
   * Strings to scrub from stderr before persisting to the log file.
   * cloudflared logs per-request error lines that include the full
   * destination URL — when the gateway pairs cloudflared with a
   * secret-path scheme, that URL embeds the secret. Without this
   * redaction the on-disk log carries the live credential, which a
   * helpful "share the log" support-debug message can leak. The
   * TunnelManager passes the active secret here so a leaked log
   * doesn't double as a leaked tunnel URL.
   */
  redactStrings?: readonly string[];
}

const REDACTED_PLACEHOLDER = "[redacted]";

function redactBytes(value: Uint8Array, redactStrings: readonly string[] | undefined): Uint8Array {
  if (!redactStrings || redactStrings.length === 0) return value;
  // The redact strings are ASCII (base64url secret characters); decoding
  // as UTF-8 + replace + re-encode is safe for the substrings we care
  // about. A multi-byte UTF-8 sequence split across chunks could only
  // affect surrounding bytes that aren't part of any redact string.
  let text = new TextDecoder().decode(value);
  for (const secret of redactStrings) {
    if (!secret) continue;
    text = text.replaceAll(secret, REDACTED_PLACEHOLDER);
  }
  return new TextEncoder().encode(text);
}

export interface TunnelHandle {
  /** The parsed `https://<...>.trycloudflare.com` URL. */
  url: string;
  /** PID of the cloudflared process, when the spawner exposed one. */
  pid: number | undefined;
  /** Resolves when the child process exits, with its exit code. */
  exited: Promise<number>;
  /** Send SIGTERM; resolves once `exited` settles. */
  stop(): Promise<void>;
}

/**
 * Spawn cloudflared and wait for it to advertise a public URL. The returned
 * handle keeps the subprocess alive; call `stop()` to tear it down.
 *
 * @throws if the subprocess exits before producing a URL, or if the
 * startup timeout elapses.
 */
export async function spawnQuickTunnel(options: SpawnTunnelOptions): Promise<TunnelHandle> {
  // Honour the abort signal BEFORE spawning. A SIGTERM or disable PATCH
  // that landed between options being constructed and this function
  // being entered would otherwise still cause cloudflared to spawn —
  // the abort listener registered later would only fire after the
  // child was already running, leaving a brief window where the
  // public tunnel went live despite the operator's intent.
  if (options.signal?.aborted) {
    throw new Error("cloudflared spawn aborted");
  }
  const binary = options.binary ?? "cloudflared";
  const command = [binary, "tunnel", "--no-autoupdate", "--url", options.targetUrl];
  const spawner = options.spawn ?? defaultSpawner;
  const child = spawner(command, { stderr: "pipe", stdout: "ignore" });

  let logHandle: FileHandle | null = null;
  if (options.logPath) {
    try {
      mkdirSync(dirname(options.logPath), { recursive: true });
      logHandle = await open(options.logPath, "a");
    } catch {
      logHandle = null;
    }
  }
  // Re-check the abort signal after the log-open await: the operator
  // may have flipped disable while we awaited the file handle. The
  // race below catches a CONCURRENT abort, but an abort that already
  // settled by the time the race starts would otherwise be missed.
  if (options.signal?.aborted) {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
    if (logHandle) {
      try { await logHandle.close(); } catch { /* ignore */ }
    }
    throw new Error("cloudflared spawn aborted");
  }

  // The parser resolves with the URL plus a `drained` promise that
  // settles when the background drainer finishes reading stderr. We
  // need to await that drainer before closing the log handle on exit,
  // otherwise the last few stderr lines (usually the most diagnostic
  // info about why cloudflared crashed) get dropped because the
  // drainer's pending `log.write()` throws "file closed" after we
  // close the handle.
  let drained: Promise<void> = Promise.resolve();
  const urlPromise = parseUrlFromStderr(child.stderr, logHandle, options.redactStrings).then((result) => {
    drained = result.drained;
    return result.url;
  });
  const timeoutMs = options.startupTimeoutMs ?? 25_000;

  // Externally-aborted spawn: the parent runtime can cancel before
  // either the URL arrives or the timeout elapses. Wrap the abort in a
  // promise alongside the rest of the race so cleanup runs through the
  // shared catch path.
  const abortPromise = new Promise<never>((_, reject) => {
    if (!options.signal) return;
    if (options.signal.aborted) {
      reject(new Error("cloudflared spawn aborted"));
      return;
    }
    options.signal.addEventListener(
      "abort",
      () => reject(new Error("cloudflared spawn aborted")),
      { once: true }
    );
  });

  let url: string;
  try {
    url = await Promise.race([
      urlPromise,
      child.exited.then((code) => {
        throw new Error(`cloudflared exited before advertising a URL (code ${code})`);
      }),
      Bun.sleep(timeoutMs).then(() => {
        throw new Error(`cloudflared did not advertise a URL within ${timeoutMs}ms`);
      }),
      abortPromise
    ]);
  } catch (error) {
    // Clean up before the throw escapes: kill the child if it's still
    // running and close the log handle. Without this, a startup-timeout
    // path leaves cloudflared running in the background indefinitely,
    // and the open file descriptor leaks until GC eventually finalises
    // the handle. Both kills are best-effort — a kill against a child
    // that already exited is harmless.
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
    try {
      await Promise.race([child.exited, Bun.sleep(2_000)]);
    } catch { /* ignore */ }
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
    if (logHandle) {
      try { await logHandle.close(); } catch { /* ignore */ }
      logHandle = null;
    }
    // Swallow the orphaned urlPromise so its eventual rejection (the
    // stream closes after kill) does not surface as an unhandled
    // rejection later in the event loop.
    void urlPromise.catch(() => {});
    throw error;
  }

  const handle: TunnelHandle = {
    url,
    pid: child.pid,
    exited: child.exited.finally(async () => {
      if (logHandle) {
        // Wait for the background drainer to finish before closing the
        // log handle, so the tail of stderr — which often carries the
        // most diagnostic info about why cloudflared crashed — actually
        // lands in the log. Bounded to 1s so a misbehaving cloudflared
        // can't block gateway shutdown indefinitely.
        try {
          await Promise.race([drained, Bun.sleep(1_000)]);
        } catch { /* drainer errors are already swallowed */ }
        // Best-effort close; failure is non-fatal.
        try { await logHandle.close(); } catch { /* ignore */ }
        logHandle = null;
      }
    }),
    async stop() {
      try { child.kill("SIGTERM"); } catch { /* already exited */ }
      try {
        await Promise.race([
          child.exited,
          Bun.sleep(5_000).then(() => { child.kill("SIGKILL"); return child.exited; })
        ]);
      } catch {
        // child.exited never rejects, but defensive in case the spawner does.
      }
    }
  };
  return handle;
}

/**
 * Pull bytes off `stream` until a `https://*.trycloudflare.com` URL appears.
 * Exposed for unit tests so the parser can be exercised without spawning a
 * subprocess.
 */
export async function readTunnelUrlFromStream(
  stream: ReadableStream<Uint8Array> | null
): Promise<string> {
  if (!stream) throw new Error("cloudflared stderr is not piped");
  const result = await parseUrlFromStderr(stream, null, undefined);
  return result.url;
}

/**
 * Extract the public URL from one or more lines of cloudflared output. The
 * banner wraps the URL inside box-drawing characters, so we strip leading
 * decoration before matching.
 */
export function extractTunnelUrl(line: string): string | null {
  // Two known shapes:
  //  - 2024-01-01T00:00:00Z INF |  https://words-here.trycloudflare.com  |
  //  - https://words-here.trycloudflare.com (some structured-log paths)
  const match = line.match(/https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i);
  return match ? match[0] : null;
}

async function parseUrlFromStderr(
  stream: ReadableStream<Uint8Array> | null,
  log: FileHandle | null,
  redactStrings: readonly string[] | undefined
): Promise<{ url: string; drained: Promise<void> }> {
  if (!stream) throw new Error("cloudflared stderr is not piped");
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (log) await log.write(Buffer.from(redactBytes(value, redactStrings)));
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const url = extractTunnelUrl(line);
      if (url) {
        // Release the reader and immediately re-acquire a drainer so
        // stderr keeps flowing — either into the log file when one is
        // configured, or just to /dev/null when not. Without draining,
        // the OS pipe buffer (64 KiB on macOS and Linux) saturates and
        // cloudflared's writer blocks, eventually deadlocking the
        // subprocess.
        try { reader.releaseLock(); } catch { /* ignore */ }
        const drained = keepDraining(stream, log, redactStrings);
        return { url, drained };
      }
      nl = buffer.indexOf("\n");
    }
  }
  throw new Error("cloudflared stderr closed before a URL appeared");
}

function keepDraining(stream: ReadableStream<Uint8Array>, log: FileHandle | null, redactStrings: readonly string[] | undefined): Promise<void> {
  // Continue reading stderr without blocking startup. When a log handle
  // is provided we copy bytes into it; without one we discard. Errors
  // are swallowed so a closed log or stream can't keep the process
  // alive after exit. The returned promise settles when the stream
  // closes (or errors), so callers can await it before closing the log
  // handle to avoid losing the tail of stderr.
  return (async () => {
    try {
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (log) await log.write(Buffer.from(redactBytes(value, redactStrings)));
      }
    } catch {
      /* ignore */
    }
  })();
}

function defaultSpawner(
  command: string[],
  opts: { stderr: "pipe"; stdout: "ignore" | "inherit" }
): ReturnType<NonNullable<SpawnTunnelOptions["spawn"]>> {
  // Bun's Subprocess shape is broader than the minimal interface we expose
  // to consumers; the cast narrows the return type without leaking
  // Bun-specific shape into callers.
  const child = Bun.spawn(command, { ...opts, stdin: "ignore" });
  return child as unknown as ReturnType<NonNullable<SpawnTunnelOptions["spawn"]>>;
}
