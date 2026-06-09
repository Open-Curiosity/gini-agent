// Tests for the model-major catalog fold (src/model-routes.ts): configured
// filtering, canonical alias grouping, default-route priority, geo route
// labels, and dedupe. Pure inputs — no env/credential games.

import { describe, expect, test } from "bun:test";
import { buildModelCatalog } from "./model-routes";
import { providerCatalog } from "./provider";
import type { ProviderCatalogItem } from "./types";

function item(
  name: string,
  models: string[],
  configured: boolean
): ProviderCatalogItem & { configured: boolean } {
  return {
    id: name,
    name,
    displayName: name,
    auth: "env",
    models,
    capabilities: [],
    costHint: "external",
    configured
  };
}

describe("buildModelCatalog", () => {
  test("skips unconfigured providers entirely", () => {
    const entries = buildModelCatalog([
      item("openai", ["gpt-5.4"], false),
      item("anthropic", ["claude-opus-4-8"], true)
    ]);
    expect(entries.map((e) => e.id)).toEqual(["claude-opus-4-8"]);
  });

  test("returns no entries when nothing is configured", () => {
    expect(buildModelCatalog([item("openai", ["gpt-5.4"], false)])).toEqual([]);
  });

  test("a single-route model gets exactly one route, flagged default", () => {
    const entries = buildModelCatalog([item("codex", ["gpt-5.5"], true)]);
    expect(entries).toEqual([
      {
        id: "gpt-5.5",
        routes: [{ provider: "codex", providerModelId: "gpt-5.5", label: "Codex", default: true }]
      }
    ]);
  });

  test("the same model id under two providers folds into one entry with the native vendor as default", () => {
    const entries = buildModelCatalog([
      item("azure", ["gpt-5.4"], true),
      item("openai", ["gpt-5.4"], true)
    ]);
    expect(entries).toHaveLength(1);
    const routes = entries[0]!.routes;
    expect(routes.map((r) => r.provider)).toEqual(["openai", "azure"]);
    expect(routes[0]).toEqual({ provider: "openai", providerModelId: "gpt-5.4", label: "OpenAI", default: true });
    expect(routes[1]!.default).toBe(false);
  });

  test("bedrock inference-profile aliases fold into the canonical claude ids", () => {
    const entries = buildModelCatalog([
      item("anthropic", ["claude-sonnet-4-6"], true),
      item("bedrock", ["us.anthropic.claude-sonnet-4-6", "eu.anthropic.claude-sonnet-4-6"], true)
    ]);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.id).toBe("claude-sonnet-4-6");
    // anthropic (native vendor) wins default; bedrock geo routes keep
    // catalog order and carry geo-qualified labels.
    expect(entry.routes).toEqual([
      { provider: "anthropic", providerModelId: "claude-sonnet-4-6", label: "Anthropic", default: true },
      { provider: "bedrock", providerModelId: "us.anthropic.claude-sonnet-4-6", label: "Amazon Bedrock · us", default: false },
      { provider: "bedrock", providerModelId: "eu.anthropic.claude-sonnet-4-6", label: "Amazon Bedrock · eu", default: false }
    ]);
  });

  test("bedrock-only geo variants of one model form a multi-route entry with the us profile as default", () => {
    const entries = buildModelCatalog([
      item("bedrock", [
        "us.anthropic.claude-sonnet-4-6",
        "eu.anthropic.claude-sonnet-4-6",
        "apac.anthropic.claude-sonnet-4-6",
        "global.anthropic.claude-sonnet-4-6"
      ], true)
    ]);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.id).toBe("claude-sonnet-4-6");
    expect(entry.routes.map((r) => r.providerModelId)).toEqual([
      "us.anthropic.claude-sonnet-4-6",
      "eu.anthropic.claude-sonnet-4-6",
      "apac.anthropic.claude-sonnet-4-6",
      "global.anthropic.claude-sonnet-4-6"
    ]);
    expect(entry.routes[0]!.default).toBe(true);
    expect(entry.routes.filter((r) => r.default)).toHaveLength(1);
  });

  test("the versioned bedrock haiku profile aliases to claude-haiku-4-5", () => {
    const entries = buildModelCatalog([
      item("bedrock", ["us.anthropic.claude-haiku-4-5-20251001-v1:0"], true)
    ]);
    expect(entries[0]!.id).toBe("claude-haiku-4-5");
    expect(entries[0]!.routes[0]!.providerModelId).toBe("us.anthropic.claude-haiku-4-5-20251001-v1:0");
  });

  test("unaliased bedrock ids (nova, llama) stay verbatim as their own entries", () => {
    const entries = buildModelCatalog([
      item("bedrock", ["us.amazon.nova-pro-v1:0", "us.meta.llama4-scout-17b-instruct-v1:0"], true)
    ]);
    expect(entries.map((e) => e.id)).toEqual([
      "us.amazon.nova-pro-v1:0",
      "us.meta.llama4-scout-17b-instruct-v1:0"
    ]);
  });

  test("duplicate (provider, model) pairs dedupe to one route", () => {
    const entries = buildModelCatalog([
      item("openai", ["gpt-5.4"], true),
      item("openai", ["gpt-5.4"], true)
    ]);
    expect(entries[0]!.routes).toHaveLength(1);
  });

  test("an unknown provider name falls back to its raw name as the label and sorts after known providers", () => {
    const entries = buildModelCatalog([
      item("acme-llm", ["gpt-5.4"], true),
      item("openai", ["gpt-5.4"], true)
    ]);
    const routes = entries[0]!.routes;
    expect(routes.map((r) => r.provider)).toEqual(["openai", "acme-llm"]);
    expect(routes[1]!.label).toBe("acme-llm");
  });

  test("entry order follows first appearance in the catalog input", () => {
    const entries = buildModelCatalog([
      item("codex", ["gpt-5.5"], true),
      item("openai", ["gpt-5.4-mini", "gpt-5.4"], true)
    ]);
    expect(entries.map((e) => e.id)).toEqual(["gpt-5.5", "gpt-5.4-mini", "gpt-5.4"]);
  });

  test("every alias key references a model id that exists in the real provider catalog", () => {
    // Guards the hand-curated alias table against catalog drift: an alias
    // whose source id was renamed/removed in providerCatalog() is dead
    // weight and a sign the canonical mapping needs review. Build the
    // catalog with everything configured and assert the aliased bedrock
    // ids landed under canonical entries.
    const all = providerCatalog().map((row) => ({ ...row, configured: true }));
    const entries = buildModelCatalog(all);
    const ids = new Set(entries.map((e) => e.id));
    for (const canonical of ["claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"]) {
      expect(ids.has(canonical)).toBe(true);
    }
    // No raw aliased bedrock id should surface as its own entry.
    for (const raw of [
      "us.anthropic.claude-opus-4-8",
      "us.anthropic.claude-sonnet-4-6",
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      "eu.anthropic.claude-sonnet-4-6"
    ]) {
      expect(ids.has(raw)).toBe(false);
    }
  });
});
