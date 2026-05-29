import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { readUpload } from "../state/uploads";
import type { RuntimeConfig } from "../types";
import { invokeSignedDownload } from "./signed-download";

const ROOT = "/tmp/gini-signed-download-unit";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function config(instance: string): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "t",
    provider: { name: "echo", model: "" },
    workspaceRoot: `${ROOT}/${instance}/workspace`,
    stateRoot: `${ROOT}/${instance}`,
    logRoot: `${ROOT}/${instance}/logs`
  };
}

describe("invokeSignedDownload", () => {
  test("happy path: GETs bytes, stores upload, returns ids", async () => {
    const instance = "sd-happy";
    const body = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const result = await invokeSignedDownload(
      config(instance),
      { url: "https://uploads.linear.app/asset/abc.png" },
      {
        fetchBytes: async () => ({ ok: true, status: 200, bytes: body, mimeType: "image/png" })
      }
    );
    expect(result.ok).toBe(true);
    expect(result.mimeType).toBe("image/png");
    expect(result.size).toBe(6);
    expect(result.uploadId).toBeTruthy();
    // Verify the upload actually landed and is readable.
    const stored = readUpload(instance, result.uploadId!);
    expect(stored).not.toBeNull();
    expect(stored!.bytes.length).toBe(6);
    expect(stored!.mimeType).toBe("image/png");
  });

  test("falls back to application/octet-stream when server omits content-type", async () => {
    const instance = "sd-no-mime";
    const result = await invokeSignedDownload(
      config(instance),
      { url: "https://example.test/blob" },
      {
        fetchBytes: async () => ({ ok: true, status: 200, bytes: new Uint8Array([9, 9]) })
      }
    );
    expect(result.ok).toBe(true);
    expect(result.mimeType).toBe("application/octet-stream");
  });

  test("rejects http:// — only https allowed", async () => {
    const instance = "sd-http";
    const result = await invokeSignedDownload(
      config(instance),
      { url: "http://example.com/insecure" },
      { fetchBytes: async () => ({ ok: true, status: 200, bytes: new Uint8Array([1]) }) }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/https/);
  });

  test("requires url", async () => {
    const instance = "sd-no-url";
    const result = await invokeSignedDownload(
      config(instance),
      { url: "" },
      { fetchBytes: async () => ({ ok: true, status: 200, bytes: new Uint8Array([1]) }) }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/url/);
  });

  test("surfaces non-2xx as ok=false with status + body snippet", async () => {
    const instance = "sd-404";
    const result = await invokeSignedDownload(
      config(instance),
      { url: "https://example.test/missing" },
      { fetchBytes: async () => ({ ok: false, status: 404, body: "Not Found" }) }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("404");
    expect(result.error).toContain("Not Found");
  });

  test("rejects empty response body", async () => {
    const instance = "sd-empty";
    const result = await invokeSignedDownload(
      config(instance),
      { url: "https://example.test/empty" },
      { fetchBytes: async () => ({ ok: true, status: 200, bytes: new Uint8Array(0) }) }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no bytes/);
  });

  test("defaults filename from URL path", async () => {
    const instance = "sd-default-name";
    const result = await invokeSignedDownload(
      config(instance),
      { url: "https://uploads.linear.app/a/b/screenshot-123.png" },
      { fetchBytes: async () => ({ ok: true, status: 200, bytes: new Uint8Array([1]), mimeType: "image/png" }) }
    );
    expect(result.ok).toBe(true);
    const stored = readUpload(instance, result.uploadId!);
    expect(stored?.filename).toBe("screenshot-123.png");
  });
});
