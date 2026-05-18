import { describe, expect, test } from "bun:test";
import { createDiscordClient, extractIncomingPayload, type DiscordFetch, type DiscordMessage } from "./discord";

function stubFetch(handler: (url: string, init: RequestInit) => unknown): DiscordFetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const result = handler(url, init ?? {});
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as DiscordFetch;
}

describe("discord client", () => {
  test("getMe hits /users/@me with Bot auth and unwraps the identity", async () => {
    let observedUrl = "";
    let observedHeaders: Record<string, string> = {};
    const client = createDiscordClient("TOK", {
      fetchImpl: stubFetch((url, init) => {
        observedUrl = url;
        observedHeaders = (init.headers ?? {}) as Record<string, string>;
        return { id: "100", username: "Gini", discriminator: "3715", bot: true };
      })
    });
    const me = await client.getMe();
    expect(observedUrl.endsWith("/users/@me")).toBe(true);
    expect(observedHeaders.authorization).toBe("Bot TOK");
    expect(me.username).toBe("Gini");
    expect(me.id).toBe("100");
  });

  test("sendMessage POSTs the channel-messages endpoint with content", async () => {
    let payload: Record<string, unknown> = {};
    let observedUrl = "";
    const client = createDiscordClient("TOK", {
      fetchImpl: stubFetch((url, init) => {
        observedUrl = url;
        payload = JSON.parse(String(init.body));
        return { id: "200", channel_id: "999", content: payload.content };
      })
    });
    const msg = await client.sendMessage("999", "hi");
    expect(observedUrl).toContain("/channels/999/messages");
    expect(payload).toEqual({ content: "hi" });
    expect(msg.id).toBe("200");
  });

  test("sendMessage truncates content past Discord's 2000-char ceiling", async () => {
    let observedContent = "";
    const client = createDiscordClient("TOK", {
      fetchImpl: stubFetch((_url, init) => {
        observedContent = (JSON.parse(String(init.body)) as { content: string }).content;
        return { id: "201", channel_id: "999", content: observedContent };
      })
    });
    await client.sendMessage("999", "x".repeat(2100));
    expect(observedContent.length).toBe(2000);
  });

  test("triggerTypingIndicator POSTs /typing and accepts the 204 No Content response", async () => {
    let observedUrl = "";
    const client = createDiscordClient("TOK", {
      fetchImpl: stubFetch((url) => {
        observedUrl = url;
        return new Response(null, { status: 204 });
      })
    });
    const ok = await client.triggerTypingIndicator("999");
    expect(observedUrl).toContain("/channels/999/typing");
    expect(ok).toBe(true);
  });

  test("fetchChannelMessages forwards the snowflake watermark as `after`", async () => {
    let observedUrl = "";
    const client = createDiscordClient("TOK", {
      fetchImpl: stubFetch((url) => {
        observedUrl = url;
        return [{ id: "10", channel_id: "999", content: "x", timestamp: "t", author: { id: "u", username: "u" } }];
      })
    });
    await client.fetchChannelMessages("999", { afterId: "msg-9", limit: 25 });
    expect(observedUrl).toContain("/channels/999/messages");
    expect(observedUrl).toContain("limit=25");
    expect(observedUrl).toContain("after=msg-9");
  });

  test("fetchChannelMessages omits `after` on first poll", async () => {
    let observedUrl = "";
    const client = createDiscordClient("TOK", {
      fetchImpl: stubFetch((url) => {
        observedUrl = url;
        return [];
      })
    });
    await client.fetchChannelMessages("999");
    expect(observedUrl).toContain("limit=50");
    expect(observedUrl).not.toContain("after=");
  });

  test("API-level failure surfaces Discord's error message and code", async () => {
    const client = createDiscordClient("TOK", {
      fetchImpl: stubFetch(
        () =>
          new Response(JSON.stringify({ message: "Missing Access", code: 50001 }), {
            status: 403,
            headers: { "content-type": "application/json" }
          })
      )
    });
    await expect(client.sendMessage("999", "hi")).rejects.toThrow(/Missing Access \(code 50001\)/);
  });

  test("non-JSON error body falls back to the HTTP status", async () => {
    const client = createDiscordClient("TOK", {
      fetchImpl: stubFetch(() => new Response("nope", { status: 500 }))
    });
    await expect(client.getMe()).rejects.toThrow(/HTTP 500/);
  });

  test("empty token is rejected up front", () => {
    expect(() => createDiscordClient("")).toThrow(/required/);
  });

  test("sendMessage and triggerTypingIndicator refuse an empty channel id", async () => {
    const client = createDiscordClient("TOK", {
      fetchImpl: stubFetch(() => ({}))
    });
    await expect(client.sendMessage("", "hi")).rejects.toThrow(/channel id/);
    await expect(client.triggerTypingIndicator("")).rejects.toThrow(/channel id/);
  });
});

describe("extractIncomingPayload", () => {
  function message(overrides: Partial<DiscordMessage>): DiscordMessage {
    return {
      id: "1",
      channel_id: "999",
      content: "hi",
      timestamp: "2026-01-01T00:00:00Z",
      author: { id: "u", username: "user", bot: false },
      ...overrides
    };
  }

  test("surfaces a non-bot text message", () => {
    const out = extractIncomingPayload(message({ id: "10", content: "hello" }));
    expect(out).toEqual({
      externalId: "10",
      channelId: "999",
      text: "hello",
      authorHandle: "user",
      authorIsBot: false,
      createdAt: "2026-01-01T00:00:00Z"
    });
  });

  test("prefers global_name over username when both are present", () => {
    const out = extractIncomingPayload(
      message({ author: { id: "u", username: "raw_handle", global_name: "Display Name" } })
    );
    expect(out?.authorHandle).toBe("Display Name");
  });

  test("marks bot-authored messages so the poller can skip them", () => {
    const out = extractIncomingPayload(message({ author: { id: "b", username: "Gini", bot: true } }));
    expect(out?.authorIsBot).toBe(true);
  });

  test("returns undefined for empty content (attachment-only / embed-only posts)", () => {
    expect(extractIncomingPayload(message({ content: "" }))).toBeUndefined();
  });
});
