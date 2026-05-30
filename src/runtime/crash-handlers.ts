// Process-level crash handlers for the gateway runtime.
//
// Registers uncaughtException + unhandledRejection handlers that:
//   1. append a structured event to runtime.jsonl (so the crash is captured
//      in the log stream even if the report write or filing fails),
//   2. build + synchronously write a crash report file,
//   3. when under launchd, spawn a DETACHED, unref'd `gini report-crash` so the
//      filing survives our imminent death (KeepAlive respawns the gateway),
//   4. ALWAYS exit(1) via the injected exit impl (try/finally).
//
// The filing is intentionally a separate detached process, not inline: doing
// gh I/O inside a dying process is unreliable, and `report-crash` itself gates
// on launchd + rate-limits, so the handler stays dumb.

import { spawn as nodeSpawn, type spawn as SpawnType } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { logDir } from "../paths";
import { supervisor } from "../integrations/launchd";
import { appendLog } from "../state/trace";
import {
  buildCrashReport,
  writeCrashReportFile,
  type CrashSource,
  type RuntimeLogLine
} from "./crash-report";

// How many runtime.jsonl lines to carry into the report. Bounded so a long log
// doesn't bloat the report; the payload is dropped from each line anyway.
const LOG_TAIL_LINES = 50;

export interface InstallCrashHandlersOptions {
  instance: string;
  source: CrashSource;
  spawnImpl?: typeof SpawnType;
  exitImpl?: (code: number) => void;
  writeImpl?: (report: ReturnType<typeof buildCrashReport>) => string;
  supervisorImpl?: () => "launchd" | null;
  clock?: () => Date;
}

// Read the last N parsed lines of runtime.jsonl. Best-effort: a missing or
// malformed log yields an empty tail rather than throwing inside a crash path.
function readRuntimeLogTail(instance: string, maxLines: number): RuntimeLogLine[] {
  try {
    const path = join(logDir(instance), "runtime.jsonl");
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
    const tail = lines.slice(-maxLines);
    const parsed: RuntimeLogLine[] = [];
    for (const line of tail) {
      try {
        parsed.push(JSON.parse(line) as RuntimeLogLine);
      } catch {
        // Skip an unparseable line; keep the rest of the tail.
      }
    }
    return parsed;
  } catch {
    return [];
  }
}

// Module-level guard so a second installCrashHandlers call (e.g. a re-import in
// tests, or a double wire-up) doesn't register duplicate listeners that would
// each call exit.
let installed = false;

export function installCrashHandlers(options: InstallCrashHandlersOptions): void {
  if (installed) return;
  installed = true;

  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  const exitImpl = options.exitImpl ?? ((code: number) => process.exit(code));
  const writeImpl = options.writeImpl ?? writeCrashReportFile;
  const supervisorImpl = options.supervisorImpl ?? supervisor;
  const clock = options.clock ?? (() => new Date());
  const { instance, source } = options;

  const handle = (error: unknown, event: "uncaughtException" | "unhandledRejection"): void => {
    try {
      const err = error instanceof Error ? error : new Error(String(error));
      appendLog(instance, `runtime.${event}`, { message: err.message, stack: err.stack });

      const report = buildCrashReport({
        instance,
        supervisor: supervisorImpl(),
        error: err,
        source,
        logTail: readRuntimeLogTail(instance, LOG_TAIL_LINES),
        sysInfo: { platform: platform(), arch: arch(), nodeVersion: process.version },
        clock
      });
      const reportPath = writeImpl(report);

      // Only launchd-supervised instances file. Spawn detached + unref'd so the
      // filing child outlives our exit (KeepAlive respawns the gateway).
      if (supervisorImpl() === "launchd") {
        try {
          const child = spawnImpl(
            process.execPath,
            ["run", "gini", "report-crash", "--instance", instance, "--report", reportPath],
            { detached: true, stdio: "ignore", env: { ...process.env, GINI_INSTANCE: instance } }
          );
          if (typeof child.unref === "function") child.unref();
        } catch {
          // Best-effort: a failed spawn must not block the exit below.
        }
      }
    } catch {
      // Never let the crash handler itself throw — fall through to exit.
    } finally {
      exitImpl(1);
    }
  };

  process.on("uncaughtException", (error) => handle(error, "uncaughtException"));
  process.on("unhandledRejection", (reason) => handle(reason, "unhandledRejection"));
}

// Test-only reset of the double-registration guard so each test can install a
// fresh handler set. Not used in production.
export function __resetCrashHandlersForTest(): void {
  installed = false;
}
