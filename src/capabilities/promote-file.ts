// promote_file: register a workspace file as a Gini upload.
//
// Closes the "agent-produced bytes" gap: code_exec generates a chart, a
// terminal command produces a downloaded file, a future browser_capture
// drops a screenshot in workspace — all of those produce bytes the model
// can't directly route into upload-aware tools (signed_upload,
// vision_query, the chat-message marker) because uploads live in a
// separate addressable space.
//
// `promote_file({path})` reads the workspace file, stores it as an
// upload via the same code path `storeUpload` uses for chat-attached
// bytes, and returns the new uploadId. The workspace-escape guard is the
// same one file_read / file_write / browser_upload use.

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import type { RuntimeConfig } from "../types";
import { addAudit, appendTrace, assertInsideWorkspace, mutateState } from "../state";
import { storeUpload } from "../state/uploads";

export interface PromoteFileParams {
  path: string;
  // Optional explicit mime override. Defaults to extension-based sniff
  // with `application/octet-stream` as the fallback for unknown extensions.
  mimeType?: string;
}

export interface PromoteFileResult {
  ok: boolean;
  error?: string;
  uploadId?: string;
  mimeType?: string;
  size?: number;
}

const DEFAULT_MAX_BYTES = 200 * 1024 * 1024; // 200MB cap. Same order as signed_download.

export interface InvokePromoteFileOptions {
  taskId?: string;
  maxBytes?: number;
}

export async function invokePromoteFile(
  config: RuntimeConfig,
  params: PromoteFileParams,
  options: InvokePromoteFileOptions = {}
): Promise<PromoteFileResult> {
  if (!params.path) return { ok: false, error: "path is required." };
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let absolute: string;
  try {
    absolute = assertInsideWorkspace(config.workspaceRoot, params.path);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!existsSync(absolute)) {
    return { ok: false, error: `File not found: ${params.path}` };
  }
  let stat;
  try {
    stat = statSync(absolute);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!stat.isFile()) {
    return { ok: false, error: `Not a regular file: ${params.path}` };
  }
  if (stat.size === 0) {
    return { ok: false, error: `File is empty: ${params.path}` };
  }
  if (stat.size > maxBytes) {
    return { ok: false, error: `File exceeds ${maxBytes} byte cap (got ${stat.size}).` };
  }

  const bytes = new Uint8Array(readFileSync(absolute));
  const mimeType = params.mimeType?.trim() || mimeFromExtension(extname(absolute).toLowerCase());
  const filename = basename(absolute);

  appendTrace(config.instance, options.taskId ?? "", {
    type: "tool",
    message: `promote_file ${filename}`,
    data: { path: params.path, mimeType, size: stat.size }
  });

  let attachment;
  try {
    attachment = storeUpload(config.instance, bytes, mimeType, filename);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await emitAudit(config, options.taskId, params, false, mimeType, stat.size, message);
    return { ok: false, error: `Could not store upload: ${message}` };
  }

  await emitAudit(config, options.taskId, params, true, mimeType, attachment.size, undefined);
  return { ok: true, uploadId: attachment.id, mimeType, size: attachment.size };
}

// Sniffing from extension is intentionally minimal — we cover the cases
// where the chat surface or vision context cares about the mime
// (images, PDFs, common text formats) and fall through to
// application/octet-stream for the rest. The model can override with
// `mimeType` when it knows better.
function mimeFromExtension(ext: string): string {
  switch (ext) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".svg": return "image/svg+xml";
    case ".heic": return "image/heic";
    case ".heif": return "image/heif";
    case ".pdf": return "application/pdf";
    case ".json": return "application/json";
    case ".txt":
    case ".log": return "text/plain";
    case ".md": return "text/markdown";
    case ".csv": return "text/csv";
    case ".html":
    case ".htm": return "text/html";
    case ".xml": return "application/xml";
    case ".zip": return "application/zip";
    default: return "application/octet-stream";
  }
}

async function emitAudit(
  config: RuntimeConfig,
  taskId: string | undefined,
  params: PromoteFileParams,
  ok: boolean,
  mimeType: string,
  size: number,
  errorSnippet: string | undefined
) {
  await mutateState(config.instance, (state) => {
    const ctx = taskId ? { taskId } : { system: true as const };
    addAudit(
      state,
      {
        actor: taskId ? "agent" : "runtime",
        action: "promote_file",
        target: params.path,
        risk: "low",
        taskId,
        evidence: {
          path: params.path,
          mimeType,
          size,
          ok,
          error: errorSnippet ? errorSnippet.slice(0, 200) : undefined
        }
      },
      ctx
    );
  });
}
