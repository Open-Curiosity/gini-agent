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

// Wrap supervisor lifecycle in try/finally so a failed assertion can
// never leak the loop into the next test — a leaked loop would keep
// polling against the (next test's) GINI_STATE_ROOT and surface as
// spurious failures.
async function withSupervisor<T>(
  supervisor: { stopAll: () => Promise<void> },
  body: () => Promise<T>
): Promise<T> {
  try {
    return await body();
  } finally {
    await supervisor.stopAll().catch(() => {});
  }
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

  test("empty channel seeds a sentinel watermark, then routes the next real message", async () => {
    // Regression for the round-1-confirmed seeding bug: a bridge
    // attached to an empty channel must NOT consume the first user
    // message as its seed.
    const config = testConfig("disc-empty-seed");
    const { client, enqueue, sendCalls } = programmableClient();
    setMessagingDeps({ discordClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });

    // First poll: channel is empty. Watermark must seed to "0".
    enqueue("chan-1", []);
    // Second poll: a real user message arrives. It must be routed,
    // not consumed as the seed.
    enqueue("chan-1", [
      makeMessage({ id: "999000000000000000", content: "first real message" })
    ]);

    const supervisor = createDiscordPollerSupervisor(config, {
      clientFactory: () => client,
      pollIntervalMs: 20,
      typingRefreshMs: 20
    });

    await withSupervisor(supervisor, async () => {
      supervisor.reconcile();
      await waitFor(
        () => {
          const live = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);
          const watermark = (live?.metadata?.lastInboundExternalIds as Record<string, string> | undefined)?.["chan-1"];
          return watermark === "999000000000000000";
        },
        "watermark to advance past the first real user message"
      );
      await waitFor(() => sendCalls.length >= 1, "reply to dispatch after seeding from empty");
    });

    const inbound = readState(config.instance).messagingMessages.find(
      (m) => m.direction === "inbound" && m.target === "chan-1"
    );
    expect(inbound?.text).toBe("first real message");
  });

  test("pagination catches up when more than FETCH_BATCH_LIMIT messages land between polls", async () => {
    // Regression for the round-2-confirmed pagination drop bug.
    // Discord's REST `after` returns the NEWEST FETCH_BATCH_LIMIT
    // messages above the cursor (not the oldest), so a single poll
    // would skip everything below the 50th-newest. The pagination
    // loop in pollChannel must keep fetching until a partial batch
    // lands or the per-tick cap fires.
    const config = testConfig("disc-pagination");
    const { client, enqueue } = programmableClient();
    setMessagingDeps({ discordClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });

    // Seed batch + a real "first user" message so the watermark is
    // pinned and processing kicks in for subsequent batches.
    enqueue("chan-1", [makeMessage({ id: "100", content: "older history" })]);

    // Build a 75-message burst, all bot-authored so they're skipped
    // (but the watermark must still advance through all 75).
    const burst: DiscordMessage[] = [];
    for (let i = 0; i < 75; i += 1) {
      burst.push(makeMessage({
        id: String(1000 + i),
        content: `burst ${i}`,
        author: { id: "bot-1", username: "OtherBot", bot: true }
      }));
    }
    // Simulate Discord's "newest first" REST behavior under `after=100`:
    // first page returns the newest 50 (ids 1025..1074), with the
    // OLDEST in the response being id 1025.
    enqueue("chan-1", burst.slice(25).reverse());
    // Second pagination call with after=1074: returns the next page
    // (ids 1075-up). In our 75-message burst there are no messages
    // newer than 1074, so the second call returns the OLDER 25
    // (ids 1000-1024). Discord's API in production wouldn't actually
    // return older messages with `after`, but our stub mirrors the
    // catch-up shape from discord.py: we keep fetching above the
    // newest seen until a partial batch returns. Easier to model: the
    // stub returns the remaining 25 then empty.
    enqueue("chan-1", burst.slice(0, 25).reverse());
    enqueue("chan-1", []);

    const supervisor = createDiscordPollerSupervisor(config, {
      clientFactory: () => client,
      pollIntervalMs: 20,
      typingRefreshMs: 20
    });

    await withSupervisor(supervisor, async () => {
      supervisor.reconcile();
      // After processing, the watermark should reach the newest id
      // in the burst (1074, the highest snowflake).
      await waitFor(
        () => {
          const live = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);
          const watermark = (live?.metadata?.lastInboundExternalIds as Record<string, string> | undefined)?.["chan-1"];
          return watermark === "1074";
        },
        "watermark to advance to newest of the burst (1074)"
      );
    });

    // No user-authored messages → no tasks spawned. The burst was
    // entirely bot-authored; the pagination must still account for
    // every snowflake.
    expect(readState(config.instance).tasks).toEqual([]);
  });

  test("markBridgeError does not overwrite a user-initiated disable", async () => {
    // Race: user disables the bridge while the loop is mid-tick.
    // disableMessagingBridge sets status="disabled" and deletes the
    // secret file. The next loop iter catches ENOENT and calls
    // markBridgeError — which must NOT flip "disabled" back to
    // "error", because that would erase the user's explicit intent.
    const config = testConfig("disc-disable-race");
    const { client } = programmableClient();
    setMessagingDeps({ discordClientFactory: () => client });

    const { disableMessagingBridge } = await import("./messaging");

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

    await withSupervisor(supervisor, async () => {
      supervisor.reconcile();
      // Disable while the loop is running. The disable flow deletes
      // the secret; if the loop catches ENOENT it would call
      // markBridgeError, which must respect the "disabled" status.
      await disableMessagingBridge(config, bridge.id);
      await waitFor(() => supervisor.size() === 0, "loop to exit after disable");
    });

    const live = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);
    expect(live?.status).toBe("disabled");
  });
});
