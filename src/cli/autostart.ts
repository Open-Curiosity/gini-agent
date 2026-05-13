// macOS LaunchAgent integration: write a per-instance plist, register it
// with `launchctl bootstrap gui/<uid>`, and tear it down with `launchctl
// bootout`.
//
// What this exists for: after `gini install` runs, the user expects the
// runtime to be running and to stay running across crashes and logins. On
// macOS the supported way to achieve that for a per-user, foreground-session
// service is a user-domain LaunchAgent under ~/Library/LaunchAgents/. System
// daemons (~/.../Library/LaunchDaemons/) can't reach the user's Keychain,
// which would break Codex auth.
//
// Scope notes:
//   - macOS only in v1. Linux systemd --user parity is a follow-up.
//   - PID supervision only (launchd's default). A health watchdog that hits
//     /api/healthz to detect wedged-but-alive Bun is OUT of v1 — `status`
//     and `--help` surface that limitation so users know what they're
//     getting.
//   - `gini stop` exits with the server SIGTERM handler doing process.exit(0),
//     which feeds launchd's `KeepAlive.SuccessfulExit: false` semantics:
//     clean exits are treated as the user's intent and are NOT respawned;
//     anything else triggers a respawn.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Instance } from "../types";
import { projectRoot } from "../paths";

export const LABEL_PREFIX = "ai.lilac.gini";

export function labelFor(instance: Instance): string {
  return `${LABEL_PREFIX}.${instance}`;
}

export function plistPathFor(instance: Instance): string {
  const home = process.env.HOME || homedir();
  return join(home, "Library", "LaunchAgents", `${labelFor(instance)}.plist`);
}

// Returns the "gui/<uid>" service target launchctl understands. The uid is
// the current effective user. We read it from process.getuid because that's
// what the installed wrapper's domain will be at runtime; reading USER from
// the env can desync after `su` / sudo.
export function guiDomain(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return `gui/${uid}`;
}

export function serviceTarget(instance: Instance): string {
  return `${guiDomain()}/${labelFor(instance)}`;
}

export interface LaunchSpec {
  // What launchd will exec. In installed-flow this is just the wrapper plus
  // run + --instance; in source-flow it's bun + entry script + run + flags.
  programArguments: string[];
  // Directory the runtime resolves project paths from. In installed-flow
  // that's ~/.gini/runtime (so `bun run` uses the right package.json);
  // in source-flow it's the repo root.
  workingDirectory: string;
  // PATH must include bun's dir so the wrapper can find it. We avoid bare
  // exec of a brittle absolute path so users who upgrade bun keep working.
  environment: Record<string, string>;
}

export interface ResolveLaunchOptions {
  instance: Instance;
  // Test seam: override the file-existence checks. Defaults wired to the
  // real filesystem in resolveLaunchSpec.
  fileExists?: (path: string) => boolean;
  // Test seam: pretend $HOME is somewhere else. Defaults to process.env.HOME
  // or os.homedir().
  homeOverride?: string;
  // Test seam: pretend a different bun is on PATH. Defaults to
  // process.execPath, which is correct under both `bun run` and a compiled
  // bun-driven entry.
  bunPathOverride?: string;
  // Test seam: pretend a different project root. Defaults to projectRoot().
  projectRootOverride?: string;
}

// Build the launchd command line. We exec the Bun-driven runtime *directly*
// — `bun run src/server.ts --instance <name>` — instead of going through the
// `~/.local/bin/gini` wrapper or `gini run`. Two reasons:
//
//   1. Single-process job. The wrapper/CLI path spawns a chain
//      (bash → bun → bun → bun-server). When launchd kills the head, child
//      processes can outlive the head briefly and exit cleanly via their
//      own SIGTERM handlers; launchd then sees a "successful exit" for the
//      job and KeepAlive.SuccessfulExit:false suppresses respawn. Direct
//      exec collapses the tree to one process, so SIGKILL = signal exit
//      and KeepAlive respawns reliably.
//
//   2. Exit code is what we control. The server's SIGTERM handler
//      (src/server.ts) does process.exit(0), so `launchctl stop` (or
//      `gini stop` SIGTERM) produces a clean exit; KeepAlive.SuccessfulExit:false
//      then honors that intent and won't respawn.
//
// The runtimeDir vs repoRoot decision still matters because that's where
// `bun run` finds package.json / src/. Installed flow → ~/.gini/runtime.
// Source flow → the project root we were invoked from. We sanity-check
// that runtimeDir actually has a runtime checkout before trusting it.
export function resolveLaunchSpec(options: ResolveLaunchOptions): LaunchSpec {
  const fileExists = options.fileExists ?? existsSync;
  const home = options.homeOverride ?? process.env.HOME ?? homedir();
  const bunPath = options.bunPathOverride ?? process.execPath;
  const repoRoot = options.projectRootOverride ?? projectRoot();
  const runtimeDir = join(home, ".gini", "runtime");

  const runtimeUsable = fileExists(join(runtimeDir, "package.json"))
    && fileExists(join(runtimeDir, "src", "server.ts"));

  // Always make bun's directory available on PATH so child invocations
  // (e.g. `bun install` triggers from inside the runtime) can resolve it.
  // macOS launchd hands the service a minimal PATH; we explicitly extend
  // it rather than copy the parent shell's because the agent must work
  // across reboots too.
  const baseEnv: Record<string, string> = {
    PATH: buildLaunchAgentPath(bunPath, home),
    HOME: home,
    LANG: process.env.LANG ?? "en_US.UTF-8"
  };
  // Propagate state/log root overrides so an `autostart enable` invoked
  // with GINI_STATE_ROOT=/tmp/... (e2e test, parallel agent) embeds the
  // same override in the plist. Without this, the launchd-spawned runtime
  // would happily fall back to ~/.gini and trample the developer's real
  // install. Production installs leave these env vars unset, so the
  // embedded record is empty and the runtime uses the standard layout.
  if (process.env.GINI_STATE_ROOT) baseEnv.GINI_STATE_ROOT = process.env.GINI_STATE_ROOT;
  if (process.env.GINI_LOG_ROOT) baseEnv.GINI_LOG_ROOT = process.env.GINI_LOG_ROOT;

  const workingDirectory = runtimeUsable ? runtimeDir : repoRoot;
  return {
    programArguments: [bunPath, "run", "src/server.ts", "--instance", options.instance],
    workingDirectory,
    environment: { ...baseEnv, GINI_INSTANCE: options.instance }
  };
}

function buildLaunchAgentPath(bunPath: string, home: string): string {
  const bunDir = dirname(resolve(bunPath));
  // Standard macOS PATH plus bun's dir. ~/.local/bin is included so the
  // wrapper itself is findable.
  const segments = [
    bunDir,
    `${home}/.local/bin`,
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ];
  // Dedupe while preserving order.
  const seen = new Set<string>();
  return segments.filter((s) => {
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  }).join(":");
}

export interface PlistOptions {
  instance: Instance;
  spec: LaunchSpec;
  // Where stdout/stderr go. Defaults are derived from the project's per-
  // instance log dir (runtime-stdout.log), matching what `gini start` writes.
  stdoutPath: string;
  stderrPath: string;
  // ThrottleInterval bounds how aggressively launchd respawns a crashing
  // service. 10s keeps a crashloop from melting CPU without making clean-stop
  // recovery painfully slow.
  throttleIntervalSeconds?: number;
}

export function generatePlist(options: PlistOptions): string {
  const throttle = options.throttleIntervalSeconds ?? 10;
  const label = labelFor(options.instance);
  const args = options.spec.programArguments.map(escapeXml).map((a) => `        <string>${a}</string>`).join("\n");
  const envEntries = Object.entries(options.spec.environment)
    .map(([key, value]) => `        <key>${escapeXml(key)}</key>\n        <string>${escapeXml(value)}</string>`)
    .join("\n");

  // Per the ADR-style decisions in /tmp/claude-context-gini-autostart.md:
  //   - KeepAlive is a dict (not bool). SuccessfulExit:false means a clean
  //     `gini stop` (exit 0) is NOT respawned; anything non-zero IS.
  //   - ThrottleInterval:10 caps crashloop CPU.
  //   - RunAtLoad:true means it starts at user login.
  //
  // NetworkState was considered (would gate first-boot launches until the
  // network came up) but launchd treats NetworkState as a *pended-spawn
  // semaphore*: even after a non-zero exit, the next spawn waits for a
  // network-state transition, which doesn't fire when the network was
  // already up. Empirically that prevents respawn-after-SIGKILL entirely.
  // The runtime tolerates a network-not-yet-up startup (provider auth
  // retries with backoff), so dropping NetworkState gets us the contract
  // that matters — clean `gini stop` honored, crash respawned.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(label)}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeXml(options.spec.workingDirectory)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>${throttle}</integer>
    <key>StandardOutPath</key>
    <string>${escapeXml(options.stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(options.stderrPath)}</string>
    <key>ProcessType</key>
    <string>Interactive</string>
</dict>
</plist>
`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface WritePlistOptions {
  instance: Instance;
  spec: LaunchSpec;
  stdoutPath: string;
  stderrPath: string;
  throttleIntervalSeconds?: number;
}

export function writePlist(options: WritePlistOptions): string {
  const path = plistPathFor(options.instance);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, generatePlist(options));
  return path;
}

export interface LaunchctlResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
}

function runLaunchctl(args: string[]): LaunchctlResult {
  const res = spawnSync("launchctl", args, { encoding: "utf8" });
  return {
    ok: res.status === 0,
    stdout: (res.stdout ?? "").toString(),
    stderr: (res.stderr ?? "").toString(),
    status: res.status ?? null
  };
}

// Probe whether launchctl knows the service. `launchctl print` returns
// non-zero when the label isn't loaded; we treat that as "not loaded".
export function isLoaded(instance: Instance): boolean {
  const res = runLaunchctl(["print", serviceTarget(instance)]);
  return res.ok;
}

// Read the live PID launchctl thinks the service is running as. Returns
// null if launchctl doesn't know about it OR the service is registered
// but not currently running (e.g. crashed inside ThrottleInterval). Used
// for status output.
export function loadedPid(instance: Instance): number | null {
  const res = runLaunchctl(["print", serviceTarget(instance)]);
  if (!res.ok) return null;
  // `launchctl print` output includes a `pid = NNN` line when running.
  // Format is stable across macOS 11+.
  const match = res.stdout.match(/^\s*pid\s*=\s*(\d+)/m);
  return match && match[1] ? Number(match[1]) : null;
}

// Read the last exit signal/status if launchctl recorded one. Useful for
// telling the user "service was running but exited with 1" in `status`.
export function loadedLastExitStatus(instance: Instance): string | null {
  const res = runLaunchctl(["print", serviceTarget(instance)]);
  if (!res.ok) return null;
  const match = res.stdout.match(/^\s*last exit code\s*=\s*(.+)$/m);
  return match && match[1] ? match[1].trim() : null;
}

export function bootstrap(instance: Instance, plistPath: string): LaunchctlResult {
  return runLaunchctl(["bootstrap", guiDomain(), plistPath]);
}

export function bootout(instance: Instance): LaunchctlResult {
  return runLaunchctl(["bootout", serviceTarget(instance)]);
}

export function kickstart(instance: Instance): LaunchctlResult {
  // `kickstart -k` forces a stop+start, used by `autostart enable` when the
  // service is already loaded so an updated plist takes effect immediately.
  return runLaunchctl(["kickstart", "-k", serviceTarget(instance)]);
}

export function platformIsSupported(): boolean {
  return process.platform === "darwin";
}

export function unsupportedPlatformMessage(): string {
  return `gini autostart is macOS-only in v1 (current platform: ${process.platform}). ` +
    `Linux systemd --user parity is a follow-up.`;
}

export const __testing = {
  buildLaunchAgentPath,
  escapeXml
};
