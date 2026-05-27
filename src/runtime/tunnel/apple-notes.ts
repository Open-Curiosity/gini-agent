import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

// Apple Notes mirror via osascript. Defaults OFF. Opt-in extends the
// secret's trust radius to iCloud. PLAN.md "Apple Notes mirror".

const OSASCRIPT_TIMEOUT_MS = 15_000;
const NOTES_APP_PATHS = [
  "/System/Applications/Notes.app",
  "/Applications/Notes.app"
];

export interface NotesProbeResult {
  available: boolean;
  error: string | null;
}

export async function probeNotesAvailable(): Promise<NotesProbeResult> {
  if (process.platform !== "darwin") {
    return { available: false, error: "Apple Notes mirror only supported on macOS." };
  }
  // Direct filesystem check — no osascript spawn, no AppleScript syntax to
  // get wrong, no TCC Automation prompt. The probe just confirms Notes.app
  // is installed at one of the standard locations. We defer the actual
  // Automation-permission prompt to the first `writeNote` call (when the
  // operator explicitly enables the mirror), so the probe stays silent at
  // gateway boot.
  for (const candidate of NOTES_APP_PATHS) {
    if (existsSync(candidate)) {
      return { available: true, error: null };
    }
  }
  return { available: false, error: `Notes.app not found at ${NOTES_APP_PATHS.join(" or ")}.` };
}

export interface NotesWriteOptions {
  folder: string;
  noteName: string;
  body: string;
}

export async function writeNote(opts: NotesWriteOptions): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Apple Notes mirror only supported on macOS.");
  }
  const folder = applescriptEscape(opts.folder);
  const noteName = applescriptEscape(opts.noteName);
  const body = applescriptEscape(opts.body);
  // Find or create the folder + note, then update its body. Notes.app is
  // forgiving about idempotent runs.
  const script = `
tell application "Notes"
  tell account "iCloud"
    if not (exists folder "${folder}") then
      make new folder with properties {name:"${folder}"}
    end if
    tell folder "${folder}"
      if exists note "${noteName}" then
        set body of note "${noteName}" to "${body}"
      else
        make new note with properties {name:"${noteName}", body:"${body}"}
      end if
    end tell
  end tell
end tell
`;
  await runOsascript(script);
}

export async function clearNote(folder: string, noteName: string): Promise<void> {
  if (process.platform !== "darwin") return;
  const f = applescriptEscape(folder);
  const n = applescriptEscape(noteName);
  const script = `
tell application "Notes"
  tell account "iCloud"
    if exists folder "${f}" then
      tell folder "${f}"
        if exists note "${n}" then delete note "${n}"
      end tell
    end if
  end tell
end tell
`;
  await runOsascript(script);
}

function applescriptEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function runOsascript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Pipe the script over stdin (osascript without `-e` reads from stdin)
    // instead of passing it on argv. argv is world-readable via `ps` and
    // `/proc/<pid>/cmdline`; the bootstrap-URL note body contains the live
    // tunnel secret, so argv exposure is a real same-UID leak. stdin
    // delivery keeps the secret in the kernel pipe + child memory only.
    const child = spawn("osascript", [], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      reject(new Error(`osascript timed out after ${OSASCRIPT_TIMEOUT_MS}ms`));
    }, OSASCRIPT_TIMEOUT_MS);
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `osascript exited with code ${code ?? "?"}`));
    });
    if (child.stdin) {
      child.stdin.end(script);
    }
  });
}
