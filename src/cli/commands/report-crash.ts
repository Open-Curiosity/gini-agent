// `gini report-crash --report <path>` — file a deduped GitHub issue for a
// crash report written by the runtime crash handler (or the watchdog).
//
// Invoked as a detached child by the crash handler AFTER the report file is on
// disk, so it survives the crashing process. The command never throws and
// never blocks: any failure (not under launchd, gh unauthed, rate-limited)
// resolves to exit 0 so it can't wedge a respawn or a watchdog tick.
//
// Filing is gated to launchd-supervised instances only (decision 3): the 40+
// throwaway conductor/test instances must not file issues. Recurrences of the
// same fingerprint reuse one open issue (hidden-marker dedup) and are
// rate-limited (>=1h between comments, hard cap 20) so a crash loop can't spam
// the tracker.

import { existsSync, readFileSync } from "node:fs";
import type { CliContext } from "../context";
import { flagValue } from "../args";
import { supervisor } from "../../integrations/launchd";
import {
  defaultGhRunner,
  ensureCrashLabel,
  findOpenIssueByFingerprint,
  fingerprintMarker,
  createCrashIssue,
  commentOnIssue,
  isGhAuthed,
  type GhRunner
} from "../../integrations/github-issues";
import {
  readRateLimitState,
  redactReportText,
  writeRateLimitState,
  type CrashReport
} from "../../runtime/crash-report";
import { secretsEnvPath } from "../../state/secrets-env";
import { readTunnelConfig } from "../../runtime/tunnel/config-store";
import { appendLog } from "../../state/trace";

// Minimum gap between comments on the same fingerprint's issue.
const COMMENT_MIN_INTERVAL_MS = 60 * 60 * 1000;
// Hard cap on comments per fingerprint before we silently drop recurrences.
const COMMENT_HARD_CAP = 20;

export interface ReportCrashDeps {
  gh?: GhRunner;
  clock?: () => Date;
  supervisorImpl?: () => "launchd" | null;
}

function shortMessage(message: string): string {
  const oneLine = message.split("\n")[0] ?? "";
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
}

// Read the secrets.env body (if present) for literal-value redaction. Failures
// are swallowed — pattern redaction still catches the common token shapes.
function readSecretsEnvBody(): string | undefined {
  try {
    const path = secretsEnvPath();
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

function readTunnelSecret(instance: string): string | undefined {
  try {
    return readTunnelConfig(instance).secret;
  } catch {
    return undefined;
  }
}

// Assemble the redacted issue body: a human-readable summary of the report
// plus the hidden fingerprint marker. Every text field is run through
// redactReportText so no secret/token/user-content byte reaches GitHub.
function buildIssueBody(report: CrashReport, instance: string): string {
  const secretsEnvBody = readSecretsEnvBody();
  const tunnelSecret = readTunnelSecret(instance);
  const redact = (text: string): string => redactReportText(text, { secretsEnvBody, tunnelSecret });

  const logLines = report.logTail
    .map((line) => `- ${line.at ?? ""} ${line.message ?? ""}`.trim())
    .join("\n");

  const sections = [
    `**Source:** ${report.source}`,
    `**Instance:** ${report.instance}`,
    `**When:** ${report.at}`,
    `**System:** ${report.sysInfo.platform}/${report.sysInfo.arch} node ${report.sysInfo.nodeVersion}` +
      (report.sysInfo.giniCommit ? ` commit ${report.sysInfo.giniCommit}` : ""),
    "",
    `**Error:** ${redact(report.error.name)}: ${redact(report.error.message)}`,
    "",
    "```",
    redact(report.error.stack),
    "```",
    "",
    "**Recent events:**",
    logLines ? redact(logLines) : "_none_",
    "",
    fingerprintMarker(report.fingerprint)
  ];
  return sections.join("\n");
}

export async function reportCrash(ctx: CliContext, deps: ReportCrashDeps = {}): Promise<void> {
  const supervisorImpl = deps.supervisorImpl ?? supervisor;
  // Gate: only launchd/autostart instances file (decision 3).
  if (supervisorImpl() !== "launchd") return;

  const reportPath = flagValue(ctx.cliArgs, "--report") ?? flagValue(ctx.rawArgs, "--report");
  if (!reportPath || !existsSync(reportPath)) return;

  let report: CrashReport;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8")) as CrashReport;
  } catch {
    return;
  }
  if (!report.fingerprint) return;
  const instance = report.instance || ctx.config.instance;

  const gh = deps.gh ?? defaultGhRunner;
  const clock = deps.clock ?? (() => new Date());

  // gh unauthenticated: leave a local breadcrumb and exit cleanly. Never block.
  if (!isGhAuthed(gh)) {
    appendLog(instance, "crash.report.skipped", { reason: "gh-unauthed", fingerprint: report.fingerprint });
    return;
  }

  const state = readRateLimitState(report.fingerprint);
  const nowMs = clock().getTime();
  const nowIso = clock().toISOString();

  ensureCrashLabel(gh);
  const existing = findOpenIssueByFingerprint(gh, report.fingerprint);

  if (existing === null) {
    const title = `[crash] ${report.source}: ${report.error.name}: ${shortMessage(report.error.message)}`;
    const body = buildIssueBody(report, instance);
    const created = createCrashIssue(gh, { title, body });
    if (created !== null) {
      writeRateLimitState(report.fingerprint, {
        lastFiledAt: nowIso,
        lastCommentAt: null,
        commentCount: 0
      });
      appendLog(instance, "crash.report.filed", { fingerprint: report.fingerprint, issue: created });
    }
    return;
  }

  // An open issue exists. Comment only if within the rate-limit budget.
  if (state.commentCount >= COMMENT_HARD_CAP) {
    appendLog(instance, "crash.report.suppressed", { reason: "comment-cap", fingerprint: report.fingerprint });
    return;
  }
  if (state.lastCommentAt) {
    const lastMs = new Date(state.lastCommentAt).getTime();
    if (Number.isFinite(lastMs) && nowMs - lastMs < COMMENT_MIN_INTERVAL_MS) {
      appendLog(instance, "crash.report.suppressed", { reason: "rate-limit", fingerprint: report.fingerprint });
      return;
    }
  }

  const body = buildIssueBody(report, instance);
  const commented = commentOnIssue(gh, existing, body);
  if (commented) {
    writeRateLimitState(report.fingerprint, {
      lastFiledAt: state.lastFiledAt,
      lastCommentAt: nowIso,
      commentCount: state.commentCount + 1
    });
    appendLog(instance, "crash.report.commented", { fingerprint: report.fingerprint, issue: existing });
  }
}
