import { spawn, type ChildProcess } from "node:child_process";

// Spawn cloudflared as a quick tunnel forwarding to 127.0.0.1:<port>, parse
// the public URL out of stderr's banner, and provide a SIGTERM-with-SIGKILL
// fallback for teardown. See PLAN.md "Operational invariants".

export interface CloudflaredLaunch {
  process: ChildProcess;
  /** Resolves with the public URL once cloudflared prints its banner. */
  publicUrl: Promise<string>;
  /** Stop the process. Sends SIGTERM, then SIGKILL after the cap. */
  stop(): Promise<void>;
}

const URL_REGEX = /https?:\/\/[A-Za-z0-9.-]+\.trycloudflare\.com/;
const TERMINATE_CAP_MS = 5_000;

export interface LaunchOptions {
  /** Override the binary path. Defaults to `cloudflared` from PATH. */
  bin?: string;
  /** Web port cloudflared forwards to. */
  port: number;
  /** Bound on banner-parse time. */
  bannerTimeoutMs?: number;
}

export function launchCloudflared(opts: LaunchOptions): CloudflaredLaunch {
  const bin = opts.bin ?? "cloudflared";
  const args = [
    "tunnel",
    "--no-autoupdate",
    "--protocol", "http2",
    "--url", `http://127.0.0.1:${opts.port}`
  ];
  const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

  let resolveUrl!: (url: string) => void;
  let rejectUrl!: (err: Error) => void;
  const publicUrl = new Promise<string>((res, rej) => {
    resolveUrl = res;
    rejectUrl = rej;
  });

  const timeoutMs = opts.bannerTimeoutMs ?? 30_000;
  const bannerTimer = setTimeout(() => rejectUrl(new Error("cloudflared banner timeout")), timeoutMs);

  const parseChunk = (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const m = text.match(URL_REGEX);
    if (m) {
      clearTimeout(bannerTimer);
      resolveUrl(m[0]);
    }
  };
  proc.stdout?.on("data", parseChunk);
  proc.stderr?.on("data", parseChunk);
  proc.on("error", (err) => {
    clearTimeout(bannerTimer);
    rejectUrl(err);
  });
  proc.on("exit", (code) => {
    clearTimeout(bannerTimer);
    // If we never observed a banner before exit, fail the promise so the
    // caller's apply path surfaces the error rather than hanging.
    rejectUrl(new Error(`cloudflared exited with code ${code ?? "?"} before banner`));
  });

  const stop = async (): Promise<void> => {
    if (proc.exitCode !== null) return;
    proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* already gone */ }
        resolve();
      }, TERMINATE_CAP_MS);
      proc.on("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  };

  return { process: proc, publicUrl, stop };
}
