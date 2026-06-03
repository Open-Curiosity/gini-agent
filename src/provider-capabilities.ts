// Provider × model modality record — a living table of which providers/
// models accept image input (`vision`) and ingest documents natively
// (`nativeDocs`, e.g. PDF → text + page-images on the provider side).
//
// Used at task-build time to decide attachment delivery: `nativeDocs`
// gates the native `document` content part; `vision` is recorded for
// completeness but is NOT newly enforced (the image path stays unchanged).
//
// Defaults are conservative: an unknown provider/model resolves to
// { vision: false, nativeDocs: false } so we never emit a content part a
// provider can't parse.
//
// Update path: add a provider branch (or extend an existing one) below as
// providers/models gain modalities, with a source in the PR. The static
// per-provider/model-family table here is the v1 strategy; live discovery
// of OpenRouter's `architecture.input_modalities` (per routed model) is a
// follow-up that would replace the hardcoded OpenRouter family list.

import type { ProviderConfig } from "./types";

export interface ProviderModality {
  vision: boolean;
  nativeDocs: boolean;
}

// OpenRouter routes to many upstream models under `<vendor>/<model>` slugs.
// The families below are documented to accept image + file input via
// OpenRouter's unified `file` content part. Anything outside these families
// (or an unrecognized slug) falls back to the conservative default.
function openrouterModality(model: string): ProviderModality {
  const slug = model.toLowerCase();
  const supported =
    slug.startsWith("anthropic/") ||
    slug.startsWith("google/gemini") ||
    slug.startsWith("openai/");
  return supported ? { vision: true, nativeDocs: true } : { vision: false, nativeDocs: false };
}

export function resolveProviderModality(provider: ProviderConfig): ProviderModality {
  const model = provider.model ?? "";
  switch (provider.name) {
    case "openai":
      // gpt-4o / 4.1 / 5.x / o-series accept image input and ingest files
      // natively (Responses input_file / Chat-Completions file).
      return { vision: true, nativeDocs: true };
    case "openrouter":
      return openrouterModality(model);
    case "deepseek":
      // Confirmed text-only API — no image/file content part.
      return { vision: false, nativeDocs: false };
    case "codex":
      // ChatGPT-backend /responses is an undocumented OAuth backend; its
      // image/file support is UNKNOWN. Stay conservative (false) until
      // verified against the live backend.
      // TODO: verify codex image/file ingestion and enable if supported.
      return { vision: false, nativeDocs: false };
    case "local":
      // Text-only unless a vision-capable model is loaded; nativeDocs
      // essentially never. UNKNOWN → conservative false.
      // TODO: detect a loaded vision model and flip `vision` when present.
      return { vision: false, nativeDocs: false };
    case "echo":
      // Test stub; no real modality.
      return { vision: false, nativeDocs: false };
    default:
      // Unknown provider → conservative default.
      return { vision: false, nativeDocs: false };
  }
}
