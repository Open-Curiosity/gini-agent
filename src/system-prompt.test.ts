// Unit tests for the runtime-identity render + emission-decision helpers
// added alongside the tell-once-plus-delta system-prompt injection. The
// chat-task integration test covers wiring; this file pins the pure
// content/behavior contracts so regressions surface at the source.

import { describe, expect, test } from "bun:test";
import {
  IDENTITY_FULL_REFRESH_INTERVAL,
  decideIdentityEmission,
  renderFullIdentity,
  renderIdentityDelta
} from "./system-prompt";
import type { AgentIdentity, IdentitySnapshotRecord } from "./types";

function makeIdentity(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  return {
    instance: "gini-agent",
    runtimePort: 7351,
    agentName: "default",
    agentId: "profile_default",
    provider: "codex/gpt-5.5",
    toolsets: ["file", "terminal", "memory", "session_search", "delegation"],
    memoryNamespace: "profile_default",
    ...overrides
  };
}

describe("renderFullIdentity", () => {
  test("renders every field as a bullet under a stable header", () => {
    const out = renderFullIdentity(makeIdentity());
    expect(out).toBe(
      [
        "Your runtime identity:",
        "- instance: gini-agent",
        "- runtime port: 7351",
        "- agent: default (profile_default)",
        "- provider: codex/gpt-5.5",
        "- toolsets enabled: file, terminal, memory, session_search, delegation",
        "- memory namespace: profile_default"
      ].join("\n")
    );
  });

  test("renders '(none)' when an agent has no toolsets configured", () => {
    const out = renderFullIdentity(makeIdentity({ toolsets: [] }));
    expect(out).toContain("- toolsets enabled: (none)");
  });
});

describe("renderIdentityDelta", () => {
  test("returns empty string when nothing changed", () => {
    expect(renderIdentityDelta(makeIdentity(), makeIdentity())).toBe("");
  });

  test("emits only the changed field with the prior value annotated", () => {
    const out = renderIdentityDelta(
      makeIdentity(),
      makeIdentity({ toolsets: ["file", "terminal"] })
    );
    expect(out).toBe(
      [
        "Runtime identity changes since last turn:",
        "- toolsets enabled: file, terminal (was file, terminal, memory, session_search, delegation)"
      ].join("\n")
    );
  });

  test("emits multiple changed fields in field order", () => {
    const out = renderIdentityDelta(
      makeIdentity(),
      makeIdentity({ provider: "openai/gpt-5", toolsets: [] })
    );
    expect(out).toBe(
      [
        "Runtime identity changes since last turn:",
        "- provider: openai/gpt-5 (was codex/gpt-5.5)",
        "- toolsets enabled: (none) (was file, terminal, memory, session_search, delegation)"
      ].join("\n")
    );
  });

  test("treats agent rename and id swap as one combined entry", () => {
    const out = renderIdentityDelta(
      makeIdentity(),
      makeIdentity({ agentName: "discord", agentId: "profile_discord" })
    );
    expect(out).toBe(
      [
        "Runtime identity changes since last turn:",
        "- agent: discord (profile_discord) (was default (profile_default))"
      ].join("\n")
    );
  });
});

describe("decideIdentityEmission", () => {
  test("emits full and seeds the snapshot when no prior snapshot exists", () => {
    const current = makeIdentity();
    const decision = decideIdentityEmission(current, undefined, 1);
    expect(decision.content).toContain("Your runtime identity:");
    expect(decision.nextSnapshot).toEqual({ identity: current, lastFullTurn: 1 });
  });

  test("emits nothing and skips snapshot updates when nothing changed under the refresh threshold", () => {
    const current = makeIdentity();
    const snapshot: IdentitySnapshotRecord = { identity: current, lastFullTurn: 1 };
    const decision = decideIdentityEmission(current, snapshot, 2);
    expect(decision.content).toBe("");
    expect(decision.nextSnapshot).toBeUndefined();
  });

  test("emits delta and advances snapshot.identity without touching lastFullTurn", () => {
    const prior = makeIdentity();
    const current = makeIdentity({ toolsets: ["file"] });
    const snapshot: IdentitySnapshotRecord = { identity: prior, lastFullTurn: 1 };
    const decision = decideIdentityEmission(current, snapshot, 3);
    expect(decision.content).toContain("Runtime identity changes since last turn:");
    expect(decision.content).toContain("- toolsets enabled: file (was file, terminal, memory, session_search, delegation)");
    expect(decision.nextSnapshot).toEqual({ identity: current, lastFullTurn: 1 });
  });

  test("re-emits full at the IDENTITY_FULL_REFRESH_INTERVAL boundary and resets lastFullTurn", () => {
    const current = makeIdentity();
    const snapshot: IdentitySnapshotRecord = { identity: current, lastFullTurn: 1 };
    const refreshTurn = 1 + IDENTITY_FULL_REFRESH_INTERVAL;
    const decision = decideIdentityEmission(current, snapshot, refreshTurn);
    expect(decision.content).toContain("Your runtime identity:");
    expect(decision.nextSnapshot).toEqual({ identity: current, lastFullTurn: refreshTurn });
  });

  test("still emits full at the refresh boundary even when nothing changed", () => {
    // The refresh path is unconditional on change: it exists to give the
    // model a periodic re-grounding and the prompt cache a clean resync,
    // not just to surface changes.
    const current = makeIdentity();
    const snapshot: IdentitySnapshotRecord = { identity: current, lastFullTurn: 1 };
    const decision = decideIdentityEmission(current, snapshot, 1 + IDENTITY_FULL_REFRESH_INTERVAL);
    expect(decision.content).toContain("Your runtime identity:");
  });
});
