// Hindsight phase 2 — embedding provider abstraction.
//
// Two implementations:
//   - openai: text-embedding-3-small (dim=1536), batched up to 100 inputs.
//             Reuses the same bearer-token resolution as src/provider.ts so
//             both OPENAI_API_KEY and Codex OAuth tokens work.
//   - echo:   deterministic hash-based 32-dim vector. Identical input always
//             produces an identical vector — what tests need.
//
// Selection: env GINI_EMBEDDING_PROVIDER pins the choice; otherwise default
// to "openai" when an OpenAI-style key is available, else "echo".
//
// In-process cache keyed by (model, text) avoids re-embedding the same
// string twice within a single CLI/runtime process — retain-then-recall in
// the same process commonly hits the same query, and the cache shaves a
// network round-trip without persistence concerns.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RuntimeConfig } from "./types";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_OPENAI_EMBEDDING_DIM = 1536;
const ECHO_DIM = 32;
const DEFAULT_BATCH_SIZE = 100;

export interface EmbeddingProvider {
  name: string;
  model: string;
  dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export function getEmbeddingProvider(config: RuntimeConfig): EmbeddingProvider {
  const choice = (process.env.GINI_EMBEDDING_PROVIDER ?? "").toLowerCase();
  if (choice === "echo") return echoProvider();
  if (choice === "openai") return openaiProvider(config);

  // Auto-select: prefer openai if a key is reachable, otherwise echo.
  if (resolveOpenAIBearer(config) || readCodexBearerOrNull(config)) {
    return openaiProvider(config);
  }
  return echoProvider();
}

// --------------------------------------------------------------------------
// Echo provider — deterministic hash-based stub for tests + offline dev.
// --------------------------------------------------------------------------

export function echoProvider(): EmbeddingProvider {
  return {
    name: "echo",
    model: "echo-embed-v0",
    dim: ECHO_DIM,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((text) => echoEmbed(text));
    }
  };
}

// Token-level FNV-1a hashing into a fixed-dim bag. Each token contributes a
// +1 to its hashed slot. Lowercased + alphanumeric-only token split keeps
// the vector stable across small textual variations (whitespace, punctuation,
// casing). Identical inputs -> identical vectors; near-duplicate inputs ->
// near-identical vectors with cosine close to 1.
export function echoEmbed(text: string): Float32Array {
  const out = new Float32Array(ECHO_DIM);
  if (text.length === 0) {
    out[0] = 1;
    return normalize(out);
  }
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.length === 0) {
    out[0] = 1;
    return normalize(out);
  }
  for (const token of tokens) {
    let hash = 2166136261 >>> 0;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    const slot = hash % ECHO_DIM;
    out[slot] += 1;
  }
  return normalize(out);
}

function normalize(vector: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < vector.length; i++) sumSq += vector[i]! * vector[i]!;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) {
    vector[0] = 1;
    return vector;
  }
  for (let i = 0; i < vector.length; i++) vector[i] = vector[i]! / norm;
  return vector;
}

// --------------------------------------------------------------------------
// OpenAI provider
// --------------------------------------------------------------------------

export function openaiProvider(config: RuntimeConfig): EmbeddingProvider {
  const cache = new Map<string, Float32Array>();
  return {
    name: "openai",
    model: DEFAULT_OPENAI_EMBEDDING_MODEL,
    dim: DEFAULT_OPENAI_EMBEDDING_DIM,
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const out: Float32Array[] = new Array(texts.length);
      const misses: { index: number; text: string }[] = [];
      for (let i = 0; i < texts.length; i++) {
        const text = texts[i]!;
        const cached = cache.get(text);
        if (cached) out[i] = cached;
        else misses.push({ index: i, text });
      }
      // Batch misses.
      for (let start = 0; start < misses.length; start += DEFAULT_BATCH_SIZE) {
        const slice = misses.slice(start, start + DEFAULT_BATCH_SIZE);
        const vectors = await embedOpenAIBatch(config, slice.map((m) => m.text));
        for (let j = 0; j < slice.length; j++) {
          const slot = slice[j]!;
          const vector = vectors[j]!;
          out[slot.index] = vector;
          cache.set(slot.text, vector);
        }
      }
      return out;
    }
  };
}

async function embedOpenAIBatch(config: RuntimeConfig, texts: string[]): Promise<Float32Array[]> {
  const bearer = resolveOpenAIBearer(config) ?? readCodexBearerOrNull(config);
  if (!bearer) {
    throw new Error("OpenAI embedding provider requires OPENAI_API_KEY or Codex OAuth credentials.");
  }
  const baseUrl = (config.provider.baseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: DEFAULT_OPENAI_EMBEDDING_MODEL,
      input: texts
    })
  });
  const raw = await response.text();
  if (!response.ok) {
    let message = `Embedding request failed with HTTP ${response.status}`;
    try {
      const payload = JSON.parse(raw) as { error?: { message?: unknown } };
      if (payload.error && typeof payload.error.message === "string") message = payload.error.message;
    } catch {
      message = raw.slice(0, 500) || message;
    }
    throw new Error(message);
  }
  const payload = JSON.parse(raw) as { data?: Array<{ embedding?: number[]; index?: number }> };
  const data = payload.data ?? [];
  const out: Float32Array[] = new Array(texts.length);
  for (const entry of data) {
    const idx = typeof entry.index === "number" ? entry.index : -1;
    if (idx < 0 || idx >= texts.length) continue;
    const vector = new Float32Array(entry.embedding ?? []);
    out[idx] = vector;
  }
  for (let i = 0; i < out.length; i++) {
    if (!out[i]) throw new Error("OpenAI embeddings response missing entry for input ${i}");
  }
  return out;
}

// --------------------------------------------------------------------------
// Bearer-token resolution (mirrors src/provider.ts but tolerant of missing
// creds — getEmbeddingProvider auto-selects only when one of these resolves).
// --------------------------------------------------------------------------

function resolveOpenAIBearer(config: RuntimeConfig): string | null {
  const envName = config.provider.apiKeyEnv ?? "OPENAI_API_KEY";
  const value = process.env[envName];
  return value && value.length > 0 ? value : null;
}

function readCodexBearerOrNull(config: RuntimeConfig): string | null {
  const envName = config.provider.apiKeyEnv;
  const envValue = envName ? process.env[envName] : undefined;
  const raw = envValue || process.env.CODEX_AUTH_JSON || "~/.codex/auth.json";
  const path = resolve(raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const apiKey = typeof parsed.OPENAI_API_KEY === "string" ? parsed.OPENAI_API_KEY : null;
    if (apiKey) return apiKey;
    const tokens = parsed.tokens && typeof parsed.tokens === "object"
      ? parsed.tokens as Record<string, unknown>
      : null;
    const access = tokens && typeof tokens.access_token === "string" ? tokens.access_token : null;
    return access;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// Cosine similarity helper — used by retain (semantic links) and recall
// (semantic channel). Lives here so vector math has a single home.
// --------------------------------------------------------------------------

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
