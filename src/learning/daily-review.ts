// Daily skill-learning review (ADR skill-learning-from-outcomes.md, decision #2).
//
// runDailyReview: reflect over recent failures, sample up to 3 feedback
// questions (consequential successes the objective tier can't verify),
// assemble a digest, and post it into a dedicated, auto-provisioned
// "Skill review" chat session — NEVER the user's main chat. The session is a
// channel-kind session stamped feature:"skill-review", created once
// (idempotent). Hosted by a slow abortable loop in src/server.ts.

import type { ChatSessionRecord, RuntimeConfig, SkillOutcome } from "../types";
import { createChatMessage, createChatSession, mutateState, readState } from "../state";
import { reflectOnSkillOutcomes } from "./reflect";

const SKILL_REVIEW_TITLE = "Skill review";
const MAX_FEEDBACK_QUESTIONS = 3;

export interface DailyReviewResult {
  proposalsCreated: number;
  findingsCreated: number;
  feedbackAsked: number;
  posted: boolean;
  sessionId: string;
}

// Ensure the dedicated "Skill review" channel exists, returning its id.
// Idempotent: keyed on feature:"skill-review", created once.
export async function ensureSkillReviewSession(config: RuntimeConfig): Promise<string> {
  const existing = findSkillReviewSession(readState(config.instance).chatSessions);
  if (existing) return existing.id;
  return mutateState(config.instance, (state) => {
    // Re-check under the lock so two callers can't both create one.
    const found = findSkillReviewSession(state.chatSessions);
    if (found) return found.id;
    const agentId = state.activeAgentId;
    const created = createChatSession(state, SKILL_REVIEW_TITLE, undefined, agentId, "job", "channel");
    created.feature = "skill-review";
    return created.id;
  });
}

function findSkillReviewSession(sessions: ChatSessionRecord[]): ChatSessionRecord | undefined {
  return sessions.find((s) => s.feature === "skill-review");
}

export async function runDailyReview(config: RuntimeConfig): Promise<DailyReviewResult> {
  const reflect = await reflectOnSkillOutcomes(config);

  // Select up to 3 feedback candidates: recent consequential successes the
  // objective tier couldn't verify, not yet asked about. Mark them prompted so
  // a later review doesn't re-ask. selfVerifiable successes are skipped — the
  // objective signal already covered them.
  const feedback = await mutateState(config.instance, (state) => {
    const candidates = state.skillOutcomes
      .filter(
        (o) =>
          o.signal === "success" &&
          o.consequential &&
          !o.selfVerifiable &&
          !o.feedbackPrompted &&
          o.source === "objective"
      )
      .slice(0, MAX_FEEDBACK_QUESTIONS);
    for (const c of candidates) c.feedbackPrompted = true;
    return candidates.map((c) => ({ ...c }));
  });

  const sessionId = await ensureSkillReviewSession(config);

  // Assemble the digest from the now-current state.
  const state = readState(config.instance);
  const openFindings = state.learningFindings.filter((f) => f.status === "open");
  const pendingProposals = state.improvements.filter(
    (p) => p.status === "proposed" && p.kind === "skill" && p.payload.mode === "edit"
  );

  // Nothing to say -> don't post (keeps the channel quiet on idle days).
  if (pendingProposals.length === 0 && openFindings.length === 0 && feedback.length === 0) {
    return {
      proposalsCreated: reflect.proposalsCreated,
      findingsCreated: reflect.findingsCreated,
      feedbackAsked: 0,
      posted: false,
      sessionId
    };
  }

  const digest = buildDigest(pendingProposals, openFindings, feedback);
  await mutateState(config.instance, (s) => {
    createChatMessage(s, {
      sessionId,
      role: "assistant",
      content: digest
    });
  });

  return {
    proposalsCreated: reflect.proposalsCreated,
    findingsCreated: reflect.findingsCreated,
    feedbackAsked: feedback.length,
    posted: true,
    sessionId
  };
}

function buildDigest(
  proposals: ReadonlyArray<{ id: string; title: string; rationale: string }>,
  findings: ReadonlyArray<{ kind: string; summary: string }>,
  feedback: SkillOutcome[]
): string {
  const lines: string[] = ["Skill review"];

  if (proposals.length > 0) {
    lines.push("", "Proposed skill edits (approve or reject):");
    for (const p of proposals) {
      lines.push(`- ${p.title} — ${p.rationale} (improvement ${p.id})`);
    }
  }

  if (findings.length > 0) {
    lines.push("", "Findings (no skill edit):");
    for (const f of findings) {
      lines.push(`- [${f.kind}] ${f.summary}`);
    }
  }

  if (feedback.length > 0) {
    lines.push("", "Quick questions about recent actions:");
    for (const o of feedback) {
      const label = o.skillName ?? "an action";
      lines.push(
        `- Did "${label}" (task ${o.taskId}) turn out right? If not, tell me what went wrong so I can fix the skill.`
      );
    }
  }

  return lines.join("\n");
}
