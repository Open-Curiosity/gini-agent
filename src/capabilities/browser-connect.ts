// Headed-browser connect/disconnect capability. The runtime exposes three
// HTTP routes that delegate to the functions in this module:
//
//   GET  /api/browser              -> getBrowserConnection
//   POST /api/browser/connect      -> connectBrowser
//   POST /api/browser/disconnect   -> disconnectBrowser
//
// Two connection modes:
//
//   - "managed": no body or `{ port }` only. The runtime spawns a detached
//     Chrome with a dedicated --user-data-dir and --remote-debugging-port,
//     polls /json/version until it answers, and stores the resolved
//     webSocketDebuggerUrl in state.
//
//   - "cdp": body carries `{ cdpUrl }`. The runtime probes the supplied
//     CDP endpoint (replacing ws:// with http:// for the /json/version
//     probe) and stores the URL verbatim — minus any embedded credentials
//     in the redaction copy that lands in the audit row.
//
// The shape returned by all three handlers is `{ connected: boolean,
// record?: BrowserConnectionRecord }` so the CLI / webapp can render a
// uniform status card.

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { instanceRoot } from "../paths";
import { addAudit, mutateState, now, readState } from "../state";
import { findChromePath } from "../tools/chrome-discovery";
import { disconnectSharedBrowser } from "../tools/browser";
import type { BrowserConnectionRecord, RuntimeConfig } from "../types";

const DEFAULT_CDP_PORT = 9222;
// We poll the spawned Chrome's /json/version endpoint every 500ms for up
// to 15s. Chrome typically answers within a second on a warm system; the
// long ceiling covers cold starts, slower hardware, and the first run
// when Chrome migrates its prefs.
const PROBE_INTERVAL_MS = 500;
const PROBE_TIMEOUT_MS = 15_000;
// On disconnect we send SIGTERM and give Chrome 3 seconds to clean up
// before escalating to SIGKILL. Mirrors the headless-launch teardown
// budget in src/tools/browser.ts.
const SIGKILL_GRACE_MS = 3_000;

type Status = {
  connected: boolean;
  record?: BrowserConnectionRecord;
};

// Pinpointed view of the /json/version JSON. We only care about the
// webSocketDebuggerUrl when a managed launch finishes booting — the rest
// of the payload is metadata we don't use.
interface CdpVersionInfo {
  webSocketDebuggerUrl?: string;
  Browser?: string;
}

export function getBrowserConnection(config: RuntimeConfig): Status {
  const state = readState(config.instance);
  const record = state.browser ?? null;
  if (!record) return { connected: false };
  return { connected: true, record };
}

// Strip embedded `user:pass@` credentials before persisting a redacted
// form for audit / event logs. We never want a basic-auth-bearing ws:// URL
// to leak through the activity stream.
function redactUrlCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    }
    return url;
  } catch {
    // Not a valid URL — caller will already have failed validation, but
    // be defensive so we never echo raw input back into the audit row.
    return "<redacted>";
  }
}

function profileDirFor(config: RuntimeConfig): string {
  return join(instanceRoot(config.instance), "chrome-profile");
}

// HTTP probe of a CDP endpoint. The /json/version path returns Chrome's
// build info and the webSocketDebuggerUrl we'll later hand to Playwright.
// Returns the parsed body on success or null if the host did not respond
// with a JSON payload before the deadline.
async function probeCdp(httpUrl: string, deadlineMs: number): Promise<CdpVersionInfo | null> {
  const start = Date.now();
  while (Date.now() < start + deadlineMs) {
    try {
      const response = await fetch(`${httpUrl.replace(/\/$/, "")}/json/version`, {
        // AbortSignal.timeout keeps a single hung connection from eating
        // the entire poll budget.
        signal: AbortSignal.timeout(PROBE_INTERVAL_MS * 2)
      });
      if (response.ok) {
        const body = (await response.json()) as CdpVersionInfo;
        if (body && typeof body === "object") return body;
      }
    } catch {
      // Connection refused / network errors are expected during the
      // startup window — keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
  }
  return null;
}

// Maps a CDP ws://host:port/... URL onto its sibling http://host:port form
// for the /json/version probe. Falls back to the raw input if the URL
// parser rejects it (the caller will already have surfaced a validation
// error in that case).
function cdpHttpForm(cdpUrl: string): string {
  try {
    const parsed = new URL(cdpUrl);
    const proto = parsed.protocol === "wss:" ? "https:" : "http:";
    return `${proto}//${parsed.host}`;
  } catch {
    return cdpUrl;
  }
}

function validateCdpUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: `Invalid cdpUrl: ${raw}` };
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:" && parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `Unsupported cdpUrl protocol: ${parsed.protocol}` };
  }
  return { ok: true, url: parsed.toString() };
}

function validatePort(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${String(value)}`);
  }
  return port;
}

interface ConnectInput {
  port?: unknown;
  cdpUrl?: unknown;
}

// Idempotent connect. Mode is decided by whether the caller supplied a
// cdpUrl. We re-probe an existing record before returning it so a crashed
// Chrome doesn't appear as still-connected.
export async function connectBrowser(config: RuntimeConfig, input: ConnectInput): Promise<Status> {
  const existing = readState(config.instance).browser ?? null;
  if (existing) {
    const httpForm = cdpHttpForm(existing.cdpUrl);
    const probe = await probeCdp(httpForm, PROBE_INTERVAL_MS * 2);
    if (probe) {
      return { connected: true, record: existing };
    }
    // The previous endpoint is dead — clear it and fall through to a fresh
    // launch using whatever the caller asked for. We deliberately don't
    // try to SIGTERM the recorded pid here: the process is already gone
    // (probe failed) and we don't want to race a stale pid that's been
    // recycled by the OS to some unrelated process.
    await mutateState(config.instance, (state) => {
      state.browser = null;
    });
  }

  if (typeof input.cdpUrl === "string" && input.cdpUrl.length > 0) {
    return connectExisting(config, input.cdpUrl);
  }
  const port = validatePort(input.port, DEFAULT_CDP_PORT);
  return launchManaged(config, port);
}

async function connectExisting(config: RuntimeConfig, rawUrl: string): Promise<Status> {
  const validated = validateCdpUrl(rawUrl);
  if (!validated.ok) throw new Error(validated.error);
  const httpForm = cdpHttpForm(validated.url);
  const probe = await probeCdp(httpForm, PROBE_TIMEOUT_MS);
  if (!probe) {
    throw new Error(`Could not reach CDP endpoint at ${redactUrlCredentials(validated.url)}`);
  }
  const record: BrowserConnectionRecord = {
    mode: "cdp",
    cdpUrl: probe.webSocketDebuggerUrl ?? validated.url,
    pid: null,
    dataDir: null,
    chromePath: null,
    startedAt: now()
  };
  await mutateState(config.instance, (state) => {
    state.browser = record;
    addAudit(state, {
      actor: "user",
      action: "browser.connect",
      target: redactUrlCredentials(record.cdpUrl),
      risk: "medium",
      evidence: { mode: "cdp", browser: probe.Browser ?? null }
    });
  });
  return { connected: true, record };
}

async function launchManaged(config: RuntimeConfig, port: number): Promise<Status> {
  const chromePath = findChromePath();
  if (!chromePath) {
    throw new Error(
      "Could not locate a Chrome / Chromium / Edge install. " +
        "Install Google Chrome or set GINI_CHROME_PATH to the binary."
    );
  }
  const dataDir = profileDirFor(config);
  mkdirSync(dataDir, { recursive: true });

  const child: ChildProcess = spawn(
    chromePath,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${dataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Suppress the "restore previous session?" dialog that appears
      // after a SIGKILL. We don't restore state because the user signs in
      // fresh per connect anyway.
      "--disable-features=ChromeWhatsNewUI,Translate"
    ],
    {
      detached: true,
      stdio: "ignore"
    }
  );
  // detached + unref so the Chrome process keeps running past `gini run`
  // exits and isn't held onto by Node's event loop.
  child.unref();

  const pid = child.pid ?? null;
  const probe = await probeCdp(`http://127.0.0.1:${port}`, PROBE_TIMEOUT_MS);
  if (!probe || !probe.webSocketDebuggerUrl) {
    // Couldn't reach the launched browser. Best-effort cleanup before
    // surfacing the failure so we don't leave a zombie Chrome behind.
    if (pid !== null) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone — fine
      }
    }
    throw new Error(
      `Chrome started (pid ${pid ?? "?"}) but did not expose a CDP endpoint on port ${port} within ${Math.round(PROBE_TIMEOUT_MS / 1000)}s. ` +
        "Confirm the port is free and Chrome is allowed to bind to localhost."
    );
  }
  const record: BrowserConnectionRecord = {
    mode: "managed",
    cdpUrl: probe.webSocketDebuggerUrl,
    pid,
    dataDir,
    chromePath,
    startedAt: now()
  };
  await mutateState(config.instance, (state) => {
    state.browser = record;
    addAudit(state, {
      actor: "user",
      action: "browser.connect",
      target: dataDir,
      risk: "medium",
      evidence: { mode: "managed", pid, port, browser: probe.Browser ?? null }
    });
  });
  return { connected: true, record };
}

export async function disconnectBrowser(config: RuntimeConfig): Promise<Status> {
  const existing = readState(config.instance).browser ?? null;
  if (!existing) return { connected: false };

  // Drop the in-process Playwright handle BEFORE we kill the remote Chrome
  // so the next browser tool call re-evaluates state and launches a fresh
  // headless session instead of trying to talk to a dead CDP endpoint.
  await disconnectSharedBrowser();

  if (existing.mode === "managed" && existing.pid !== null) {
    await killManagedChrome(existing.pid);
  }

  await mutateState(config.instance, (state) => {
    state.browser = null;
    addAudit(state, {
      actor: "user",
      action: "browser.disconnect",
      target: existing.mode === "managed" ? existing.dataDir ?? "managed" : redactUrlCredentials(existing.cdpUrl),
      risk: "medium",
      evidence: { mode: existing.mode, pid: existing.pid }
    });
  });
  return { connected: false };
}

async function killManagedChrome(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone — record cleared below
    return;
  }
  // Wait for the process to actually exit. process.kill(pid, 0) is the
  // standard "is this PID alive?" probe — it throws ESRCH when there is
  // no such process. Spin up to SIGKILL_GRACE_MS before escalating.
  const deadline = Date.now() + SIGKILL_GRACE_MS;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already dead between the loop and here — fine.
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Internal helpers exported only for unit tests.
export const __test = {
  redactUrlCredentials,
  cdpHttpForm,
  validateCdpUrl,
  validatePort,
  profileDirFor,
  // Verifying the existsSync side effect of mkdirSync in tests would
  // require touching the real filesystem; the helper makes that observable.
  ensureProfileDir(config: RuntimeConfig): string {
    const dir = profileDirFor(config);
    mkdirSync(dir, { recursive: true });
    return dir;
  },
  exists: existsSync
};
