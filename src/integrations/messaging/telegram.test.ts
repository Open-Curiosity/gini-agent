// Behavior tests for the Telegram messaging channel.
//
// Conventions:
//   - The fetch mock fails closed in beforeAll. Any test that needs to
//     allow a network call must install a per-test responder via
//     mockFetch(...). An unmocked call to api.telegram.org throws and
//     fails the test loudly so a real network request from a leaked
//     poller can't be missed.
//   - afterEach drains the poller registry via stopAllPollers so no
//     worker outlives its case (addMessagingBridge starts a poller
//     unconditionally for telegram bridges and the registry is process-
//     singleton, so without this each test would leak a poller).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { ProviderConfig, RuntimeConfig } from "../../types";
import { mutateState, readState } from "../../state";
import { writeSecret } from "../../state/secrets";
import { install } from "../../runtime";
import {
  addMessagingBridge,
  addTelegramAllowlistEntry,
  disableMessagingBridge,
  receiveMessagingInput,
  removeTelegramAllowlistEntry
} from "../messaging";
import { replyToMessagingFromTask } from "../messaging-finalize";
import { updateConnector } from "../connectors";
import { handleCallbackQuery, handleInboundMessage } from "./telegram-handlers";
import { dispatchOutboundMessage, splitForTelegram } from "./telegram-stream";
import { isPollerRunning, startConfiguredTelegramPollers, stopAllPollers } from "./telegram-registry";

const ROOT = "/tmp/gini-telegram-messaging-unit";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const originalFetch = globalThis.fetch;

// Default fail-closed fetch. Replaces globalThis.fetch in beforeEach so
// any unmocked call to api.telegram.org from a leaked poller (or a test
// that forgot to install a responder) blows up loudly instead of
// touching the real network.
function failClosedFetch(): typeof fetch {
  return (async (input: Request | string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("api.telegram.org")) {
      throw new Error(`telegram.test: unmocked fetch ${url}`);
    }
    return new Response("", { status: 599, statusText: "no responder" });
  }) as typeof fetch;
}

beforeEach(() => {
  globalThis.fetch = failClosedFetch();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  // Drain leaked pollers. addMessagingBridge for kind === "telegram"
  // unconditionally starts a worker; without this drain a stale worker
  // would keep firing fetches against the next test's mocks.
  await stopAllPollers();
});

interface FetchLog {
  url: string;
  init?: RequestInit;
}

function mockFetch(responder: (url: string, init?: RequestInit) => Response | Promise<Response>): FetchLog[] {
  const log: FetchLog[] = [];
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    log.push({ url, init });
    return responder(url, init);
  }) as typeof fetch;
  return log;
}

function buildConfig(instance: string): RuntimeConfig {
  const provider: ProviderConfig = { name: "echo", model: "gini-echo-v0" };
  return {
    instance,
    port: 0,
    token: "test",
    provider,
    workspaceRoot: `${ROOT}/${instance}/workspace`,
    stateRoot: `${ROOT}/${instance}`,
    logRoot: `${ROOT}/${instance}/logs`
  };
}

async function seedTelegramConnector(config: RuntimeConfig, connectorId: string, token: string): Promise<void> {
  const ref = writeSecret(config.instance, connectorId, "token", token);
  await mutateState(config.instance, (state) => {
    state.connectors.push({
      id: connectorId,
      instance: state.instance,
      name: "telegram-test",
      provider: "telegram",
      status: "configured",
      scopes: [],
      secretRefs: [ref],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      health: "healthy",
      source: "user"
    });
  });
}

describe("addMessagingBridge for telegram", () => {
  test("rejects telegram bridges without connectorId", async () => {
    const config = buildConfig("telegram-no-connector");
    install(config);
    await expect(
      addMessagingBridge(config, { name: "telegram-bot", kind: "telegram" })
    ).rejects.toThrow(/require connectorId/);
  });

  test("rejects telegram bridges that point at a non-telegram connector", async () => {
    const config = buildConfig("telegram-wrong-provider");
    install(config);
    // Seed a generic connector with a token secret — exactly the shape
    // a malicious config would use to try to ship a Telegram bot token
    // to a non-Telegram upstream.
    const ref = writeSecret(config.instance, "id_generic", "token", "token");
    await mutateState(config.instance, (state) => {
      state.connectors.push({
        id: "id_generic",
        instance: state.instance,
        name: "generic-impostor",
        provider: "generic",
        status: "configured",
        scopes: [],
        secretRefs: [ref],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        health: "healthy",
        source: "user"
      });
    });
    await expect(
      addMessagingBridge(config, { name: "tg-evil", kind: "telegram", connectorId: "id_generic" })
    ).rejects.toThrow(/must be a telegram provider/);
  });

  test("rejects telegram bridge create with caller-supplied allowlist", async () => {
    const config = buildConfig("telegram-no-direct-allowlist");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    await expect(
      addMessagingBridge(config, {
        name: "tg",
        kind: "telegram",
        connectorId: "id_conn",
        telegram: {
          allowlist: [{ telegramUserId: 7, agentId: "any" }]
        }
      })
    ).rejects.toThrow(/Allowlist entries must be added via/);
  });

  test("creates a telegram bridge with allowlist + offset initialized", async () => {
    const config = buildConfig("telegram-create");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    expect(bridge.kind).toBe("telegram");
    expect(bridge.connectorId).toBe("id_conn");
    expect(bridge.telegram?.allowlist).toEqual([]);
    expect(bridge.telegram?.updateOffset).toBe(0);
    // The poller-owned fields are never seeded from caller input — even
    // if a caller had snuck them past, addMessagingBridge ignores them.
    expect(bridge.telegram?.botUsername).toBeUndefined();
  });
});

describe("inbound message authorization", () => {
  test("allowlisted user_id submits a chat-mode task with stamped target", async () => {
    const config = buildConfig("telegram-allowlist-ok");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    const agentId = readState(config.instance).agents[0]!.id;
    await addTelegramAllowlistEntry(config, bridge.id, {
      telegramUserId: 999,
      telegramUsername: "tester",
      agentId
    });

    // Allow the typing-action best-effort fetch.
    mockFetch(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));

    await handleInboundMessage(config, bridge.id, {
      message_id: 100,
      from: { id: 999, username: "tester" },
      chat: { id: 555, type: "private" },
      date: Math.floor(Date.now() / 1000),
      text: "hello bot"
    }, 42);

    const state = readState(config.instance);
    const inbound = state.messagingMessages.find((m) => m.bridgeId === bridge.id && m.direction === "inbound");
    expect(inbound).toBeDefined();
    expect(inbound!.target).toBe("555");
    // externalId is `${chatId}:${message_id}` so the dedupe key is
    // chat-scoped — distinct chats sharing a numeric message_id stay
    // distinct rows.
    expect(inbound!.externalId).toBe("555:100");
    expect(inbound!.text).toBe("hello bot");
    expect(inbound!.chatSessionId).toBeDefined();
    expect(inbound!.taskId).toBeDefined();

    const task = state.tasks.find((t) => t.id === inbound!.taskId);
    expect(task?.mode).toBe("chat");
    // The allowlist entry's pinned agent is stamped on the Task row so
    // the chat-task loop doesn't have to consult activeAgentId.
    expect(task?.agentId).toBe(agentId);
  });

  test("non-allowlisted user_id drops with an audit row", async () => {
    const config = buildConfig("telegram-allowlist-drop");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    const agentId = readState(config.instance).agents[0]!.id;
    await addTelegramAllowlistEntry(config, bridge.id, { telegramUserId: 1, agentId });

    mockFetch(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));

    await handleInboundMessage(config, bridge.id, {
      message_id: 7,
      from: { id: 12345, username: "intruder" },
      chat: { id: 555, type: "private" },
      date: Math.floor(Date.now() / 1000),
      text: "hi"
    }, 11);

    const state = readState(config.instance);
    const inbound = state.messagingMessages.find((m) => m.bridgeId === bridge.id && m.direction === "inbound");
    expect(inbound).toBeUndefined();
    const audit = state.audit.find((a) => a.action === "messaging.telegram.dropped");
    expect(audit).toBeDefined();
    expect(audit?.evidence).toMatchObject({ reason: "unauthorized", telegramUserId: 12345 });
  });

  test("authorization is by from.id, not chat.id (group-chat scenario)", async () => {
    // Same chat.id, but the sender's user_id is NOT allowlisted. Even
    // though an allowlisted user might be in the same group, the
    // non-allowlisted member's message must drop.
    const config = buildConfig("telegram-chatid-not-auth");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    const agentId = readState(config.instance).agents[0]!.id;
    // Allowlist user 100 only.
    await addTelegramAllowlistEntry(config, bridge.id, { telegramUserId: 100, agentId });

    mockFetch(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));

    await handleInboundMessage(config, bridge.id, {
      message_id: 1,
      from: { id: 999, username: "other-member" }, // not allowlisted
      chat: { id: 555, type: "group" },             // group includes allowlisted user 100
      date: Math.floor(Date.now() / 1000),
      text: "drive the agent"
    }, 1);

    const state = readState(config.instance);
    expect(state.messagingMessages.length).toBe(0);
    expect(state.audit.some((a) => a.action === "messaging.telegram.dropped")).toBe(true);
  });

  test("duplicate externalId on restart is a no-op (advances offset, no second task)", async () => {
    const config = buildConfig("telegram-inbound-dedupe");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    const agentId = readState(config.instance).agents[0]!.id;
    await addTelegramAllowlistEntry(config, bridge.id, { telegramUserId: 100, agentId });

    mockFetch(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));

    const msg = {
      message_id: 7,
      from: { id: 100, username: "u" },
      chat: { id: 555, type: "private" as const },
      date: Math.floor(Date.now() / 1000),
      text: "first"
    };
    await handleInboundMessage(config, bridge.id, msg, 50);
    const tasksAfterFirst = readState(config.instance).tasks.length;
    // Replay the same update — simulates a poller resuming from an
    // earlier offset after a crash before the offset advance landed.
    await handleInboundMessage(config, bridge.id, msg, 50);
    const tasksAfterSecond = readState(config.instance).tasks.length;
    expect(tasksAfterSecond).toBe(tasksAfterFirst);
    // The offset advanced past update_id=50 on both invocations.
    const live = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);
    expect(live?.telegram?.updateOffset).toBe(51);
  });

  test("distinct chats sharing a numeric message_id both produce inbound rows and tasks", async () => {
    // Telegram `message_id` is unique per chat, not per bot. Two
    // allowlisted users in two separate chats can independently send
    // `message_id=1`; the dedupe must not collapse them.
    const config = buildConfig("telegram-cross-chat-dedupe");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    const agentId = readState(config.instance).agents[0]!.id;
    await addTelegramAllowlistEntry(config, bridge.id, { telegramUserId: 100, agentId });
    await addTelegramAllowlistEntry(config, bridge.id, { telegramUserId: 200, agentId });

    mockFetch(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));

    await handleInboundMessage(config, bridge.id, {
      message_id: 1,
      from: { id: 100, username: "userA" },
      chat: { id: 111, type: "private" },
      date: 0,
      text: "from chat A"
    }, 10);
    await handleInboundMessage(config, bridge.id, {
      message_id: 1,
      from: { id: 200, username: "userB" },
      chat: { id: 222, type: "private" },
      date: 0,
      text: "from chat B"
    }, 11);

    const state = readState(config.instance);
    const inboundA = state.messagingMessages.find(
      (m) => m.bridgeId === bridge.id && m.direction === "inbound" && m.target === "111"
    );
    const inboundB = state.messagingMessages.find(
      (m) => m.bridgeId === bridge.id && m.direction === "inbound" && m.target === "222"
    );
    expect(inboundA).toBeDefined();
    expect(inboundB).toBeDefined();
    expect(inboundA!.externalId).toBe("111:1");
    expect(inboundB!.externalId).toBe("222:1");
    expect(inboundA!.taskId).toBeDefined();
    expect(inboundB!.taskId).toBeDefined();
    expect(inboundA!.taskId).not.toBe(inboundB!.taskId);
  });

  test("inbound from an allowlist entry whose agent was deleted drops with agent_missing", async () => {
    // Layered defense: deleteAgent already cascades-cleans the
    // allowlist, but state imports, manual JSON edits, or future
    // regressions can leave an orphan reference. Simulate the gap by
    // mutating state directly after the allowlist is established.
    const config = buildConfig("telegram-inbound-agent-missing");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    const agentId = readState(config.instance).agents[0]!.id;
    await addTelegramAllowlistEntry(config, bridge.id, { telegramUserId: 100, agentId });
    // Manually create an orphan: the allowlist entry survives but the
    // agent row is gone. This is the state shape the cascade would
    // miss for an imported state file.
    await mutateState(config.instance, (state) => {
      const live = state.messagingBridges.find((b) => b.id === bridge.id)!;
      live.telegram!.allowlist[0]!.agentId = "agent_ghost";
    });

    mockFetch(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));

    await handleInboundMessage(config, bridge.id, {
      message_id: 1,
      from: { id: 100, username: "u" },
      chat: { id: 555, type: "private" },
      date: 0,
      text: "should drop"
    }, 17);

    const state = readState(config.instance);
    const inbound = state.messagingMessages.find((m) => m.bridgeId === bridge.id && m.direction === "inbound");
    expect(inbound).toBeUndefined();
    const audit = state.audit.find(
      (a) =>
        a.action === "messaging.telegram.dropped" &&
        (a.evidence as Record<string, unknown> | undefined)?.reason === "agent_missing"
    );
    expect(audit).toBeDefined();
    expect((audit!.evidence as Record<string, unknown>).agentId).toBe("agent_ghost");
    expect((audit!.evidence as Record<string, unknown>).telegramUserId).toBe(100);
  });

  test("concurrent inbound submissions from distinct allowlist entries run under their own agent", async () => {
    const config = buildConfig("telegram-concurrent-agents");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    // Build two distinct agents and bind each to a separate allowlist
    // entry so the per-task agent override has something to verify.
    const stateBefore = readState(config.instance);
    const agentA = stateBefore.agents[0]!.id;
    let agentBId = "";
    await mutateState(config.instance, (state) => {
      const newAgent = {
        id: "agent_B_id",
        instance: state.instance,
        name: "agent-B",
        status: "inactive" as const,
        toolsets: [] as string[],
        messagingTargets: [] as string[],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      state.agents.push(newAgent);
      agentBId = newAgent.id;
    });
    await addTelegramAllowlistEntry(config, bridge.id, { telegramUserId: 100, agentId: agentA });
    await addTelegramAllowlistEntry(config, bridge.id, { telegramUserId: 200, agentId: agentBId });

    mockFetch(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));

    // Interleave: fire both dispatches concurrently. The per-task agent
    // override has to be stable per-task — without it, both tasks would
    // see whichever activateAgent wrote last.
    await Promise.all([
      handleInboundMessage(config, bridge.id, {
        message_id: 1, from: { id: 100 }, chat: { id: 1, type: "private" },
        date: 0, text: "from A"
      }, 1),
      handleInboundMessage(config, bridge.id, {
        message_id: 2, from: { id: 200 }, chat: { id: 2, type: "private" },
        date: 0, text: "from B"
      }, 2)
    ]);

    const state = readState(config.instance);
    const inboundA = state.messagingMessages.find((m) => m.bridgeId === bridge.id && m.target === "1");
    const inboundB = state.messagingMessages.find((m) => m.bridgeId === bridge.id && m.target === "2");
    const taskA = state.tasks.find((t) => t.id === inboundA?.taskId);
    const taskB = state.tasks.find((t) => t.id === inboundB?.taskId);
    expect(taskA?.agentId).toBe(agentA);
    expect(taskB?.agentId).toBe(agentBId);
  });

  test("bridge disabled before submitTask drops with disabled_during_dispatch", async () => {
    // Pins the pre-submitTask live-status re-check in
    // handleInboundMessage. The handler captures the bridge once at
    // entry; if `disableMessagingBridge` lands between that capture and
    // the (expensive, irreversible) submitTask call, the handler must
    // not create a task that has no permitted reply channel.
    const config = buildConfig("telegram-inbound-disabled-pre");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    const agentId = readState(config.instance).agents[0]!.id;
    await addTelegramAllowlistEntry(config, bridge.id, { telegramUserId: 100, agentId });

    // Disable the bridge before dispatch. This is the same shape as the
    // race: the captured bridge snapshot is still "configured" but the
    // live state is "disabled".
    await disableMessagingBridge(config, bridge.id);

    const tasksBefore = readState(config.instance).tasks.length;
    mockFetch(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));

    await handleInboundMessage(config, bridge.id, {
      message_id: 1,
      from: { id: 100, username: "u" },
      chat: { id: 555, type: "private" },
      date: 0,
      text: "should not dispatch"
    }, 99);

    const state = readState(config.instance);
    expect(state.tasks.length).toBe(tasksBefore);
    const inbound = state.messagingMessages.find(
      (m) => m.bridgeId === bridge.id && m.direction === "inbound"
    );
    expect(inbound).toBeUndefined();
    const drop = state.audit.find(
      (a) =>
        a.action === "messaging.telegram.dropped" &&
        (a.evidence as Record<string, unknown> | undefined)?.reason === "disabled_during_dispatch"
    );
    expect(drop).toBeDefined();
    expect((drop!.evidence as Record<string, unknown>).bridgeStatus).toBe("disabled");
    // Offset still advances so a poller restart doesn't re-dispatch
    // this update.
    const live = state.messagingBridges.find((b) => b.id === bridge.id);
    expect(live?.telegram?.updateOffset).toBe(100);
  });

  test("disable racing the inbound handler keeps tasks unchanged and skips the dispatch", async () => {
    // Pins the atomic gate inside handleInboundMessage. The pre-gate
    // awaits (resolveConnectorSecret, sendChatAction, ensureChatSessionForUser)
    // each yield to the per-instance mutateState queue; a
    // disableMessagingBridge fired concurrently lands somewhere in that
    // window. The gate guarantees the dispatch is either entirely
    // before-disable (proceed, write durable rows, submit task) or
    // entirely after-disable (skip, audit, advance offset). It must
    // never half-commit: enqueueing a task whose reply path the
    // operator just revoked is what this guard prevents.
    const config = buildConfig("telegram-inbound-disable-race");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    const agentId = readState(config.instance).agents[0]!.id;
    await addTelegramAllowlistEntry(config, bridge.id, { telegramUserId: 100, agentId });

    const tasksBefore = readState(config.instance).tasks.length;
    mockFetch(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));

    // Race shape: fire the handler, then immediately fire the disable.
    // The handler's first awaited mutateState (the connector.secret.use
    // audit row inside resolveConnectorSecret) enqueues on the
    // per-instance queue; the disable's mutateState queues right behind
    // it and lands before the atomic gate runs. The captured-at-entry
    // bridge snapshot still says "configured" but the gate sees
    // "disabled" and skips.
    const handlerPromise = handleInboundMessage(config, bridge.id, {
      message_id: 1,
      from: { id: 100, username: "u" },
      chat: { id: 555, type: "private" },
      date: 0,
      text: "should not dispatch under a racing disable"
    }, 99);
    const disablePromise = disableMessagingBridge(config, bridge.id);
    await Promise.all([handlerPromise, disablePromise]);

    const state = readState(config.instance);
    // No task was submitted under the racing disable.
    expect(state.tasks.length).toBe(tasksBefore);
    // No inbound row was written.
    const inbound = state.messagingMessages.find(
      (m) => m.bridgeId === bridge.id && m.direction === "inbound"
    );
    expect(inbound).toBeUndefined();
    // The drop audit captures the bridgeStatus seen by the gate.
    const drop = state.audit.find(
      (a) =>
        a.action === "messaging.telegram.dropped" &&
        (a.evidence as Record<string, unknown> | undefined)?.reason === "disabled_during_dispatch"
    );
    expect(drop).toBeDefined();
    expect((drop!.evidence as Record<string, unknown>).bridgeStatus).toBe("disabled");
    // Offset still advanced in the same mutation that audited the
    // drop, so a poller restart doesn't re-dispatch this update.
    const live = state.messagingBridges.find((b) => b.id === bridge.id);
    expect(live?.telegram?.updateOffset).toBe(100);
  });

  test("backing connector flipped non-configured drops the dispatch with connector_unavailable", async () => {
    // The gate re-reads the backing connector's live status alongside
    // the bridge status. A direct state-edit / import path can leave a
    // connector `disabled` while the bridge row still says
    // `configured`; without the connector check the gate would proceed
    // and submit a task whose reply path is already broken. The
    // operator-visible outcome must be a `messaging.telegram.dropped`
    // audit row with `reason: "connector_unavailable"` and no task.
    const config = buildConfig("telegram-gate-connector-unavailable");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    const agentId = readState(config.instance).agents[0]!.id;
    await addTelegramAllowlistEntry(config, bridge.id, { telegramUserId: 100, agentId });
    // Stop the poller so its loop doesn't see the disabled connector
    // first and flip the bridge to `error` (which would trip the
    // earlier bridge-status check instead of the connector check we
    // want to exercise).
    await stopAllPollers();
    // Flip the connector directly to `disabled` without going through
    // updateConnector, leaving the bridge `configured`. This is the
    // import / hand-edit shape the connector check defends against.
    await mutateState(config.instance, (state) => {
      const c = state.connectors.find((c) => c.id === "id_conn")!;
      c.status = "disabled";
    });

    const tasksBefore = readState(config.instance).tasks.length;
    mockFetch(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));

    await handleInboundMessage(config, bridge.id, {
      message_id: 1,
      from: { id: 100, username: "u" },
      chat: { id: 555, type: "private" },
      date: 0,
      text: "drive under disabled connector"
    }, 42);

    const state = readState(config.instance);
    expect(state.tasks.length).toBe(tasksBefore);
    const inbound = state.messagingMessages.find(
      (m) => m.bridgeId === bridge.id && m.direction === "inbound"
    );
    expect(inbound).toBeUndefined();
    const drop = state.audit.find(
      (a) =>
        a.action === "messaging.telegram.dropped" &&
        (a.evidence as Record<string, unknown> | undefined)?.reason === "connector_unavailable"
    );
    expect(drop).toBeDefined();
    expect((drop!.evidence as Record<string, unknown>).connectorStatus).toBe("disabled");
    // Offset advanced in the same mutation as the drop audit so a
    // restart doesn't re-dispatch.
    const live = state.messagingBridges.find((b) => b.id === bridge.id);
    expect(live?.telegram?.updateOffset).toBe(43);
  });
});

describe("callback_query handling", () => {
  test("rejects a callback whose from.id doesn't own the approval's chat session", async () => {
    const config = buildConfig("telegram-cross-user");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    const agentId = readState(config.instance).agents[0]!.id;
    // Two allowlisted users, A and B. Each gets a session.
    await addTelegramAllowlistEntry(config, bridge.id, { telegramUserId: 100, agentId });
    await addTelegramAllowlistEntry(config, bridge.id, { telegramUserId: 200, agentId });

    // Seed: user A had an approval prompt emitted into their session.
    // Build the messaging message + approval row directly so we don't
    // depend on the full LLM loop.
    await mutateState(config.instance, (state) => {
      const liveBridge = state.messagingBridges.find((b) => b.id === bridge.id)!;
      liveBridge.telegram!.allowlist[0]!.chatSessionId = "chat_userA";
      liveBridge.telegram!.allowlist[1]!.chatSessionId = "chat_userB";
      state.chatSessions.push({
        id: "chat_userA",
        instance: state.instance,
        title: "A",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageIds: [],
        taskIds: [],
        runIds: []
      });
      state.approvals.push({
        id: "appr_a",
        instance: state.instance,
        action: "file.write",
        target: "/tmp/a",
        risk: "high",
        status: "pending",
        reason: "test approval",
        payload: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      state.messagingMessages.push({
        id: "msg_appr_a",
        instance: state.instance,
        bridgeId: bridge.id,
        direction: "outbound",
        status: "sent",
        target: "555",
        text: "approve?",
        externalId: "9",
        approvalId: "appr_a",
        chatSessionId: "chat_userA",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    });

    mockFetch(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));

    // User B taps Approve in their own chat — must be rejected.
    await handleCallbackQuery(config, bridge.id, {
      id: "cbq_1",
      from: { id: 200, username: "userB" },
      data: "appr:appr_a"
    }, 70);

    const state = readState(config.instance);
    const approval = state.approvals.find((a) => a.id === "appr_a");
    expect(approval?.status).toBe("pending");
    const drop = state.audit.find((a) => a.action === "messaging.telegram.dropped" && (a.evidence as Record<string, unknown> | undefined)?.reason === "cross_user_approval");
    expect(drop).toBeDefined();
  });

  test("validated callback acks immediately and edits the prompt message", async () => {
    const config = buildConfig("telegram-callback-happy");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    const agentId = readState(config.instance).agents[0]!.id;
    await addTelegramAllowlistEntry(config, bridge.id, { telegramUserId: 100, agentId });

    await mutateState(config.instance, (state) => {
      const liveBridge = state.messagingBridges.find((b) => b.id === bridge.id)!;
      liveBridge.telegram!.allowlist[0]!.chatSessionId = "chat_user100";
      state.chatSessions.push({
        id: "chat_user100",
        instance: state.instance,
        title: "user",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageIds: [],
        taskIds: [],
        runIds: []
      });
      state.approvals.push({
        id: "appr_x",
        instance: state.instance,
        action: "file.write",
        target: "/tmp/x",
        risk: "low",
        status: "pending",
        reason: "test approval low risk",
        payload: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      state.messagingMessages.push({
        id: "msg_appr_x",
        instance: state.instance,
        bridgeId: bridge.id,
        direction: "outbound",
        status: "sent",
        target: "555",
        text: "approve?",
        externalId: "42",
        approvalId: "appr_x",
        chatSessionId: "chat_user100",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    });

    const log = mockFetch(async (url) => {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
    });

    await handleCallbackQuery(config, bridge.id, {
      id: "cbq_x",
      from: { id: 100, username: "u" },
      data: "deny:appr_x"
    }, 80);

    // The deny path causes the agent to fail the task. Inspect the
    // calls: the first call must be answerCallbackQuery (early ack);
    // the prompt-edit must reflect the verdict.
    const ackCalls = log.filter((entry) => entry.url.includes("answerCallbackQuery"));
    const editCalls = log.filter((entry) => entry.url.includes("editMessageText"));
    expect(ackCalls.length).toBeGreaterThanOrEqual(1);
    expect(editCalls.length).toBeGreaterThanOrEqual(1);
    // The ack must precede the editMessageText so the user sees the
    // spinner clear before the verdict is written into the prompt.
    const firstAckIndex = log.findIndex((entry) => entry.url.includes("answerCallbackQuery"));
    const firstEditIndex = log.findIndex((entry) => entry.url.includes("editMessageText"));
    expect(firstAckIndex).toBeLessThan(firstEditIndex);

    const state = readState(config.instance);
    const approval = state.approvals.find((a) => a.id === "appr_x");
    expect(approval?.status).toBe("denied");
    // Offset advances past the callback update in the same mutation
    // that records the decision audit, so a poller restart doesn't
    // re-dispatch the callback.
    const live = state.messagingBridges.find((b) => b.id === bridge.id);
    expect(live?.telegram?.updateOffset).toBe(81);
  });
});

describe("callback live-revocation race", () => {
  test("allowlist entry revoked mid-flight blocks decideApproval and audits the drop", async () => {
    // Pins the live-state re-validation at the side-effect boundary
    // in handleCallbackQuery. The handler captures the bridge once at
    // entry, then awaits resolveConnectorSecret (and any future awaits)
    // before deciding the approval. A concurrent revoke must not slip
    // through that window.
    const config = buildConfig("telegram-callback-revoked");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    const agentId = readState(config.instance).agents[0]!.id;
    await addTelegramAllowlistEntry(config, bridge.id, { telegramUserId: 100, agentId });

    await mutateState(config.instance, (state) => {
      const liveBridge = state.messagingBridges.find((b) => b.id === bridge.id)!;
      liveBridge.telegram!.allowlist[0]!.chatSessionId = "chat_user100";
      state.chatSessions.push({
        id: "chat_user100",
        instance: state.instance,
        title: "user",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageIds: [],
        taskIds: [],
        runIds: []
      });
      state.approvals.push({
        id: "appr_revoked",
        instance: state.instance,
        action: "file.write",
        target: "/tmp/r",
        risk: "low",
        status: "pending",
        reason: "test approval revoked mid-flight",
        payload: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      state.messagingMessages.push({
        id: "msg_appr_revoked",
        instance: state.instance,
        bridgeId: bridge.id,
        direction: "outbound",
        status: "sent",
        target: "555",
        text: "approve?",
        externalId: "11",
        approvalId: "appr_revoked",
        chatSessionId: "chat_user100",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    });

    mockFetch(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));

    // Race shape: start the callback handler, then immediately fire
    // the revoke. The handler's first await (resolveConnectorSecret)
    // enqueues a mutateState (the secret-use audit row) on the
    // per-instance queue; the revoke's mutateState queues behind it
    // and lands before the handler's live re-read runs. The
    // captured-at-entry snapshot still says "entry present", but the
    // live state has had it removed — exactly the window the guard
    // protects.
    const callbackPromise = handleCallbackQuery(config, bridge.id, {
      id: "cbq_revoked",
      from: { id: 100, username: "u" },
      data: "appr:appr_revoked"
    }, 90);
    const revokePromise = removeTelegramAllowlistEntry(config, bridge.id, "100");
    await Promise.all([callbackPromise, revokePromise]);

    const state = readState(config.instance);
    const approval = state.approvals.find((a) => a.id === "appr_revoked");
    expect(approval?.status).toBe("pending");
    const drop = state.audit.find(
      (a) =>
        a.action === "messaging.telegram.dropped" &&
        (a.evidence as Record<string, unknown> | undefined)?.reason === "callback_revoked"
    );
    expect(drop).toBeDefined();
    expect((drop!.evidence as Record<string, unknown>).reasonDetail).toBe("allowlist_revoked");
    expect((drop!.evidence as Record<string, unknown>).telegramUserId).toBe(100);
  });

  test("bridge disabled mid-flight blocks decideApproval with callback_revoked + bridge_unavailable", async () => {
    const config = buildConfig("telegram-callback-bridge-disabled");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    const agentId = readState(config.instance).agents[0]!.id;
    await addTelegramAllowlistEntry(config, bridge.id, { telegramUserId: 100, agentId });

    await mutateState(config.instance, (state) => {
      const liveBridge = state.messagingBridges.find((b) => b.id === bridge.id)!;
      liveBridge.telegram!.allowlist[0]!.chatSessionId = "chat_user100";
      state.chatSessions.push({
        id: "chat_user100",
        instance: state.instance,
        title: "user",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageIds: [],
        taskIds: [],
        runIds: []
      });
      state.approvals.push({
        id: "appr_disabled",
        instance: state.instance,
        action: "file.write",
        target: "/tmp/d",
        risk: "low",
        status: "pending",
        reason: "approval whose bridge was disabled",
        payload: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      state.messagingMessages.push({
        id: "msg_appr_disabled",
        instance: state.instance,
        bridgeId: bridge.id,
        direction: "outbound",
        status: "sent",
        target: "555",
        text: "approve?",
        externalId: "12",
        approvalId: "appr_disabled",
        chatSessionId: "chat_user100",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    });

    mockFetch(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));

    // Race shape: callback in flight, disable lands during the
    // resolveConnectorSecret await window via the per-instance
    // mutateState queue.
    const callbackPromise = handleCallbackQuery(config, bridge.id, {
      id: "cbq_disabled",
      from: { id: 100, username: "u" },
      data: "appr:appr_disabled"
    }, 91);
    const disablePromise = disableMessagingBridge(config, bridge.id);
    await Promise.all([callbackPromise, disablePromise]);

    const state = readState(config.instance);
    const approval = state.approvals.find((a) => a.id === "appr_disabled");
    expect(approval?.status).toBe("pending");
    const drop = state.audit.find(
      (a) =>
        a.action === "messaging.telegram.dropped" &&
        (a.evidence as Record<string, unknown> | undefined)?.reason === "callback_revoked"
    );
    expect(drop).toBeDefined();
    expect((drop!.evidence as Record<string, unknown>).reasonDetail).toBe("bridge_unavailable");
  });
});

describe("dispatchOutboundMessage", () => {
  test("connector-resolves the token and stamps externalId on success", async () => {
    const config = buildConfig("telegram-dispatch-ok");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token_value");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });

    const fetchLog = mockFetch(async (url) => {
      // Confirm the token went into the URL (the Bot API path includes
      // the token). We never log the token via audit — only here in the
      // test do we see it.
      expect(url).toContain("/bottoken_value/");
      return new Response(JSON.stringify({ ok: true, result: { message_id: 4242 } }), { status: 200 });
    });

    const message = await mutateState(config.instance, (state) => {
      return {
        id: "msg_out_1",
        instance: state.instance,
        bridgeId: bridge.id,
        direction: "outbound" as const,
        status: "queued" as const,
        target: "555",
        text: "hello",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    });
    await mutateState(config.instance, (state) => {
      state.messagingMessages.unshift(message);
    });

    const reloaded = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id)!;
    await dispatchOutboundMessage(config, reloaded, message);

    const updated = readState(config.instance).messagingMessages.find((m) => m.id === "msg_out_1");
    expect(updated?.status).toBe("sent");
    expect(updated?.externalId).toBe("4242");
    expect(fetchLog.length).toBeGreaterThan(0);
  });

  test("Telegram HTTP failure flips message status to failed with error captured", async () => {
    const config = buildConfig("telegram-dispatch-fail");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    mockFetch(async () =>
      new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }), { status: 400 })
    );
    const message = {
      id: "msg_fail",
      instance: config.instance,
      bridgeId: bridge.id,
      direction: "outbound" as const,
      status: "queued" as const,
      target: "bogus-chat",
      text: "hello",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await mutateState(config.instance, (s) => {
      s.messagingMessages.unshift(message);
    });
    const reloaded = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id)!;
    await dispatchOutboundMessage(config, reloaded, message);
    const updated = readState(config.instance).messagingMessages.find((m) => m.id === "msg_fail");
    expect(updated?.status).toBe("failed");
    expect(updated?.error).toContain("chat not found");
  });

  test("fetch-level network failure flips message status to failed", async () => {
    // Distinct from Telegram-shaped failures: this is a transport-level
    // throw (DNS, ECONNREFUSED, TLS). Without the postJson try/catch the
    // throw propagates past callers and the row stays "queued".
    const config = buildConfig("telegram-dispatch-network-throw");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    mockFetch(async () => {
      throw new Error("network unreachable");
    });
    const message = {
      id: "msg_net_throw",
      instance: config.instance,
      bridgeId: bridge.id,
      direction: "outbound" as const,
      status: "queued" as const,
      target: "555",
      text: "hello",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await mutateState(config.instance, (s) => {
      s.messagingMessages.unshift(message);
    });
    const reloaded = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id)!;
    await dispatchOutboundMessage(config, reloaded, message);
    const updated = readState(config.instance).messagingMessages.find((m) => m.id === "msg_net_throw");
    expect(updated?.status).toBe("failed");
    expect(updated?.error).toContain("network unreachable");
  });

  test("dispatch on a disabled bridge fails the row instead of shipping traffic", async () => {
    // Defense-in-depth: the messaging-finalize hook short-circuits
    // first, but any future caller (manual dispatch, future approval
    // re-emission) must also be refused once the bridge is disabled.
    const config = buildConfig("telegram-dispatch-disabled");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    await disableMessagingBridge(config, bridge.id);

    // The fail-closed fetch would throw if we leaked a request, so the
    // assertion below is two-fold: the row goes to "failed" AND the
    // mock is never invoked.
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      throw new Error("telegram.test: bridge-disabled path must not fetch");
    }) as unknown as typeof fetch;

    const message = {
      id: "msg_disabled",
      instance: config.instance,
      bridgeId: bridge.id,
      direction: "outbound" as const,
      status: "queued" as const,
      target: "555",
      text: "should not ship",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await mutateState(config.instance, (s) => {
      s.messagingMessages.unshift(message);
    });
    const reloaded = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id)!;
    expect(reloaded.status).toBe("disabled");
    await dispatchOutboundMessage(config, reloaded, message);

    expect(fetchCount).toBe(0);
    const updated = readState(config.instance).messagingMessages.find((m) => m.id === "msg_disabled");
    expect(updated?.status).toBe("failed");
    expect(updated?.error).toBe("Bridge is disabled");
  });

  test("bridge disabled mid-dispatch (post-secret-resolve) fails the row without shipping", async () => {
    // Pins the live-status re-check immediately before the
    // editMessageText/sendMessage call. The passed-in `bridge` is the
    // pre-await snapshot from the caller (messaging-finalize, manual
    // dispatch); a disable that lands during resolveConnectorSecret
    // would otherwise reach api.telegram.org because the line-101
    // guard only sees the stale snapshot.
    const config = buildConfig("telegram-dispatch-disabled-midflight");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });

    // Drain the poller so its background getUpdates loop doesn't bump
    // the per-test fetch counter while we exercise dispatch.
    await stopAllPollers();

    const message = {
      id: "msg_midflight_disabled",
      instance: config.instance,
      bridgeId: bridge.id,
      direction: "outbound" as const,
      status: "queued" as const,
      target: "555",
      text: "should not ship",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await mutateState(config.instance, (s) => {
      s.messagingMessages.unshift(message);
    });

    // Capture the bridge while it's still "configured" — this is the
    // snapshot the caller (messaging-finalize / manual dispatch) would
    // pass in, mirroring the line-37 capture in messaging-finalize.ts.
    const capturedBridge = readState(config.instance).messagingBridges.find(
      (b) => b.id === bridge.id
    )!;
    expect(capturedBridge.status).toBe("configured");

    // Disable the bridge AFTER the snapshot. The captured object still
    // says `configured`; only the live state knows the truth.
    await disableMessagingBridge(config, bridge.id);
    expect(capturedBridge.status).toBe("configured");

    // Now install the fetch counter — after disable, after stop, so the
    // only fetch that could increment it is a leak from dispatch.
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      throw new Error("telegram.test: mid-flight disable must not fetch");
    }) as unknown as typeof fetch;

    await dispatchOutboundMessage(config, capturedBridge, message);

    expect(fetchCount).toBe(0);
    const updated = readState(config.instance).messagingMessages.find(
      (m) => m.id === "msg_midflight_disabled"
    );
    expect(updated?.status).toBe("failed");
    expect(updated?.error).toBe("Bridge is disabled");
  });
});

describe("connector status cascade", () => {
  test("disabling the telegram connector stops the poller and flips the bridge to error", async () => {
    const config = buildConfig("telegram-connector-cascade-disable");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    // addMessagingBridge starts a poller eagerly when the bridge is
    // configured; assert it's running so the post-cascade check is
    // meaningful.
    expect(isPollerRunning(bridge.id)).toBe(true);

    await updateConnector(config, "id_conn", { status: "disabled" });

    expect(isPollerRunning(bridge.id)).toBe(false);
    const reloaded = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id)!;
    expect(reloaded.status).toBe("error");
    expect(reloaded.message).toMatch(/Connector disabled/);
    const audit = readState(config.instance).audit.find(
      (a) => a.action === "messaging.telegram.bridge_quiesced" && a.target === bridge.id
    );
    expect(audit).toBeDefined();
    expect((audit!.evidence as Record<string, unknown>).connectorId).toBe("id_conn");
  });

  test("connector + bridge flip atomically; no observer sees configured bridge under a disabled connector", async () => {
    // The cascade pulls the bridge-flip into the same `mutateState` as
    // the connector flip so any reader between the two writes is
    // impossible: there is only one write. We pin atomicity by holding
    // the next `mutateState` open behind a long-running fetch (the
    // poller's `getUpdates`) and then snapshotting state at the moment
    // `updateConnector` returns. If the bridge weren't part of the same
    // write the snapshot would show `(connector: disabled, bridge:
    // configured)`.
    const config = buildConfig("telegram-cascade-atomic");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });

    // The poller's `getUpdates` hangs forever on this fetch so its
    // `await handle.done` blocks the disable's `stopPoller` call until
    // we abort. The `mutateState` that flips the connector + bridge
    // commits BEFORE `stopPoller` is awaited, so we can snapshot in
    // that window.
    const { promise: getUpdatesHit, resolve: signalGetUpdatesHit } = Promise.withResolvers<void>();
    const { promise: getUpdatesUnblock, resolve: releaseGetUpdates } = Promise.withResolvers<void>();
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("getUpdates")) {
        signalGetUpdatesHit();
        // Block until the test releases us OR the abort signal fires.
        const signal = init?.signal;
        if (signal?.aborted) {
          return new Response("", { status: 599 });
        }
        const aborted = new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        await Promise.race([getUpdatesUnblock, aborted]);
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }) as unknown as typeof fetch;

    // Wait for the poller to land in its long-poll so a disable will
    // exercise the drain window.
    await getUpdatesHit;

    // Kick off the disable. `updateConnector` returns once its
    // `mutateState` commits; the drain (`stopPoller`) runs after. We
    // snapshot AFTER updateConnector resolves but BEFORE we release
    // the long poll, so we are guaranteed to be inside the drain
    // window.
    const updatePromise = updateConnector(config, "id_conn", { status: "disabled" });
    await updatePromise;
    const snapshot = readState(config.instance);
    const snapBridge = snapshot.messagingBridges.find((b) => b.id === bridge.id);
    const snapConnector = snapshot.connectors.find((c) => c.id === "id_conn");
    expect(snapConnector?.status).toBe("disabled");
    // Atomic invariant: if the connector is `disabled` then any
    // dependent telegram bridge must also no longer be `configured` —
    // both writes happen in the same mutateState.
    expect(snapBridge?.status).not.toBe("configured");
    expect(snapBridge?.status).toBe("error");

    // Release the long-poll fetch so the drain can complete. Without
    // this the afterEach teardown would hang.
    releaseGetUpdates();
    await stopAllPollers();
  });

  test("dispatchOutboundMessage refuses to ship through a disabled connector", async () => {
    const config = buildConfig("telegram-connector-resolver-guard");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    // Flip the connector status directly so the resolver sees a
    // disabled record while the bridge still claims `configured`. The
    // resolver throw is the line of defense even if the cascade somehow
    // failed to update the bridge.
    await mutateState(config.instance, (state) => {
      const c = state.connectors.find((c) => c.id === "id_conn")!;
      c.status = "disabled";
    });

    const message = {
      id: "msg_disabled_conn",
      instance: config.instance,
      bridgeId: bridge.id,
      direction: "outbound" as const,
      status: "queued" as const,
      target: "555",
      text: "hello",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await mutateState(config.instance, (s) => {
      s.messagingMessages.unshift(message);
    });
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      throw new Error("telegram.test: disabled connector must not fetch");
    }) as unknown as typeof fetch;
    const reloaded = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id)!;
    await dispatchOutboundMessage(config, reloaded, message);
    expect(fetchCount).toBe(0);
    const updated = readState(config.instance).messagingMessages.find((m) => m.id === "msg_disabled_conn");
    expect(updated?.status).toBe("failed");
    expect(updated?.error).toMatch(/disabled; only configured connectors/);
  });
});

describe("replyToMessagingFromTask status guard", () => {
  test("disabled bridge causes the terminal reply hook to audit-skip without dispatch", async () => {
    // Reproduces the operator-intuitive contract: once `disable` runs,
    // no outbound traffic ships — including the reply from a task that
    // was already running when the bridge was disabled.
    const config = buildConfig("telegram-finalize-disabled");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    const agentId = readState(config.instance).agents[0]!.id;
    await addTelegramAllowlistEntry(config, bridge.id, { telegramUserId: 100, agentId });

    mockFetch(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));

    await handleInboundMessage(config, bridge.id, {
      message_id: 1,
      from: { id: 100, username: "user" },
      chat: { id: 555, type: "private" },
      date: 0,
      text: "in-flight"
    }, 5);

    const inbound = readState(config.instance).messagingMessages.find(
      (m) => m.bridgeId === bridge.id && m.direction === "inbound"
    );
    const taskId = inbound!.taskId!;
    // Force-complete the task in state so the finalize hook treats it
    // as terminal.
    await mutateState(config.instance, (state) => {
      const task = state.tasks.find((t) => t.id === taskId);
      if (!task) throw new Error("task missing");
      task.status = "completed";
      task.summary = "all done";
    });

    // Now disable the bridge before the finalize hook runs.
    await disableMessagingBridge(config, bridge.id);

    // Replace fetch with a counter so a leaked send is loud.
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      throw new Error("telegram.test: finalize must not dispatch on a disabled bridge");
    }) as unknown as typeof fetch;

    const task = readState(config.instance).tasks.find((t) => t.id === taskId)!;
    await replyToMessagingFromTask(config, task);

    expect(fetchCount).toBe(0);
    const state = readState(config.instance);
    const outbound = state.messagingMessages.find(
      (m) => m.bridgeId === bridge.id && m.direction === "outbound" && m.taskId === taskId
    );
    expect(outbound).toBeUndefined();
    const skip = state.audit.find(
      (a) =>
        a.action === "messaging.telegram.skipped_disabled" &&
        (a.evidence as Record<string, unknown> | undefined)?.bridgeId === bridge.id
    );
    expect(skip).toBeDefined();
    expect((skip!.evidence as Record<string, unknown>).bridgeStatus).toBe("disabled");
    expect((skip!.evidence as Record<string, unknown>).taskId).toBe(taskId);
  });
});

describe("updateOffset persistence", () => {
  test("updateOffset survives a write-then-read round trip", async () => {
    const config = buildConfig("telegram-offset-roundtrip");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    await mutateState(config.instance, (state) => {
      const live = state.messagingBridges.find((b) => b.id === bridge.id)!;
      live.telegram!.updateOffset = 12345;
    });
    // Force a state re-read by going through readState again.
    const reloaded = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id)!;
    expect(reloaded.telegram?.updateOffset).toBe(12345);
  });

  test("inbound handler advances offset in the same mutation as the inbound row", async () => {
    const config = buildConfig("telegram-offset-with-inbound");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    const agentId = readState(config.instance).agents[0]!.id;
    await addTelegramAllowlistEntry(config, bridge.id, { telegramUserId: 1, agentId });
    mockFetch(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));

    await handleInboundMessage(config, bridge.id, {
      message_id: 9,
      from: { id: 1 },
      chat: { id: 100, type: "private" },
      date: 0,
      text: "x"
    }, 555);

    const live = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);
    expect(live?.telegram?.updateOffset).toBe(556);
  });
});

describe("/receive bypass guard", () => {
  test("receiveMessagingInput rejects telegram bridges", async () => {
    const config = buildConfig("telegram-receive-rejected");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    await expect(
      receiveMessagingInput(config, bridge.id, { text: "smuggled" })
    ).rejects.toThrow(/receive inbound messages via the poller/);
  });
});

describe("malformed payload handling", () => {
  test("malformed update audits and skips dispatch", async () => {
    // We exercise the validation path indirectly by importing the
    // module-private helper through its export. The poller routes
    // malformed updates through the same audit + offset advance code
    // path.
    const { isValidTelegramUpdate } = await import("./telegram-transport");
    expect(isValidTelegramUpdate({})).toBe(false);
    expect(isValidTelegramUpdate({ update_id: "not-a-number" })).toBe(false);
    expect(isValidTelegramUpdate({ update_id: 1, message: { /* no chat */ } })).toBe(false);
    expect(isValidTelegramUpdate({
      update_id: 1,
      callback_query: { id: "x" /* no from */ }
    })).toBe(false);
    expect(isValidTelegramUpdate({
      update_id: 1,
      message: { chat: { id: 2 } }
    })).toBe(true);
    expect(isValidTelegramUpdate({
      update_id: 1,
      callback_query: { id: "x", from: { id: 5 } }
    })).toBe(true);
  });
});

describe("startConfiguredTelegramPollers boot contract", () => {
  test("boot poller resumes from persisted updateOffset with long-poll timeout=30", async () => {
    // Pins the restart-from-offset contract that ADR
    // telegram-messaging-channel.md claims: after a runtime restart, the
    // poller's first getUpdates call must use the persisted offset and
    // the LONG_POLL_TIMEOUT_SECONDS long-poll window.
    const config = buildConfig("telegram-boot-poller-offset");
    install(config);
    await seedTelegramConnector(config, "id_conn", "token");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      connectorId: "id_conn"
    });
    // addMessagingBridge starts a poller eagerly; stop it so we can
    // simulate a fresh boot with a persisted offset.
    await stopAllPollers();
    await mutateState(config.instance, (state) => {
      const live = state.messagingBridges.find((b) => b.id === bridge.id)!;
      live.telegram!.updateOffset = 42;
    });

    const { promise: firstCall, resolve: signalFirstCall } = Promise.withResolvers<string>();
    const log = mockFetch(async (url) => {
      if (url.includes("getUpdates")) signalFirstCall(url);
      return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
    });

    startConfiguredTelegramPollers(config);
    const firstUrl = await firstCall;
    // Stop the loop before afterEach drains it so we don't race past
    // the assertions on a second iteration that bumps the call count.
    await stopAllPollers();

    expect(firstUrl).toContain("getUpdates");
    expect(firstUrl).toContain("offset=42");
    expect(firstUrl).toContain("timeout=30");
    expect(log.filter((entry) => entry.url.includes("getUpdates")).length).toBeGreaterThanOrEqual(1);
  });
});

describe("splitForTelegram", () => {
  test("short text stays in one chunk", () => {
    expect(splitForTelegram("hello")).toEqual(["hello"]);
  });

  test("oversized text splits across multiple chunks", () => {
    const chunk = "x".repeat(5000);
    const parts = splitForTelegram(chunk);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 4096)).toBe(true);
    // Reassemble — splitForTelegram drops the newline join marker so
    // the recombined string equals the original when there are no
    // newlines.
    expect(parts.join("")).toBe(chunk);
  });
});
