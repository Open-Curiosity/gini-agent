import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import type { Lane, RuntimeConfig } from "./types";

// Per-lane default ports. Two installs on the same machine (different lanes,
// same defaults) used to fight over 7337/3000 and the second start would
// fail. Hashing the lane name picks deterministic per-lane defaults so
// parallel lanes coexist without manual `--port` wrangling. The dev lane
// stays pinned to the historic 7337/3000 so existing muscle memory and any
// external tooling pointing at those ports keeps working.
const DEFAULT_RUNTIME_PORT_DEV = 7337;
const DEFAULT_WEB_PORT_DEV = 3000;
const RUNTIME_PORT_RANGE = 100;
const WEB_PORT_RANGE = 100;

// FNV-1a 32-bit. Cheap, dependency-free, deterministic. We don't need
// cryptographic strength — just something that scatters lane names evenly
// across a 100-port window.
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function defaultRuntimePort(lane: Lane): number {
  if (lane === "dev") return DEFAULT_RUNTIME_PORT_DEV;
  return DEFAULT_RUNTIME_PORT_DEV + (fnv1a(`runtime:${lane}`) % RUNTIME_PORT_RANGE);
}

export function defaultWebPort(lane: Lane): number {
  if (lane === "dev") return DEFAULT_WEB_PORT_DEV;
  return DEFAULT_WEB_PORT_DEV + (fnv1a(`web:${lane}`) % WEB_PORT_RANGE);
}

export function parseLane(args = Bun.argv.slice(2)): Lane {
  const flagIndex = args.indexOf("--lane");
  if (flagIndex >= 0 && args[flagIndex + 1]) return args[flagIndex + 1];
  return process.env.GINI_LANE ?? "dev";
}

export function projectRoot(): string {
  return resolve(import.meta.dir, "..");
}

export function baseStateRoot(): string {
  return process.env.GINI_STATE_ROOT
    ? resolve(process.env.GINI_STATE_ROOT)
    : join(homedir(), ".gini");
}

export function baseLogRoot(): string {
  return process.env.GINI_LOG_ROOT
    ? resolve(process.env.GINI_LOG_ROOT)
    : join(homedir(), ".gini", "logs");
}

// All lane state lives under <baseStateRoot>/lanes/<lane>/ so wiping every
// lane is a single rm -rf without touching the shared model cache or logs.
export function lanesRoot(): string {
  return join(baseStateRoot(), "lanes");
}

export function laneRoot(lane: Lane): string {
  return join(lanesRoot(), lane);
}

// One-time migration of pre-`lanes/`-prefix lane directories. Old layout was
// ~/.gini/<lane>/; new layout is ~/.gini/lanes/<lane>/. We detect a lane by
// the presence of config.json so reserved children (logs, models, lanes
// itself) are left alone. Idempotent: skips lanes that already moved.
export function migrateLegacyLanePaths(): void {
  const root = baseStateRoot();
  if (!existsSync(root)) return;
  const newLanesDir = lanesRoot();
  let migrated = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "lanes" || entry.name === "logs" || entry.name === "models") continue;
    const oldDir = join(root, entry.name);
    if (!existsSync(join(oldDir, "config.json"))) continue;
    const newDir = join(newLanesDir, entry.name);
    if (existsSync(newDir)) continue;
    mkdirSync(newLanesDir, { recursive: true });
    renameSync(oldDir, newDir);
    migrated += 1;
  }
  if (migrated > 0) {
    process.stderr.write(`Migrated ${migrated} lane(s) from ~/.gini/<lane>/ to ~/.gini/lanes/<lane>/\n`);
  }
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function configPath(lane: Lane): string {
  return join(laneRoot(lane), "config.json");
}

export function statePath(lane: Lane): string {
  return join(laneRoot(lane), "state.json");
}

export function pidPath(lane: Lane): string {
  return join(laneRoot(lane), "runtime.pid");
}

// Recorded port files. Written once `gini start` claims a port (which may
// differ from the lane default if the default was busy and the walk rolled
// forward). `gini status` / `stop` / `doctor` / `existingWebUrl` read these
// to know the actual live port without re-probing every default. Cleaned up
// on stop so a stale value doesn't bleed into the next start.
export function runtimePortPath(lane: Lane): string {
  return join(laneRoot(lane), "runtime.port");
}

export function webPortPath(lane: Lane): string {
  return join(laneRoot(lane), "web.port");
}

export function traceDir(lane: Lane): string {
  return join(laneRoot(lane), "traces");
}

export function logDir(lane: Lane): string {
  return join(baseLogRoot(), lane);
}

export function skillsDir(lane: Lane): string {
  return join(laneRoot(lane), "skills");
}

export function snapshotsDir(lane: Lane): string {
  return join(laneRoot(lane), "snapshots");
}

export function workspaceDir(lane: Lane): string {
  return process.env.GINI_WORKSPACE
    ? resolve(process.env.GINI_WORKSPACE)
    : join(laneRoot(lane), "workspace");
}

export function defaultConfig(lane: Lane): RuntimeConfig {
  const providerName = process.env.GINI_PROVIDER === "openai" || process.env.GINI_PROVIDER === "codex"
    ? process.env.GINI_PROVIDER
    : "echo";
  return {
    lane,
    port: Number(process.env.GINI_PORT ?? defaultRuntimePort(lane)),
    token: crypto.randomUUID(),
    provider: {
      name: providerName,
      model: process.env.GINI_MODEL ?? (providerName === "echo" ? "gini-echo-v0" : providerName === "codex" ? "gpt-5.4" : "gpt-5.4-mini"),
      apiKeyEnv: providerName === "openai" ? "OPENAI_API_KEY" : undefined
    },
    workspaceRoot: workspaceDir(lane),
    stateRoot: laneRoot(lane),
    logRoot: logDir(lane)
  };
}

export function loadConfig(lane: Lane): RuntimeConfig {
  migrateLegacyLanePaths();
  ensureDir(laneRoot(lane));
  ensureDir(traceDir(lane));
  ensureDir(logDir(lane));
  ensureDir(skillsDir(lane));
  ensureDir(snapshotsDir(lane));
  ensureDir(workspaceDir(lane));

  const path = configPath(lane);
  if (!existsSync(path)) {
    const config = defaultConfig(lane);
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
    return config;
  }

  const parsed = JSON.parse(readFileSync(path, "utf8")) as RuntimeConfig;
  const persistedRoot = parsed.workspaceRoot ? resolve(parsed.workspaceRoot) : "";
  const repoRoot = projectRoot();
  // Detect persisted paths from the pre-`lanes/` layout (anything that lives
  // directly under baseStateRoot but NOT under lanes/). Re-derive to the new
  // location instead of keeping the stale absolute path. Also rewrites the
  // old repo-root default from earlier migrations.
  const oldStyleLanePrefix = join(baseStateRoot(), lane) + "/";
  const persistedIsOldStyle = persistedRoot.startsWith(oldStyleLanePrefix) || persistedRoot === join(baseStateRoot(), lane);
  const persistedIsRepoRoot = persistedRoot === repoRoot;
  const needsRewrite = persistedIsOldStyle || persistedIsRepoRoot || !persistedRoot;
  const migratedWorkspaceRoot = needsRewrite ? workspaceDir(lane) : persistedRoot;
  const merged: RuntimeConfig = {
    ...defaultConfig(lane),
    ...parsed,
    lane,
    workspaceRoot: migratedWorkspaceRoot,
    stateRoot: laneRoot(lane),
    logRoot: logDir(lane)
  };
  if (needsRewrite) writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}
