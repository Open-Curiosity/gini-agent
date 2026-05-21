// Login-shell PATH discovery helpers.
//
// Why this exists: when `gini autostart enable` writes the launchd plist,
// the baked-in PATH (see src/cli/autostart.ts:buildLaunchAgentPath) is
// the standard macOS set plus bun's dir and `~/.local/bin`. That set
// deliberately excludes per-user installer paths like
// `~/.nvm/versions/node/<v>/bin`, `~/.asdf/shims`, `~/.volta/bin`,
// pyenv, rbenv, etc. — but most CLI tools the agent shells out to
// (codex, claude as npm globals; gh on Linux via brew; …) live under
// one of those managers. Result: the launchd-spawned gateway can't see
// the binary even though `which codex` works fine in the user's
// terminal, and every PATH-sensitive lookup (provider probes, Bash
// tool, `codex exec`, …) fails quietly.
//
// We can't fix this at runtime: Bun's `spawnSync` snapshots PATH at
// process start, so mutating `process.env.PATH` after the gateway is
// already running doesn't propagate to subprocesses. The fix has to
// land in the plist itself.
//
// This module exposes the building blocks the autostart plist writer
// uses to merge the user's interactive-shell PATH into the plist's
// EnvironmentVariables. The merge runs at `gini autostart enable`
// time. If the user later switches node versions (or installs a new
// path manager), they re-run `gini autostart enable` to refresh.
//
// Best-effort: a failing or hanging shell never blocks plist
// generation. 3s timeout, falls back to the original PATH on any
// error.

import { spawnSync } from "node:child_process";

const SHELL_PATH_TIMEOUT_MS = 3_000;

// Sentinel markers wrap the PATH value so noisy `.zshrc`/`.bashrc`
// stdout (welcome banners, version checks, etc.) printed before our
// own command runs can't corrupt the captured PATH. We extract only
// the segment between the markers and discard everything else.
//
// The markers are deliberately ugly so they never collide with a real
// PATH segment. They're literal in the shell command, not interpolated
// — keeps them safe even under weird shell quoting.
const PATH_BEGIN = "__GINI_PATH_BEGIN__";
const PATH_END = "__GINI_PATH_END__";

// Bare-minimum env the shell needs to start cleanly without inheriting
// our process's PATH (which on a Conductor machine includes transient
// Conductor / Codex / package-script dirs that would otherwise get
// baked into the LaunchAgent plist forever). The shell's rc files add
// nvm / asdf / volta dirs on top of this floor.
//
// TERM=dumb defangs `.zshrc` hooks that probe terminal capabilities or
// print prompts.
const CLEAN_SHELL_PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export type LoginShellReader = (shell: string) => string | null;

export interface ReadShellOptions {
  // Override the base PATH the shell starts with. Defaults to a
  // controlled CLEAN_SHELL_PATH so transient dirs from the calling
  // process don't pollute the plist. Tests can pass a custom value.
  basePath?: string;
  // Override $HOME the shell sees. Defaults to process.env.HOME.
  home?: string;
}

// Run `$SHELL -ilc 'printf BEGIN%sEND $PATH'` synchronously and return
// the PATH between the sentinels. Returns null on timeout, non-zero
// exit, or no markers in output. `-i` + `-l` together mirror what a
// fresh terminal window does — users put nvm/asdf init in either
// `.zshrc` (interactive) or `.zprofile` / `.bash_profile` (login),
// and we want to pick up both.
//
// Stderr is suppressed so rc-file warnings don't bleed into caller
// logs. Stdout is captured but only the part between PATH_BEGIN and
// PATH_END is treated as the PATH value — anything outside (rc-file
// banners, etc.) is discarded.
export const readLoginShellPath: LoginShellReader & {
  (shell: string, options?: ReadShellOptions): string | null;
} = (shell: string, options: ReadShellOptions = {}) => {
  const basePath = options.basePath ?? CLEAN_SHELL_PATH;
  const home = options.home ?? process.env.HOME ?? "";
  const env: Record<string, string> = {
    PATH: basePath,
    HOME: home,
    SHELL: shell,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TERM: "dumb"
  };
  const command = `printf '%s' '${PATH_BEGIN}'; printf '%s' "$PATH"; printf '%s' '${PATH_END}'`;
  const result = spawnSync(shell, ["-ilc", command], {
    encoding: "utf8",
    timeout: SHELL_PATH_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"],
    env
  });
  if (result.status !== 0) return null;
  return extractBetweenSentinels(result.stdout ?? "");
};

// Pull the PATH out of stdout. Tolerant of noise on either side. The
// sentinels appear exactly once per successful run; if neither one is
// present, we couldn't find a real PATH and return null rather than
// guessing.
function extractBetweenSentinels(stdout: string): string | null {
  const start = stdout.indexOf(PATH_BEGIN);
  if (start === -1) return null;
  const valueStart = start + PATH_BEGIN.length;
  const end = stdout.indexOf(PATH_END, valueStart);
  if (end === -1) return null;
  const trimmed = stdout.slice(valueStart, end).trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Prepend any entries in `shellPath` that aren't already in `basePath`,
// preserving the relative order of both inputs. Existing entries keep
// their position; new entries land at the front so user-controlled
// dirs (nvm, asdf, …) shadow any system equivalents that happen to
// sit on the launchd-baked PATH.
//
// Filters:
//   - Blank segments are dropped.
//   - Non-absolute segments (e.g. `node_modules/.bin`, `.`) are dropped.
//     A long-lived launchd-supervised gateway resolves these relative
//     to its working directory; that's never what we want for a tool
//     lookup. The shell calling this might include them, but they
//     don't belong in a permanent plist.
export interface MergeReport {
  merged: string;
  added: string[];
}

export function mergeShellPath(basePath: string, shellPath: string): MergeReport {
  const baseSegments = basePath.split(":").map((s) => s.trim()).filter(Boolean);
  const shellSegments = shellPath
    .split(":")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.startsWith("/"));
  const seen = new Set(baseSegments);
  const added: string[] = [];
  for (const segment of shellSegments) {
    if (seen.has(segment)) continue;
    seen.add(segment);
    added.push(segment);
  }
  const merged = [...added, ...baseSegments].join(":");
  return { merged, added };
}

export const __testing = {
  PATH_BEGIN,
  PATH_END,
  CLEAN_SHELL_PATH,
  extractBetweenSentinels
};
