import { describe, expect, test } from "bun:test";
import {
  FALLBACK_CONTEXT_WINDOW_TOKENS,
  resolveDefaultPriorContextTokenBudget,
  resolveProviderContextWindowTokens,
  resolveProviderModality
} from "./provider-capabilities";
import type { ProviderConfig } from "./types";

function provider(name: ProviderConfig["name"], model: string): ProviderConfig {
  return { name, model };
}

describe("resolveProviderModality", () => {
  test("known openai families support vision and native docs", () => {
    expect(resolveProviderModality(provider("openai", "gpt-5.5"))).toEqual({ vision: true, nativeDocs: true });
    expect(resolveProviderModality(provider("openai", "gpt-4o"))).toEqual({ vision: true, nativeDocs: true });
    expect(resolveProviderModality(provider("openai", "gpt-4.1-mini"))).toEqual({ vision: true, nativeDocs: true });
    expect(resolveProviderModality(provider("openai", "o4-mini"))).toEqual({ vision: true, nativeDocs: true });
    expect(resolveProviderModality(provider("openai", "ChatGPT-4o-latest"))).toEqual({ vision: true, nativeDocs: true });
  });

  test("unknown openai model ids fall back to conservative false", () => {
    // A custom OpenAI-compatible endpoint (or an unrecognized model) must not
    // be handed a document part it can't ingest.
    expect(resolveProviderModality(provider("openai", "llama-3-70b"))).toEqual({ vision: false, nativeDocs: false });
    expect(resolveProviderModality(provider("openai", "text-davinci-003"))).toEqual({ vision: false, nativeDocs: false });
    expect(resolveProviderModality(provider("openai", ""))).toEqual({ vision: false, nativeDocs: false });
    // Prefix collisions must NOT match a known family (no boundary → false).
    expect(resolveProviderModality(provider("openai", "gpt-5foo"))).toEqual({ vision: false, nativeDocs: false });
    expect(resolveProviderModality(provider("openai", "gpt-4oish"))).toEqual({ vision: false, nativeDocs: false });
    expect(resolveProviderModality(provider("openai", "o1derful"))).toEqual({ vision: false, nativeDocs: false });
  });

  test("openrouter supported families resolve to both true", () => {
    expect(resolveProviderModality(provider("openrouter", "anthropic/claude-3.7-sonnet")))
      .toEqual({ vision: true, nativeDocs: true });
    expect(resolveProviderModality(provider("openrouter", "google/gemini-2.5-pro")))
      .toEqual({ vision: true, nativeDocs: true });
    expect(resolveProviderModality(provider("openrouter", "openai/gpt-5.5")))
      .toEqual({ vision: true, nativeDocs: true });
  });

  test("openrouter is case-insensitive on the family prefix", () => {
    expect(resolveProviderModality(provider("openrouter", "Anthropic/Claude-3.7-Sonnet")))
      .toEqual({ vision: true, nativeDocs: true });
  });

  test("openrouter google family requires the gemini prefix, not just google/", () => {
    // google/gemma-* is text-only on OpenRouter; only google/gemini* is gated true.
    expect(resolveProviderModality(provider("openrouter", "google/gemma-3-27b")))
      .toEqual({ vision: false, nativeDocs: false });
    expect(resolveProviderModality(provider("openrouter", "google/gemini-1.5-flash")))
      .toEqual({ vision: true, nativeDocs: true });
  });

  test("openrouter unknown/other routed models fall back to conservative false", () => {
    expect(resolveProviderModality(provider("openrouter", "meta-llama/llama-3.3-70b-instruct")))
      .toEqual({ vision: false, nativeDocs: false });
    expect(resolveProviderModality(provider("openrouter", "deepseek/deepseek-chat")))
      .toEqual({ vision: false, nativeDocs: false });
    expect(resolveProviderModality(provider("openrouter", "")))
      .toEqual({ vision: false, nativeDocs: false });
  });

  test("deepseek is text-only", () => {
    expect(resolveProviderModality(provider("deepseek", "deepseek-chat")))
      .toEqual({ vision: false, nativeDocs: false });
    expect(resolveProviderModality(provider("deepseek", "deepseek-reasoner")))
      .toEqual({ vision: false, nativeDocs: false });
  });

  test("codex is natively multimodal (verified against the live backend)", () => {
    expect(resolveProviderModality(provider("codex", "gpt-5.5")))
      .toEqual({ vision: true, nativeDocs: true });
  });

  test("azure follows the openai model family for vision but never native docs", () => {
    // Azure's deployment-scoped chat/completions has no `file` content part, so
    // nativeDocs stays false even for a vision-capable family.
    expect(resolveProviderModality(provider("azure", "gpt-4o")))
      .toEqual({ vision: true, nativeDocs: false });
    expect(resolveProviderModality(provider("azure", "gpt-5.5")))
      .toEqual({ vision: true, nativeDocs: false });
    // An unknown/text-only Azure deployment stays conservatively false on both.
    expect(resolveProviderModality(provider("azure", "text-embedding-3-large")))
      .toEqual({ vision: false, nativeDocs: false });
  });

  test("local is conservatively unknown → false", () => {
    expect(resolveProviderModality(provider("local", "local/default")))
      .toEqual({ vision: false, nativeDocs: false });
  });

  test("echo has no modality", () => {
    expect(resolveProviderModality(provider("echo", "gini-echo-v0")))
      .toEqual({ vision: false, nativeDocs: false });
  });

  test("an unknown provider name resolves to the conservative default", () => {
    expect(resolveProviderModality({ name: "mystery" as ProviderConfig["name"], model: "x" }))
      .toEqual({ vision: false, nativeDocs: false });
  });

  test("bedrock: vision is per-model, nativeDocs always false (Converse sends no document blocks)", () => {
    // Multimodal families → vision true.
    for (const m of [
      "us.anthropic.claude-opus-4-8",
      "us.amazon.nova-pro-v1:0",
      "us.amazon.nova-lite-v1:0",
      "us.mistral.pixtral-large-2502-v1:0",
      "us.meta.llama4-maverick-17b-instruct-v1:0",
      "us.meta.llama3-2-11b-instruct-v1:0"
    ]) {
      expect(resolveProviderModality(provider("bedrock", m))).toEqual({ vision: true, nativeDocs: false });
    }
    // Text-only / unrecognized ids → vision false. nativeDocs is false either way.
    for (const m of ["us.deepseek.r1-v1:0", "us.meta.llama3-3-70b-instruct-v1:0", "us.amazon.nova-micro-v1:0", ""]) {
      expect(resolveProviderModality(provider("bedrock", m))).toEqual({ vision: false, nativeDocs: false });
    }
  });
});

describe("resolveProviderContextWindowTokens", () => {
  test("openai/codex known model families resolve to their context windows", () => {
    expect(resolveProviderContextWindowTokens(provider("openai", "gpt-5.5"))).toBe(1_000_000);
    expect(resolveProviderContextWindowTokens(provider("openai", "gpt-5.4"))).toBe(1_050_000);
    expect(resolveProviderContextWindowTokens(provider("openai", "gpt-5.4-mini"))).toBe(400_000);
    expect(resolveProviderContextWindowTokens(provider("openai", "gpt-5.3-codex-spark"))).toBe(400_000);
    expect(resolveProviderContextWindowTokens(provider("openai", "gpt-5.2-chat-latest"))).toBe(128_000);
    expect(resolveProviderContextWindowTokens(provider("openai", "gpt-4.1-mini"))).toBe(1_047_576);
    expect(resolveProviderContextWindowTokens(provider("openai", "o4-mini"))).toBe(200_000);
    expect(resolveProviderContextWindowTokens(provider("codex", "gpt-5.5"))).toBe(1_000_000);
  });

  test("azure resolves context windows by the underlying openai model family", () => {
    expect(resolveProviderContextWindowTokens(provider("azure", "gpt-5.5"))).toBe(1_000_000);
    expect(resolveProviderContextWindowTokens(provider("azure", "gpt-4.1-mini"))).toBe(1_047_576);
    expect(resolveProviderContextWindowTokens(provider("azure", "o4-mini"))).toBe(200_000);
  });

  test("deepseek v4 models and compatibility aliases resolve to one million tokens", () => {
    expect(resolveProviderContextWindowTokens(provider("deepseek", "deepseek-v4-flash"))).toBe(1_000_000);
    expect(resolveProviderContextWindowTokens(provider("deepseek", "deepseek-v4-pro"))).toBe(1_000_000);
    expect(resolveProviderContextWindowTokens(provider("deepseek", "deepseek-chat"))).toBe(1_000_000);
    expect(resolveProviderContextWindowTokens(provider("deepseek", "deepseek-reasoner"))).toBe(1_000_000);
  });

  test("openrouter routed slugs reuse known upstream windows where possible", () => {
    expect(resolveProviderContextWindowTokens(provider("openrouter", "openai/gpt-5.4-mini"))).toBe(400_000);
    expect(resolveProviderContextWindowTokens(provider("openrouter", "deepseek/deepseek-v4-flash"))).toBe(1_000_000);
    expect(resolveProviderContextWindowTokens(provider("openrouter", "anthropic/claude-4-sonnet"))).toBe(200_000);
    expect(resolveProviderContextWindowTokens(provider("openrouter", "google/gemini-2.5-pro"))).toBe(1_000_000);
  });

  test("unknown, local, echo, and openrouter auto fall back conservatively", () => {
    expect(resolveProviderContextWindowTokens(provider("openai", "llama-3-70b"))).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
    expect(resolveProviderContextWindowTokens(provider("local", "local/default"))).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
    expect(resolveProviderContextWindowTokens(provider("echo", "gini-echo-v0"))).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
    expect(resolveProviderContextWindowTokens(provider("openrouter", "openrouter/auto"))).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
    expect(resolveProviderContextWindowTokens({ name: "mystery" as ProviderConfig["name"], model: "x" }))
      .toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
  });
});

describe("resolveDefaultPriorContextTokenBudget", () => {
  test("defaults to sixty-five percent of the provider context window", () => {
    expect(resolveDefaultPriorContextTokenBudget(provider("codex", "gpt-5.5"))).toBe(650_000);
    expect(resolveDefaultPriorContextTokenBudget(provider("openai", "gpt-5.4-mini"))).toBe(260_000);
    expect(resolveDefaultPriorContextTokenBudget(provider("openai", "gpt-4.1-mini"))).toBe(680_924);
    expect(resolveDefaultPriorContextTokenBudget(provider("echo", "gini-echo-v0"))).toBe(20_800);
  });
});
