import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { RuntimeConfig } from "../types";
import { readState } from "../state";
import {
  addMessagingBridge,
  checkMessagingBridge,
  disableMessagingBridge,
  readBridgeBotToken,
  resetMessagingDeps,
  sendMessagingOutput,
  setMessagingDeps
} from "./messaging";
import type { TelegramClient } from "./telegram";
import type { DiscordClient } from "./discord";

function testConfig(instance: string): RuntimeConfig {
  const root = "/tmp/gini-messaging-tests";
  process.env.GINI_STATE_ROOT = root;
  process.env.GINI_LOG_ROOT = `${root}-logs`;
  rmSync(`${root}/instances/${instance}`, { recursive: true, force: true });
  return {
    instance,
    port: 7338,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: `${root}/instances/${instance}`,
    logRoot: `${root}-logs/${instance}`
  };
}

interface StubCall { method: string; args: unknown[] }

// Wait for a set of task ids to reach a terminal state before
// returning. Used by tests that spawn real chat tasks through
// receiveMessagingInput — submitTask runs runTask detached, and a
// task still in flight when the next test file's testConfig rebinds
// GINI_STATE_ROOT would land its state write against the wrong
// instance directory and throw "Task not found".
async function waitForTaskSettled(
  config: RuntimeConfig,
  taskIds: string[],
  isTerminal: (status: import("../types").TaskStatus) => boolean,
  timeoutMs = 5000
): Promise<void> {
  const { readState } = await import("../state");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tasks = readState(config.instance).tasks;
    const allDone = taskIds.every((id) => {
      const task = tasks.find((t) => t.id === id);
      return task ? isTerminal(task.status) : false;
    });
    if (allDone) return;
    await Bun.sleep(10);
  }
  throw new Error(`Tasks did not settle within ${timeoutMs}ms: ${taskIds.join(", ")}`);
}

function stubClient(overrides: Partial<TelegramClient> = {}): { client: TelegramClient; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const client: TelegramClient = {
    getMe: async () => {
      calls.push({ method: "getMe", args: [] });
      return { id: 11, is_bot: true, username: "ginibot" };
    },
    sendMessage: async (chatId, text, opts) => {
      calls.push({ method: "sendMessage", args: [chatId, text, opts] });
      return { message_id: 1, date: 0, chat: { id: Number(chatId), type: "private" }, text };
    },
    sendChatAction: async (chatId, action) => {
      calls.push({ method: "sendChatAction", args: [chatId, action] });
      return true as const;
    },
    sendPhoto: async (chatId, source, opts) => {
      calls.push({ method: "sendPhoto", args: [chatId, source, opts] });
      return { message_id: 2, date: 0, chat: { id: Number(chatId), type: "private" } };
    },
    getFile: async (fileId) => {
      calls.push({ method: "getFile", args: [fileId] });
      return { file_id: fileId, file_unique_id: fileId, file_path: `photos/${fileId}.jpg` };
    },
    downloadFile: async (path) => {
      calls.push({ method: "downloadFile", args: [path] });
      return new Uint8Array([1, 2, 3]).buffer;
    },
    getUpdates: async () => {
      calls.push({ method: "getUpdates", args: [] });
      return [];
    },
    ...overrides
  };
  return { client, calls };
}

describe("messaging telegram wiring", () => {
  afterEach(() => resetMessagingDeps());

  test("addMessagingBridge requires a botToken for telegram and persists it via the secret store", async () => {
    const config = testConfig("telegram-add");

    await expect(
      addMessagingBridge(config, { name: "tg", kind: "telegram", deliveryTargets: ["123"] })
    ).rejects.toThrow(/botToken/);

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["123"],
      botToken: "SECRET-TOKEN"
    });

    expect(bridge.kind).toBe("telegram");
    expect(bridge.secretRefs?.[0]?.purpose).toBe("bot-token");
    // The plaintext token must round-trip through the encrypted store but
    // must never appear on the bridge record itself.
    expect(JSON.stringify(bridge)).not.toContain("SECRET-TOKEN");
    expect(readBridgeBotToken(config, bridge)).toBe("SECRET-TOKEN");
  });

  test("checkMessagingBridge calls getMe and records the bot username on metadata", async () => {
    const config = testConfig("telegram-health");
    const { client, calls } = stubClient();
    setMessagingDeps({ telegramClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["123"],
      botToken: "TOK"
    });
    const checked = await checkMessagingBridge(config, bridge.id);

    expect(calls.map((c) => c.method)).toEqual(["getMe"]);
    expect(checked.status).toBe("configured");
    expect(checked.metadata?.botUsername).toBe("ginibot");
    expect(checked.message).toContain("@ginibot");
  });

  test("checkMessagingBridge surfaces a telegram error as bridge.status=error", async () => {
    const config = testConfig("telegram-health-err");
    setMessagingDeps({
      telegramClientFactory: () => stubClient({ getMe: async () => { throw new Error("Unauthorized"); } }).client
    });

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["123"],
      botToken: "TOK"
    });
    const checked = await checkMessagingBridge(config, bridge.id);

    expect(checked.status).toBe("error");
    expect(checked.message).toContain("Unauthorized");
  });

  test("sendMessagingOutput dispatches to Telegram and records sent status", async () => {
    const config = testConfig("telegram-send");
    const { client, calls } = stubClient();
    setMessagingDeps({ telegramClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["42"],
      botToken: "TOK"
    });
    const outbound = await sendMessagingOutput(config, bridge.id, { text: "hi from gini" });

    expect(outbound.status).toBe("sent");
    expect(outbound.target).toBe("42");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("sendMessage");
    const [chatId, payload, opts] = calls[0]!.args as [string, string, { parseMode?: string } | undefined];
    expect(chatId).toBe("42");
    expect(payload).toBe("hi from gini");
    expect(opts?.parseMode).toBe("MarkdownV2");
  });

  test("MarkdownV2 transform runs on outbound text by default", async () => {
    const config = testConfig("telegram-send-mdv2");
    const { client, calls } = stubClient();
    setMessagingDeps({ telegramClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["1"],
      botToken: "TOK"
    });
    await sendMessagingOutput(config, bridge.id, { text: "see **README.md**!" });

    const [, payload, opts] = calls[0]!.args as [string, string, { parseMode?: string } | undefined];
    expect(payload).toBe("see *README\\.md*\\!");
    expect(opts?.parseMode).toBe("MarkdownV2");
  });

  test("parseMode=\"none\" skips the transform and sends raw text", async () => {
    const config = testConfig("telegram-send-raw");
    const { client, calls } = stubClient();
    setMessagingDeps({ telegramClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["1"],
      botToken: "TOK"
    });
    await sendMessagingOutput(config, bridge.id, { text: "ver. 1.2", parseMode: "none" });

    const [, payload, opts] = calls[0]!.args as [string, string, { parseMode?: string } | undefined];
    expect(payload).toBe("ver. 1.2");
    expect(opts).toBeUndefined();
  });

  test("sendMessagingOutput marks the message failed when Telegram throws", async () => {
    const config = testConfig("telegram-send-err");
    setMessagingDeps({
      telegramClientFactory: () =>
        stubClient({ sendMessage: async () => { throw new Error("Bad Request: chat not found"); } }).client
    });

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["999"],
      botToken: "TOK"
    });
    const outbound = await sendMessagingOutput(config, bridge.id, { text: "hello" });

    expect(outbound.status).toBe("failed");
    expect(outbound.error).toContain("chat not found");
  });

  test("photo input dispatches sendPhoto with the caption and MarkdownV2 parseMode", async () => {
    const config = testConfig("telegram-send-photo-url");
    const { client, calls } = stubClient();
    setMessagingDeps({ telegramClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["55"],
      botToken: "TOK"
    });

    const outbound = await sendMessagingOutput(config, bridge.id, {
      text: "see **chart.png**",
      photo: { url: "https://example.com/c.png" }
    });

    expect(outbound.status).toBe("sent");
    expect(outbound.media).toEqual({ kind: "photo", url: "https://example.com/c.png" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("sendPhoto");
    const [chatId, source, opts] = calls[0]!.args as [
      string,
      { kind: string; url?: string },
      { caption?: string; parseMode?: string }
    ];
    expect(chatId).toBe("55");
    expect(source).toEqual({ kind: "url", url: "https://example.com/c.png" });
    expect(opts?.caption).toBe("see *chart\\.png*");
    expect(opts?.parseMode).toBe("MarkdownV2");
  });

  test("photo input with no text sends a photo without a caption", async () => {
    const config = testConfig("telegram-send-photo-nocaption");
    const { client, calls } = stubClient();
    setMessagingDeps({ telegramClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["1"],
      botToken: "TOK"
    });

    await sendMessagingOutput(config, bridge.id, {
      photo: { fileId: "AgADX1Q" }
    });

    const [, source, opts] = calls[0]!.args as [string, unknown, { caption?: string; parseMode?: string }];
    expect(source).toEqual({ kind: "fileId", fileId: "AgADX1Q" });
    expect(opts?.caption).toBeUndefined();
    expect(opts?.parseMode).toBeUndefined();
  });

  test("send requires either text or a photo", async () => {
    const config = testConfig("telegram-send-empty");
    setMessagingDeps({ telegramClientFactory: () => stubClient().client });
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["1"],
      botToken: "TOK"
    });
    await expect(sendMessagingOutput(config, bridge.id, {})).rejects.toThrow(/text or a photo/);
  });

  test("telegram inbound runs through a per-chat ChatSession (creates once, reuses on next message)", async () => {
    const config = testConfig("telegram-inbound-chat-session");
    const { client } = stubClient();
    setMessagingDeps({ telegramClientFactory: () => client });

    const { receiveMessagingInput, findTelegramChatSession } = await import("./messaging");
    const { readState } = await import("../state");

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: [],
      botToken: "TOK"
    });

    await receiveMessagingInput(config, bridge.id, { text: "first", target: "555" });
    await receiveMessagingInput(config, bridge.id, { text: "second", target: "555" });

    const sessions = readState(config.instance).chatSessions;
    const telegramSessions = sessions.filter(
      (s) => s.source?.kind === "telegram" && s.source.bridgeId === bridge.id && s.source.chatId === 555
    );
    expect(telegramSessions).toHaveLength(1);
    expect(telegramSessions[0]?.source).toEqual({
      kind: "telegram",
      bridgeId: bridge.id,
      chatId: 555,
      target: "555"
    });

    const found = findTelegramChatSession(config, bridge.id, 555);
    expect(found?.id).toBe(telegramSessions[0]!.id);

    // Both user turns landed in the same session.
    const userMessages = readState(config.instance).chatMessages.filter(
      (m) => m.sessionId === telegramSessions[0]!.id && m.role === "user"
    );
    expect(userMessages.map((m) => m.content)).toEqual(["first", "second"]);
  });

  test("non-telegram bridges keep using the standalone-task path", async () => {
    const config = testConfig("messaging-demo-no-chat-session");
    setMessagingDeps({ telegramClientFactory: () => stubClient().client });

    const { receiveMessagingInput } = await import("./messaging");
    const { readState } = await import("../state");

    // Demo bridges don't need a token and don't go through chat sessions.
    const bridge = await addMessagingBridge(config, {
      name: "local",
      kind: "demo",
      deliveryTargets: ["local"]
    });
    await receiveMessagingInput(config, bridge.id, { text: "hello", target: "local" });

    const sessions = readState(config.instance).chatSessions;
    expect(sessions.filter((s) => s.source !== undefined)).toEqual([]);
  });

  test("disableMessagingBridge erases the stored bot token", async () => {
    const config = testConfig("telegram-disable");
    setMessagingDeps({ telegramClientFactory: () => stubClient().client });

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["1"],
      botToken: "TOK"
    });
    await disableMessagingBridge(config, bridge.id);
    const live = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);

    expect(live?.status).toBe("disabled");
    expect(live?.secretRefs ?? []).toEqual([]);
    // Reading a token after disable must fail (file gone), so the helper
    // returns undefined for a bridge with no refs.
    expect(readBridgeBotToken(config, live!)).toBeUndefined();
  });
});

interface DiscordStubCall { method: string; args: unknown[] }

function stubDiscordClient(overrides: Partial<DiscordClient> = {}): { client: DiscordClient; calls: DiscordStubCall[] } {
  const calls: DiscordStubCall[] = [];
  const client: DiscordClient = {
    getMe: async () => {
      calls.push({ method: "getMe", args: [] });
      return { id: "100", username: "Gini", discriminator: "3715", bot: true };
    },
    sendMessage: async (channelId, content) => {
      calls.push({ method: "sendMessage", args: [channelId, content] });
      return {
        id: "msg-1",
        channel_id: channelId,
        content,
        timestamp: "2026-01-01T00:00:00Z",
        author: { id: "100", username: "Gini", bot: true }
      };
    },
    triggerTypingIndicator: async (channelId) => {
      calls.push({ method: "triggerTypingIndicator", args: [channelId] });
      return true as const;
    },
    fetchChannelMessages: async () => {
      calls.push({ method: "fetchChannelMessages", args: [] });
      return [];
    },
    ...overrides
  };
  return { client, calls };
}

describe("messaging discord wiring", () => {
  afterEach(() => resetMessagingDeps());

  test("addMessagingBridge requires a botToken for discord and persists it via the secret store", async () => {
    const config = testConfig("discord-add");

    await expect(
      addMessagingBridge(config, { name: "disc", kind: "discord", deliveryTargets: ["999"] })
    ).rejects.toThrow(/botToken/);

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["999"],
      botToken: "SECRET-TOKEN"
    });

    expect(bridge.kind).toBe("discord");
    expect(bridge.secretRefs?.[0]?.purpose).toBe("bot-token");
    expect(readBridgeBotToken(config, bridge)).toBe("SECRET-TOKEN");
  });

  test("checkMessagingBridge round-trips getMe and stores the bot identity on metadata", async () => {
    const config = testConfig("discord-health");
    const { client, calls } = stubDiscordClient();
    setMessagingDeps({ discordClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["999"],
      botToken: "TOK"
    });

    const checked = await checkMessagingBridge(config, bridge.id);
    expect(checked.status).toBe("configured");
    expect(String(checked.message)).toContain("Gini#3715");
    expect(checked.metadata?.botUsername).toBe("Gini");
    expect(checked.metadata?.botId).toBe("100");
    expect(calls.some((c) => c.method === "getMe")).toBe(true);
  });

  test("checkMessagingBridge surfaces the API error description on failure", async () => {
    const config = testConfig("discord-health-fail");
    const { client } = stubDiscordClient({
      getMe: async () => {
        throw new Error("401: Unauthorized");
      }
    });
    setMessagingDeps({ discordClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["999"],
      botToken: "TOK"
    });

    const checked = await checkMessagingBridge(config, bridge.id);
    expect(checked.status).toBe("error");
    expect(String(checked.message)).toContain("401: Unauthorized");
  });

  test("checkMessagingBridge handles the new global_name account shape (discriminator '0')", async () => {
    const config = testConfig("discord-health-globalname");
    const { client } = stubDiscordClient({
      getMe: async () => ({ id: "5", username: "raw.handle", discriminator: "0", global_name: "Display Name", bot: true })
    });
    setMessagingDeps({ discordClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["999"],
      botToken: "TOK"
    });

    const checked = await checkMessagingBridge(config, bridge.id);
    expect(checked.status).toBe("configured");
    expect(String(checked.message)).toContain("Display Name");
    expect(String(checked.message)).not.toContain("#0");
  });

  test("sendMessagingOutput dispatches via REST and records the outbound message", async () => {
    const config = testConfig("discord-send");
    const { client, calls } = stubDiscordClient();
    setMessagingDeps({ discordClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });

    const message = await sendMessagingOutput(config, bridge.id, { text: "hi gini" });
    expect(message.status).toBe("sent");
    expect(message.target).toBe("chan-1");

    const send = calls.find((c) => c.method === "sendMessage");
    expect(send).toBeDefined();
    expect(send?.args).toEqual(["chan-1", "hi gini"]);
  });

  test("sendMessagingOutput records 'failed' with the API description on send failure", async () => {
    const config = testConfig("discord-send-fail");
    const { client } = stubDiscordClient({
      sendMessage: async () => {
        throw new Error("Missing Access (code 50001)");
      }
    });
    setMessagingDeps({ discordClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });

    const message = await sendMessagingOutput(config, bridge.id, { text: "hi" });
    expect(message.status).toBe("failed");
    expect(String(message.error)).toContain("Missing Access");
  });

  test("sendMessagingOutput refuses empty text without hitting the API", async () => {
    const config = testConfig("discord-send-empty");
    const { client, calls } = stubDiscordClient();
    setMessagingDeps({ discordClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });

    // sendMessagingOutput's top-level guard rejects empty text outright;
    // verify we never reach the API.
    await expect(
      sendMessagingOutput(config, bridge.id, { text: "" })
    ).rejects.toThrow(/text or a photo/);
    expect(calls.find((c) => c.method === "sendMessage")).toBeUndefined();
  });

  test("disableMessagingBridge clears secrets for discord-kind bridges", async () => {
    const config = testConfig("discord-disable");
    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });
    await disableMessagingBridge(config, bridge.id);
    const live = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);
    expect(live?.status).toBe("disabled");
    expect(live?.secretRefs ?? []).toEqual([]);
    expect(readBridgeBotToken(config, live!)).toBeUndefined();
  });

  test("discord inbound runs through a per-channel ChatSession (creates once, reuses on next message)", async () => {
    const config = testConfig("discord-inbound-chat-session");
    const { client } = stubDiscordClient();
    setMessagingDeps({ discordClientFactory: () => client });

    const { receiveMessagingInput, findDiscordChatSession } = await import("./messaging");
    const { isTerminalTaskStatus } = await import("../state");

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: [],
      botToken: "TOK"
    });

    const first = await receiveMessagingInput(config, bridge.id, { text: "first", target: "chan-1" });
    const second = await receiveMessagingInput(config, bridge.id, { text: "second", target: "chan-1" });

    const sessions = readState(config.instance).chatSessions;
    const discordSessions = sessions.filter(
      (s) => s.source?.kind === "discord" && s.source.bridgeId === bridge.id && s.source.channelId === "chan-1"
    );
    expect(discordSessions).toHaveLength(1);
    expect(discordSessions[0]?.source).toEqual({
      kind: "discord",
      bridgeId: bridge.id,
      channelId: "chan-1",
      target: "chan-1"
    });

    const found = findDiscordChatSession(config, bridge.id, "chan-1");
    expect(found?.id).toBe(discordSessions[0]!.id);

    const userMessages = readState(config.instance).chatMessages.filter(
      (m) => m.sessionId === discordSessions[0]!.id && m.role === "user"
    );
    expect(userMessages.map((m) => m.content)).toEqual(["first", "second"]);

    // Wait for the spawned chat tasks to reach a terminal state before
    // returning. submitTask runs runTask detached (.catch(failTask));
    // the next test file's testConfig rebinds GINI_STATE_ROOT, so a
    // task still in flight would resolve its state path against the
    // new root and throw "Task not found". Awaiting here keeps the
    // task lifecycle scoped to this test.
    await waitForTaskSettled(config, [first.taskId!, second.taskId!], isTerminalTaskStatus);
  });

  test("addMessagingBridge rejects bot tokens with non-printable / whitespace characters", async () => {
    // Without this gate, a token containing a control char would be
    // accepted, stored, and then leak via the eventual fetch error
    // (Bun echoes the auth header value in its rejection message,
    // which we'd persist to bridge.message).
    const config = testConfig("discord-bad-token");

    await expect(
      addMessagingBridge(config, {
        name: "disc",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "valid-prefix\ninjected"
      })
    ).rejects.toThrow(/invalid characters/);

    await expect(
      addMessagingBridge(config, {
        name: "disc",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "valid prefix space"
      })
    ).rejects.toThrow(/invalid characters/);

    // Same gate applies to Telegram tokens.
    await expect(
      addMessagingBridge(config, {
        name: "tg",
        kind: "telegram",
        deliveryTargets: ["1"],
        botToken: "valid-prefix\rinjected"
      })
    ).rejects.toThrow(/invalid characters/);
  });

  test("checkMessagingBridge marks status='error' when the underlying send error mentions the auth header (token is redacted)", async () => {
    // Belt-and-suspenders for the security fix: even if a future
    // code path lets a token reach a fetch and the underlying
    // transport echoes the auth header in its error, we redact it
    // before landing in state.
    const config = testConfig("discord-redact-error");
    const { client } = stubDiscordClient({
      getMe: async () => {
        throw new Error("Header 'authorization' has invalid value: 'Bot SUPER_SECRET_TOKEN_LEAK'");
      }
    });
    setMessagingDeps({ discordClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "valid-prefix"
    });

    const checked = await checkMessagingBridge(config, bridge.id);
    expect(checked.status).toBe("error");
    expect(String(checked.message)).not.toContain("SUPER_SECRET_TOKEN_LEAK");
    expect(String(checked.message)).toContain("Bot <redacted>");
  });

  test("checkMessagingBridge marks status='error' on a missing secret file instead of 500ing the API", async () => {
    // Before the readBridgeBotTokenQuiet fix, a missing on-disk
    // secret would throw ENOENT out of checkMessagingBridge, causing
    // the HTTP endpoint to 500 instead of producing a typed bridge
    // error the UI can surface.
    const config = testConfig("discord-missing-secret");
    setMessagingDeps({ discordClientFactory: () => stubDiscordClient().client });

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "valid-prefix"
    });

    // Wipe the secret file out from under the bridge. The record
    // still references it via secretRefs, so a naive read throws.
    const { rmSync } = await import("node:fs");
    const live = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);
    const ref = live?.secretRefs?.[0];
    expect(ref).toBeDefined();
    rmSync(ref!.path);

    const checked = await checkMessagingBridge(config, bridge.id);
    expect(checked.status).toBe("error");
    expect(String(checked.message)).toContain("Discord bot token is missing");
  });

  test("discord receiveMessagingInput refuses a missing target instead of silently routing to 'local'", async () => {
    // Pinpointed regression: the shared "local" default used to mask
    // the Discord guard. Now a missing target throws so the inbound
    // bug surfaces immediately instead of creating a session keyed
    // on the literal string "local".
    const config = testConfig("discord-no-target");
    setMessagingDeps({ discordClientFactory: () => stubDiscordClient().client });

    const { receiveMessagingInput } = await import("./messaging");

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: [],
      botToken: "TOK"
    });

    await expect(
      receiveMessagingInput(config, bridge.id, { text: "hi" })
    ).rejects.toThrow(/channel id/);

    await expect(
      receiveMessagingInput(config, bridge.id, { text: "hi", target: "" })
    ).rejects.toThrow(/channel id/);

    // No chat session should have been created for the failed calls.
    const sessions = readState(config.instance).chatSessions.filter(
      (s) => s.source?.kind === "discord" && s.source.bridgeId === bridge.id
    );
    expect(sessions).toEqual([]);
  });
});
