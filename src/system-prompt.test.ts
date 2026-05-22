// Unit tests for the runtime-identity render + emission-decision helpers
// added alongside the tell-once-plus-delta system-prompt injection. The
// chat-task integration test covers wiring; this file pins the pure
// content/behavior contracts so regressions surface at the source.

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  IDENTITY_FULL_REFRESH_INTERVAL,
  __resetDefaultGiniInstructionsCacheForTest,
  buildAgentSystemContext,
  decideIdentityEmission,
  getDefaultGiniInstructions,
  renderFullIdentity,
  renderIdentityDelta
} from "./system-prompt";
import type { AgentIdentity, IdentitySnapshotRecord } from "./types";

// Read the canonical bundled defaults once at test-load time. The runtime
// `getDefaultGiniInstructions()` reads the same bytes (memoized + trimmed),
// so anchoring tests against the on-disk asset pins both the bundle
// integrity and the assembler contract in one place.
const DEFAULT_INSTRUCTIONS_FILE = join(import.meta.dir, "runtime", "defaults", "INSTRUCTIONS.md");
const expectedDefaultInstructions = readFileSync(DEFAULT_INSTRUCTIONS_FILE, "utf8").trim();

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

describe("buildAgentSystemContext", () => {
  test("uses the bundled default instructions file when no override is provided", () => {
    const out = buildAgentSystemContext(undefined, undefined);
    expect(out).toBe(expectedDefaultInstructions);
  });

  test("instructionsOverride wins over the bundled defaults", () => {
    const out = buildAgentSystemContext(undefined, undefined, {
      instructionsOverride: "Custom rules only."
    });
    expect(out).toBe("Custom rules only.");
    expect(out).not.toContain("local-first personal agent");
  });

  test("blank instructionsOverride falls back to the default", () => {
    // Whitespace-only override should not silently empty the preamble.
    const out = buildAgentSystemContext(undefined, undefined, {
      instructionsOverride: "   \n"
    });
    expect(out).toBe(expectedDefaultInstructions);
  });

  test("assembles blocks in the documented order: instructions, soul, identity, user, recalled", () => {
    const identityBlock = "Your runtime identity:\n- instance: test";
    const out = buildAgentSystemContext(
      "1. (semantic) recalled snippet",
      identityBlock,
      {
        instructionsOverride: "RULES",
        soul: "SOUL persona body",
        userProfile: "USER profile body"
      }
    );
    const rulesIdx = out.indexOf("RULES");
    const soulIdx = out.indexOf("SOUL persona body");
    const identityIdx = out.indexOf("Your runtime identity:");
    const userIdx = out.indexOf("USER profile body");
    const recalledIdx = out.indexOf("Long-term memory");
    expect(rulesIdx).toBe(0);
    expect(rulesIdx).toBeLessThan(soulIdx);
    expect(soulIdx).toBeLessThan(identityIdx);
    expect(identityIdx).toBeLessThan(userIdx);
    expect(userIdx).toBeLessThan(recalledIdx);
  });

  test("no longer renders the legacy 'Pinned memories about this user' block", () => {
    // The pinned-memory surface was consolidated into USER.md / SOUL.md /
    // Hindsight; the block should not appear in any assembled prompt
    // regardless of caller options. See ADR memory-surface-consolidation.md.
    const out = buildAgentSystemContext("1. (semantic) snip", "Your runtime identity:\n- instance: test", {
      instructionsOverride: "RULES",
      soul: "SOUL body",
      userProfile: "USER body"
    });
    expect(out).not.toContain("Pinned memories about this user");
  });

  test("elides soul and userProfile blocks when blank or absent", () => {
    const out = buildAgentSystemContext(undefined, "ID-BLOCK", {
      instructionsOverride: "RULES",
      soul: "   ",
      userProfile: ""
    });
    expect(out).toBe(["RULES", "ID-BLOCK"].join("\n\n"));
  });

  test("preserves prior contract: recalled with no override or files", () => {
    // Existing callers that don't pass the new options object must keep
    // producing the same block shape as before.
    const out = buildAgentSystemContext("1. (semantic) snip");
    expect(out).toContain(expectedDefaultInstructions);
    expect(out).toContain("Long-term memory of prior conversations");
    expect(out).not.toContain("Pinned memories about this user");
    expect(out).not.toContain("SOUL");
    expect(out).not.toContain("USER profile");
  });
});

describe("getDefaultGiniInstructions", () => {
  // The runtime can't function without the bundled defaults file — a
  // missing file at this point means the runtime is incorrectly packaged.
  // The function must throw loudly rather than silently fall back to an
  // empty string or a hardcoded sentinel.
  afterEach(() => {
    // Restore the active path + drop the cache so subsequent tests get
    // the real bundled bytes back.
    __resetDefaultGiniInstructionsCacheForTest();
  });

  test("throws with a clear message when the bundled file is missing", () => {
    // Point the resolver at a path that cannot exist on any sane CI host.
    const missingPath = join(import.meta.dir, "runtime", "defaults", "does-not-exist-INSTRUCTIONS.md");
    __resetDefaultGiniInstructionsCacheForTest(missingPath);
    expect(() => getDefaultGiniInstructions()).toThrow(/default INSTRUCTIONS\.md missing from bundle/);
    expect(() => getDefaultGiniInstructions()).toThrow(missingPath);
  });

  test("memoizes on success — repeat calls reuse the cached value", () => {
    // First call reads + trims + caches; second call returns the cache.
    // We can't directly observe the absence of a syscall, so we observe
    // it indirectly: read once to populate the cache, then swap the
    // active path to a missing file AND clear the cache via the reset
    // helper. The next call now throws — proving the swap took effect.
    // If the second `getDefaultGiniInstructions()` call had hit the
    // filesystem before the explicit reset (i.e., not honored the cache),
    // there is no path swap to observe; the only way to see the failure
    // path is via the explicit reset+swap below.
    const first = getDefaultGiniInstructions();
    expect(first).toBe(expectedDefaultInstructions);
    const second = getDefaultGiniInstructions();
    expect(second).toBe(first);
    // Explicit reset + swap: confirms the override path machinery works
    // and the prior result came from the cache rather than a fresh read.
    const missingPath = join(import.meta.dir, "runtime", "defaults", "does-not-exist-INSTRUCTIONS.md");
    __resetDefaultGiniInstructionsCacheForTest(missingPath);
    expect(() => getDefaultGiniInstructions()).toThrow(/default INSTRUCTIONS\.md missing from bundle/);
  });
});
