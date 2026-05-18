import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { RuntimeConfig } from "../types";
import { readState } from "../state";
import { addMessagingBridge, resetMessagingDeps, setMessagingDeps } from "./messaging";
import { createDiscordPollerSupervisor } from "./discord-poller";
import type { DiscordClient, DiscordMessage } from "./discord";

function testConfig(instance: string): RuntimeConfig {
  const root = "/tmp/gini-discord-poller-tests";
  process.env.GINI_STATE_ROOT = root;
  process.env.GINI_LOG_ROOT = `${root}-logs`;
  rmSync(`${root}/instances/${instance}`, { recursive: true, force: true });
  return {
    instance,
    port: 7339,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: `${root}/instances/${instance}`,
    logRoot: `${root}-logs/${instance}`
  };
}

// Programmable Discord client. Tests script per-channel fetch
// responses, then assert on state after the poller's tight-loop
// cadence has had a chance to run them. sendMessage / typing / getMe
// are no-ops that capture their inputs so the reply mirror + typing
// pulse can be observed in assertions.
function programmableClient(): {
  client: DiscordClient;
  enqueue: (channelId: string, messages: DiscordMessage[]) => void;
  failNext: (channelId: string, message: string) => void;
  sendCalls: Array<{ channelId: string; content: string }>;
  typingCalls: string[];
} {
  type QueueEntry = { kind: "ok"; messages: DiscordMessage[] } | { kind: "err"; message: string };
  const perChannel = new Map<string, QueueEntry[]>();
  const sendCalls: Array<{ channelId: string; content: string }> = [];
  const typingCalls: string[] = [];
  const client: DiscordClient = {
    async getMe() {
      return { id: "100", username: "Gini", discriminator: "3715", bot: true };
    },
    async sendMessage(channelId, content) {
      sendCalls.push({ channelId, content });
      return {
        id: `reply-${sendCalls.length}`,
        channel_id: channelId,
        content,
        timestamp: "2026-01-01T00:00:00Z",
        author: { id: "100", username: "Gini", bot: true }
      };
    },
    async triggerTypingIndicator(channelId) {
      typingCalls.push(channelId);
      return true as const;
    },
    async fetchChannelMessages(channelId) {
      const queue = perChannel.get(channelId) ?? [];
      const next = queue.shift();
      perChannel.set(channelId, queue);
      if (!next) return [];
      if (next.kind === "err") throw new Error(next.message);
      return next.messages;
    }
  };
  return {
    client,
    enqueue(channelId, messages) {
      const queue = perChannel.get(channelId) ?? [];
      queue.push({ kind: "ok", messages });
      perChannel.set(channelId, queue);
    },
    failNext(channelId, message) {
      const queue = perChannel.get(channelId) ?? [];
      queue.push({ kind: "err", message });
      perChannel.set(channelId, queue);
    },
    sendCalls,
    typingCalls
  };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function makeMessage(overrides: Partial<DiscordMessage>): DiscordMessage {
  return {
    id: "100",
    channel_id: "chan-1",
    content: "hello",
    timestamp: "2026-01-01T00:00:00Z",
    author: { id: "user-1", username: "lo", bot: false },
    ...overrides
  };
}

describe("discord poller supervisor", () => {
  afterEach(() => resetMessagingDeps());

  test("reconcile starts a loop for a configured bridge; stopAll cancels it", async () => {
    const config = testConfig("disc-start-stop");
    const { client } = programmableClient();
    setMessagingDeps({ discordClientFactory: () => client });

    await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });

    const supervisor = createDiscordPollerSupervisor(config, {
      clientFactory: () => client,
      pollIntervalMs: 20,
      typingRefreshMs: 20
    });
    supervisor.reconcile();
    expect(supervisor.size()).toBe(1);

    await supervisor.stopAll();
    expect(supervisor.size()).toBe(0);
  });

  test("first contact seeds the watermark from the newest message without spawning a task", async () => {
    const config = testConfig("disc-seed");
    const { client, enqueue, sendCalls } = programmableClient();
    setMessagingDeps({ discordClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });

    // History returned newest-first by Discord; the poller flips and
    // pins the watermark to the newest snowflake (string "300").
    enqueue("chan-1", [
      makeMessage({ id: "300", content: "old c" }),
      makeMessage({ id: "200", content: "old b" }),
      makeMessage({ id: "100", content: "old a" })
    ]);

    const supervisor = createDiscordPollerSupervisor(config, {
      clientFactory: () => client,
      pollIntervalMs: 20,
      typingRefreshMs: 20
    });
    supervisor.reconcile();

    await waitFor(
      () => {
        const live = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);
        const watermark = (live?.metadata?.lastInboundExternalIds as Record<string, string> | undefined)?.["chan-1"];
        return watermark === "300";
      },
      "watermark to advance to newest existing message"
    );

    // No history messages should have been routed — every one is older
    // than the seeded watermark, so the agent stays quiet on a fresh
    // bridge attaching to a busy channel.
    expect(sendCalls).toEqual([]);
    expect(readState(config.instance).tasks).toEqual([]);

    await supervisor.stopAll();
  });

  test("non-bot inbound message produces a task, advances the watermark, and triggers a reply", async () => {
    const config = testConfig("disc-incoming");
    const { client, enqueue, sendCalls, typingCalls } = programmableClient();
    setMessagingDeps({ discordClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });

    // First batch seeds the watermark (any existing message will do —
    // first-contact pins to the newest and skips routing so a busy
    // channel doesn't backfill). Subsequent batch carries the real
    // user message we expect the agent to act on.
    enqueue("chan-1", [makeMessage({ id: "100", content: "older history" })]);
    enqueue("chan-1", [
      makeMessage({ id: "500", content: "hi gini", author: { id: "user-1", username: "lo", bot: false } })
    ]);

    const supervisor = createDiscordPollerSupervisor(config, {
      clientFactory: () => client,
      pollIntervalMs: 20,
      typingRefreshMs: 20
    });
    supervisor.reconcile();

    await waitFor(
      () => readState(config.instance).messagingMessages.some((m) => m.direction === "inbound" && m.target === "chan-1"),
      "inbound message to land"
    );

    await waitFor(
      () => sendCalls.length >= 1,
      "reply dispatch to fire after task settles"
    );

    const state = readState(config.instance);
    const inbound = state.messagingMessages.find((m) => m.direction === "inbound");
    expect(inbound?.text).toBe("hi gini");
    expect(inbound?.target).toBe("chan-1");

    const live = state.messagingBridges.find((b) => b.id === bridge.id);
    const watermark = (live?.metadata?.lastInboundExternalIds as Record<string, string> | undefined)?.["chan-1"];
    expect(watermark).toBe("500");

    // The reply mirror dispatches back through sendMessagingOutput,
    // which calls client.sendMessage with the assistant text.
    expect(sendCalls[0]?.channelId).toBe("chan-1");
    expect(sendCalls[0]?.content.length).toBeGreaterThan(0);

    // Typing indicator fired at least once before the task settled.
    expect(typingCalls.length).toBeGreaterThanOrEqual(1);

    await supervisor.stopAll();
  });

  test("bot-authored messages advance the watermark without spawning a task", async () => {
    const config = testConfig("disc-skip-bot");
    const { client, enqueue, sendCalls } = programmableClient();
    setMessagingDeps({ discordClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });

    // Seed batch (any message), then a bot-authored message that the
    // poller must skip while still advancing the watermark.
    enqueue("chan-1", [makeMessage({ id: "300", content: "older history" })]);
    enqueue("chan-1", [
      makeMessage({ id: "700", content: "i am a bot", author: { id: "100", username: "Gini", bot: true } })
    ]);

    const supervisor = createDiscordPollerSupervisor(config, {
      clientFactory: () => client,
      pollIntervalMs: 20,
      typingRefreshMs: 20
    });
    supervisor.reconcile();

    await waitFor(
      () => {
        const live = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);
        const watermark = (live?.metadata?.lastInboundExternalIds as Record<string, string> | undefined)?.["chan-1"];
        return watermark === "700";
      },
      "watermark to advance past the bot message"
    );

    expect(readState(config.instance).tasks).toEqual([]);
    expect(sendCalls).toEqual([]);

    await supervisor.stopAll();
  });

  test("reconcile aborts the loop for a bridge that no longer matches shouldRun (status disabled)", async () => {
    const config = testConfig("disc-disable");
    const { client } = programmableClient();
    setMessagingDeps({ discordClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });

    const supervisor = createDiscordPollerSupervisor(config, {
      clientFactory: () => client,
      pollIntervalMs: 20,
      typingRefreshMs: 20
    });
    supervisor.reconcile();
    expect(supervisor.size()).toBe(1);

    // Flip the bridge to disabled without going through
    // disableMessagingBridge so the test isolates the reconcile path.
    const { mutateState } = await import("../state");
    await mutateState(config.instance, (state) => {
      const live = state.messagingBridges.find((b) => b.id === bridge.id);
      if (live) live.status = "disabled";
    });

    // reconcile sees the bridge no longer matches shouldRun and calls
    // stopLoop → controller.abort(). The loop exits via the abort
    // path. This test deliberately covers the supervisor-driven path,
    // not the runLoop self-exit guard — that path is covered below.
    supervisor.reconcile();
    await waitFor(() => supervisor.size() === 0, "loop to exit after reconcile-driven abort");

    await supervisor.stopAll();
  });

  test("runLoop self-exits when bridge status flips between poll cycles (no reconcile)", async () => {
    // Distinct from the reconcile-driven test above: here we never
    // call reconcile() after the status flip. The loop must observe
    // the new status on its next iteration and self-exit via the
    // guard at the top of runLoop. If the guard were removed, the
    // loop would keep polling against a disabled bridge until
    // supervisor.stopAll() forces it.
    const config = testConfig("disc-self-exit");
    const { client } = programmableClient();
    setMessagingDeps({ discordClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });

    const supervisor = createDiscordPollerSupervisor(config, {
      clientFactory: () => client,
      pollIntervalMs: 20,
      typingRefreshMs: 20
    });
    supervisor.reconcile();
    expect(supervisor.size()).toBe(1);

    const { mutateState } = await import("../state");
    await mutateState(config.instance, (state) => {
      const live = state.messagingBridges.find((b) => b.id === bridge.id);
      if (live) live.status = "disabled";
    });

    // No reconcile() call. The loop should self-exit on its next
    // iteration when the top-of-loop guard observes status !==
    // "configured". The supervisor's `.finally` cleans up the map.
    await waitFor(() => supervisor.size() === 0, "loop to self-exit without reconcile");

    await supervisor.stopAll();
  });
});
