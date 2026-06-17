// Daily review (ADR skill-learning-from-outcomes.md): the dedicated "Skill
// review" channel is provisioned once (idempotent), feedback candidates are
// sampled + marked prompted, and a digest is posted only when there's
// something to say.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createSkillOutcome } from "../state/records";
import { mutateState, readState } from "../state";
import { ensureSkillReviewSession, runDailyReview } from "./daily-review";
import type { RuntimeConfig } from "../types";

const ROOT = "/tmp/gini-daily-review-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function makeConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "test",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: ROOT,
    stateRoot: ROOT,
    logRoot: `${ROOT}-logs`
  };
}

describe("ensureSkillReviewSession", () => {
  test("provisions the channel once (idempotent)", async () => {
    const instance = "review-session";
    const config = makeConfig(instance);
    readState(instance);
    const first = await ensureSkillReviewSession(config);
    const second = await ensureSkillReviewSession(config);
    expect(first).toBe(second);
    const sessions = readState(instance).chatSessions.filter((s) => s.feature === "skill-review");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.kind).toBe("channel");
    expect(sessions[0]!.title).toBe("Skill review");
  });
});

describe("runDailyReview", () => {
  test("idle review posts nothing", async () => {
    const instance = "idle";
    const config = makeConfig(instance);
    readState(instance);
    const result = await runDailyReview(config);
    expect(result.posted).toBe(false);
    const session = readState(instance).chatSessions.find((s) => s.feature === "skill-review")!;
    expect(session.messageIds).toHaveLength(0);
  });

  test("samples feedback candidates, marks them prompted, and posts a digest", async () => {
    const instance = "feedback";
    const config = makeConfig(instance);
    await mutateState(instance, (state) => {
      // 4 consequential, unverifiable successes -> only 3 should be sampled.
      for (let i = 0; i < 4; i++) {
        createSkillOutcome(state, {
          taskId: `task_${i}`,
          skillName: "emailer",
          signal: "success",
          source: "objective",
          consequential: true,
          selfVerifiable: false,
          reviewed: false,
          feedbackPrompted: false
        });
      }
    });

    const result = await runDailyReview(config);
    expect(result.feedbackAsked).toBe(3);
    expect(result.posted).toBe(true);

    const state = readState(instance);
    const prompted = state.skillOutcomes.filter((o) => o.feedbackPrompted);
    expect(prompted).toHaveLength(3);
    const session = state.chatSessions.find((s) => s.feature === "skill-review")!;
    expect(session.messageIds.length).toBe(1);
    const message = state.chatMessages.find((m) => m.id === session.messageIds[0]);
    expect(message!.content).toContain("Quick questions about recent actions");
    expect(message!.content).toContain("emailer");
  });
});
