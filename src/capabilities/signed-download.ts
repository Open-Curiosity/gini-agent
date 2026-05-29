// signed_download: GET bytes from a URL and store them as a Gini upload.
//
// Mirror of `signed_upload`. Motivating case: Linear's `get_attachment` /
// any future "give me a URL to fetch the bytes from" inbound flow.
// Lets the model bridge external content into Gini's upload-addressable
// space — once the bytes are an uploadId, anything in Gini that takes an
// uploadId works (signed_upload to re-send elsewhere, vision_query for
// model inspection, the chat-message marker for vision context).
//
// Safety profile mirrors signed_upload: the model picks the URL but the
// result is constrained to land under the instance's uploads dir. We
// audit (source host, mime, size) and cap the response body at a
// configurable ceiling so a runaway redirect can't fill the disk.

import type { RuntimeConfig } from "../types";
import { addAudit, appendTrace, mutateState } from "../state";
import { storeUpload } from "../state/uploads";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50MB safety ceiling

export interface SignedDownloadParams {
  url: string;
  headers?: Record<string, string>;
  // Optional filename to record in the upload manifest. Defaults to the
  // URL's basename when omitted.
  filename?: string;
}

export interface SignedDownloadResult {
  ok: boolean;
  error?: string;
  uploadId?: string;
  mimeType?: string;
  size?: number;
}

export interface InvokeSignedDownloadOptions {
  taskId?: string;
  timeoutMs?: number;
  maxBytes?: number;
  // Test hook: replaces the network GET. Returns mimeType + bytes that
  // would have come back from the wire.
  fetchBytes?: (url: string, headers: Record<string, string>) => Promise<{
    ok: boolean;
    status: number;
    body?: string;
    bytes?: Uint8Array;
    mimeType?: string;
  }>;
}

export async function invokeSignedDownload(
  config: RuntimeConfig,
  params: SignedDownloadParams,
  options: InvokeSignedDownloadOptions = {}
): Promise<SignedDownloadResult> {
  if (!params.url) return { ok: false, error: "url is required." };
  if (!/^https:/i.test(params.url)) {
    return { ok: false, error: "signed_download requires https URLs." };
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const headers = sanitizeHeaders(params.headers);

  appendTrace(config.instance, options.taskId ?? "", {
    type: "tool",
    message: `signed_download GET ${hostOf(params.url)}`,
    data: { host: hostOf(params.url), headerKeys: Object.keys(headers), maxBytes }
  });

  const fetchBytes = options.fetchBytes ?? defaultFetchBytes(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBytes);
  let result: { ok: boolean; status: number; body?: string; bytes?: Uint8Array; mimeType?: string };
  try {
    result = await fetchBytes(params.url, headers);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await emitAudit(config, options.taskId, params, false, undefined, undefined, undefined, message);
    return { ok: false, error: `GET failed: ${message}` };
  }
  if (!result.ok) {
    await emitAudit(config, options.taskId, params, false, result.status, undefined, undefined, result.body);
    return {
      ok: false,
      error: `GET returned HTTP ${result.status}${result.body ? `: ${result.body.slice(0, 300)}` : ""}`
    };
  }
  if (!result.bytes || result.bytes.length === 0) {
    await emitAudit(config, options.taskId, params, false, result.status, undefined, undefined, "empty body");
    return { ok: false, error: "GET succeeded but returned no bytes." };
  }
  const mimeType = result.mimeType?.trim() || "application/octet-stream";
  const filename = params.filename ?? basenameFromUrl(params.url);

  let attachment;
  try {
    attachment = storeUpload(config.instance, result.bytes, mimeType, filename);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await emitAudit(config, options.taskId, params, false, result.status, mimeType, result.bytes.length, message);
    return { ok: false, error: `Could not store upload: ${message}` };
  }

  await emitAudit(config, options.taskId, params, true, result.status, mimeType, attachment.size, undefined);
  return { ok: true, uploadId: attachment.id, mimeType, size: attachment.size };
}

function defaultFetchBytes(timeoutMs: number, maxBytes: number) {
  return async (url: string, headers: Record<string, string>) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { method: "GET", headers, signal: controller.signal });
      if (!response.ok) {
        let body = "";
        try { body = (await response.text()).slice(0, 500); } catch { body = ""; }
        return { ok: false, status: response.status, body };
      }
      const buf = await response.arrayBuffer();
      if (buf.byteLength > maxBytes) {
        return { ok: false, status: response.status, body: `Response exceeded ${maxBytes} byte cap (got ${buf.byteLength}).` };
      }
      const bytes = new Uint8Array(buf);
      const ct = response.headers.get("content-type") ?? undefined;
      const mimeType = ct ? ct.split(";")[0]!.trim() : undefined;
      return { ok: true, status: response.status, bytes, mimeType };
    } finally {
      clearTimeout(timer);
    }
  };
}

function sanitizeHeaders(raw: Record<string, string> | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== "string" || key.length === 0) continue;
    if (typeof value !== "string") continue;
    out[key] = value;
  }
  return out;
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return "<unparseable-url>"; }
}

function basenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
    return last || "download";
  } catch {
    return "download";
  }
}

async function emitAudit(
  config: RuntimeConfig,
  taskId: string | undefined,
  params: SignedDownloadParams,
  ok: boolean,
  status: number | undefined,
  mimeType: string | undefined,
  size: number | undefined,
  errorSnippet: string | undefined
) {
  await mutateState(config.instance, (state) => {
    const ctx = taskId ? { taskId } : { system: true as const };
    addAudit(
      state,
      {
        actor: taskId ? "agent" : "runtime",
        action: "signed_download",
        target: hostOf(params.url),
        risk: "medium",
        taskId,
        evidence: {
          host: hostOf(params.url),
          ok,
          status: status ?? null,
          mimeType: mimeType ?? null,
          size: size ?? null,
          headerKeys: Object.keys(params.headers ?? {}),
          error: errorSnippet ? errorSnippet.slice(0, 200) : undefined
        }
      },
      ctx
    );
  });
}
