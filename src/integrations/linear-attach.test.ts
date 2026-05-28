import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { mutateState } from "../state";
import { writeSecret } from "../state/secrets";
import { storeUpload } from "../state/uploads";
import type { ConnectorRecord, McpServerRecord, RuntimeConfig } from "../types";
import { attachImageToLinearIssue, type LinearPutBytes } from "./linear-attach";

const ROOT = "/tmp/gini-linear-attach-unit";
const originalFetch = globalThis.fetch;

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "t",
    provider: { name: "echo" as const, model: "echo" },
    workspaceRoot: `${ROOT}/${instance}/workspace`,
    stateRoot: `${ROOT}/${instance}`,
    logRoot: `${ROOT}/${instance}/logs`
  };
}

function makeConnector(overrides: Partial<ConnectorRecord>): ConnectorRecord {
  return {
    id: "id_linear",
    instance: "dev",
    name: "linear",
    provider: "linear",
    status: "configured",
    scopes: [],
    secretRefs: [],
    createdAt: "",
    updatedAt: "",
    health: "healthy",
    ...overrides
  };
}

function makeServer(overrides: Partial<McpServerRecord>): McpServerRecord {
  return {
    id: "mcp_linear",
    instance: "dev",
    name: "linear",
    command: "",
    args: [],
    envKeys: [],
    status: "configured",
    exposedTools: [],
    createdAt: "",
    updatedAt: "",
    transport: "http",
    url: "https://mcp.linear.app/mcp",
    headers: {
      Authorization: "Bearer ${LINEAR_API_KEY}"
    },
    ...overrides
  };
}

async function seedLinear(instance: string) {
  const ref = writeSecret(instance, "id_linear", "token", "lin_api_FAKE_FOR_TESTS");
  await mutateState(instance, (state) => {
    state.connectors.push(makeConnector({ instance, secretRefs: [ref] }));
    state.mcpServers.push(makeServer({ instance }));
  });
}

// Stub the Linear MCP HTTP endpoint by routing tools/call requests to a
// dispatch map. Returns SSE-shaped JSON-RPC envelopes (the framing Linear
// itself uses).
type ToolReply = { result?: unknown; isError?: boolean; errorMessage?: string };
function stubLinearMcp(toolMap: Record<string, (args: Record<string, unknown>) => ToolReply>) {
  globalThis.fetch = (async (_url: unknown, init: RequestInit | undefined) => {
    const parsed = JSON.parse(String(init?.body ?? "{}")) as {
      id?: number;
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    const id = parsed.id ?? 0;
    if (parsed.method !== "tools/call") {
      // Fallthrough for any unexpected call (e.g. initialize during health checks).
      const body = { jsonrpc: "2.0", id, result: {} };
      return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, {
        headers: { "content-type": "text/event-stream" }
      });
    }
    const name = parsed.params?.name ?? "";
    const handler = toolMap[name];
    if (!handler) {
      const body = {
        jsonrpc: "2.0",
        id,
        result: { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] }
      };
      return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, {
        headers: { "content-type": "text/event-stream" }
      });
    }
    const reply = handler(parsed.params?.arguments ?? {});
    const body = {
      jsonrpc: "2.0",
      id,
      result: {
        isError: reply.isError === true,
        content: [
          {
            type: "text",
            text: reply.isError
              ? reply.errorMessage ?? "tool errored"
              : JSON.stringify(reply.result ?? {})
          }
        ]
      }
    };
    return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, {
      headers: { "content-type": "text/event-stream" }
    });
  }) as unknown as typeof fetch;
}

describe("attachImageToLinearIssue", () => {
  test("uploads bytes and finalizes the attachment", async () => {
    const instance = "linear-attach-happy";
    const config = makeConfig(instance);
    await seedLinear(instance);
    const upload = storeUpload(instance, new Uint8Array([1, 2, 3, 4, 5]), "image/png", "bug.png");

    const prepareSeen: Record<string, unknown>[] = [];
    const finalizeSeen: Record<string, unknown>[] = [];
    stubLinearMcp({
      prepare_attachment_upload: (args) => {
        prepareSeen.push(args);
        return {
          result: {
            uploadRequest: {
              url: "https://uploads.linear.app/signed/123",
              headers: {
                "content-type": "image/png",
                "x-goog-content-length-range": "5,5"
              }
            },
            assetUrl: "https://uploads.linear.app/asset/abc"
          }
        };
      },
      create_attachment_from_upload: (args) => {
        finalizeSeen.push(args);
        return {
          result: {
            attachment: { id: "att_1", url: "https://uploads.linear.app/asset/abc", title: "Bug" }
          }
        };
      }
    });

    const putCalls: Array<{ url: string; headers: Record<string, string>; size: number }> = [];
    const stubPut: LinearPutBytes = async (url, headers, bytes) => {
      putCalls.push({ url, headers, size: bytes.length });
      return { ok: true, status: 200 };
    };

    const result = await attachImageToLinearIssue(
      config,
      "task_test",
      { issue: "LIN-42", uploadId: upload.id, title: "Bug" },
      stubPut
    );

    expect(result.ok).toBe(true);
    expect(result.assetUrl).toBe("https://uploads.linear.app/asset/abc");
    expect(result.attachment).toMatchObject({ attachment: { id: "att_1" } });
    expect(prepareSeen[0]).toMatchObject({
      issue: "LIN-42",
      contentType: "image/png",
      size: 5,
      title: "Bug"
    });
    expect(finalizeSeen[0]).toMatchObject({
      issue: "LIN-42",
      assetUrl: "https://uploads.linear.app/asset/abc",
      title: "Bug"
    });
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]!.url).toBe("https://uploads.linear.app/signed/123");
    expect(putCalls[0]!.headers["content-type"]).toBe("image/png");
    expect(putCalls[0]!.size).toBe(5);
  });

  test("returns an error when the upload id is unknown", async () => {
    const instance = "linear-attach-missing-upload";
    const config = makeConfig(instance);
    await seedLinear(instance);
    const result = await attachImageToLinearIssue(
      config,
      "task_test",
      { issue: "LIN-42", uploadId: "does-not-exist" }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Upload not found/);
  });

  test("returns an error when Linear MCP server is not configured", async () => {
    const instance = "linear-attach-no-server";
    const config = makeConfig(instance);
    const upload = storeUpload(instance, new Uint8Array([1, 2, 3]), "image/png");
    const result = await attachImageToLinearIssue(
      config,
      "task_test",
      { issue: "LIN-42", uploadId: upload.id }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Linear MCP server is not configured/);
  });

  test("surfaces a finalize failure but keeps the assetUrl as a fallback", async () => {
    const instance = "linear-attach-finalize-fails";
    const config = makeConfig(instance);
    await seedLinear(instance);
    const upload = storeUpload(instance, new Uint8Array([9, 9, 9]), "image/png");
    stubLinearMcp({
      prepare_attachment_upload: () => ({
        result: {
          uploadRequest: { url: "https://uploads.linear.app/signed/x", headers: { "content-type": "image/png" } },
          assetUrl: "https://uploads.linear.app/asset/x"
        }
      }),
      create_attachment_from_upload: () => ({ isError: true, errorMessage: "rate limited" })
    });
    const stubPut: LinearPutBytes = async () => ({ ok: true, status: 200 });
    const result = await attachImageToLinearIssue(
      config,
      "task_test",
      { issue: "LIN-42", uploadId: upload.id },
      stubPut
    );
    expect(result.ok).toBe(false);
    expect(result.assetUrl).toBe("https://uploads.linear.app/asset/x");
    expect(result.error).toMatch(/create_attachment_from_upload failed/);
  });

  test("surfaces a PUT failure without calling finalize", async () => {
    const instance = "linear-attach-put-fails";
    const config = makeConfig(instance);
    await seedLinear(instance);
    const upload = storeUpload(instance, new Uint8Array([1, 2]), "image/png");
    let finalizeCalls = 0;
    stubLinearMcp({
      prepare_attachment_upload: () => ({
        result: {
          uploadRequest: { url: "https://uploads.linear.app/signed/y", headers: { "content-type": "image/png" } },
          assetUrl: "https://uploads.linear.app/asset/y"
        }
      }),
      create_attachment_from_upload: () => {
        finalizeCalls += 1;
        return { result: { attachment: {} } };
      }
    });
    const stubPut: LinearPutBytes = async () => ({ ok: false, status: 403, body: "expired" });
    const result = await attachImageToLinearIssue(
      config,
      "task_test",
      { issue: "LIN-42", uploadId: upload.id },
      stubPut
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Direct file upload to Linear failed/);
    expect(finalizeCalls).toBe(0);
  });
});
