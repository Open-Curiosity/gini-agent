import type { ChatSessionRecord, ConnectorSecretRef, MessagingBridgeRecord, RuntimeConfig } from "../types";
import { submitTask } from "../agent";
import {
  addAudit,
  createMessagingBridgeRecord,
  createMessagingMessageRecord,
  findOrCreateDiscordChatSession,
  findOrCreateTelegramChatSession,
  mutateState,
  now,
  readState
} from "../state";
import { submitChatMessage } from "../execution/chat";
import { deleteConnectorSecrets, readSecret, writeSecret } from "../state/secrets";
import { resolveEffectiveContext } from "../execution/effective-context";
import {
  createTelegramClient,
  type TelegramClient,
  type TelegramClientOptions,
  type TelegramPhotoSource
} from "./telegram";
import {
  createDiscordClient,
  type DiscordClient,
  type DiscordClientOptions
} from "./discord";
import { formatTelegramMarkdownV2 } from "./telegram-format";
import type { MessagingMessageMedia } from "../types";

// Namespace used when storing per-bridge secrets through the connector
// secret store. Keeping it stable lets `deleteConnectorSecrets` find every
// secret a bridge owns even if the bridge's secretRefs list ever drifts.
function bridgeSecretNamespace(bridgeId: string): string {
  return `messaging.${bridgeId}`;
}

// Validate that a bot token is safe to embed in an HTTP request line —
// printable ASCII only, no whitespace, no control characters. Without
// this, a token containing a newline or control char would be rejected
// at fetch time and the resulting error message includes the full
// `Authorization: Bot <token>` header value, which then lands in
// `bridge.message` / `MessagingMessageRecord.error` and leaks via
// `GET /api/messaging`. Rejecting at create time stops the leak at
// the source.
const HEADER_SAFE_TOKEN = /^[\x21-\x7E]+$/;
function assertHeaderSafeToken(kind: string, raw: string): void {
  if (!HEADER_SAFE_TOKEN.test(raw)) {
    throw new Error(
      `${kind === "telegram" ? "Telegram" : "Discord"} bot token contains invalid characters — header-safe printable ASCII only.`
    );
  }
}

// Strip any "Bot <token>" residue from error strings before they land
// in state. Belt-and-suspenders defense for the case where some
// future code path constructs a request with a token that slipped
// past assertHeaderSafeToken (e.g. test seam injecting raw tokens),
// and the underlying transport echoes the auth header.
function sanitizeBridgeError(message: string): string {
  return message.replace(/Bot\s+\S+/g, "Bot <redacted>");
}

// Test seam: production code calls Telegram / Discord for real, but tests
// inject stubbed clients so we can exercise send/health/poll without
// network IO. Each provider gets its own factory so a test can swap one
// without disturbing the other.
export interface MessagingDeps {
  telegramClientFactory?: (token: string) => TelegramClient;
  discordClientFactory?: (token: string) => DiscordClient;
}

let injectedDeps: MessagingDeps = {};
export function setMessagingDeps(deps: MessagingDeps): void {
  injectedDeps = deps;
}
export function resetMessagingDeps(): void {
  injectedDeps = {};
}

function telegramClientFor(token: string, options?: TelegramClientOptions): TelegramClient {
  if (injectedDeps.telegramClientFactory) return injectedDeps.telegramClientFactory(token);
  return createTelegramClient(token, options);
}

function discordClientFor(token: string, options?: DiscordClientOptions): DiscordClient {
  if (injectedDeps.discordClientFactory) return injectedDeps.discordClientFactory(token);
  return createDiscordClient(token, options);
}

// Translate the caller's photo input into a TelegramPhotoSource. Returns
// undefined when no photo is supplied. We accept url/fileId/path on a
// nested `photo` object; bytes uploads aren't reachable from the HTTP
// surface today (no multipart inbound) and are reserved for in-process
// callers like the agent's tool dispatcher.
function parsePhotoInput(raw: unknown): TelegramPhotoSource | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const photo = raw as { url?: unknown; fileId?: unknown; path?: unknown; filename?: unknown; contentType?: unknown };
  if (typeof photo.url === "string" && photo.url) return { kind: "url", url: photo.url };
  if (typeof photo.fileId === "string" && photo.fileId) return { kind: "fileId", fileId: photo.fileId };
  if (typeof photo.path === "string" && photo.path) {
    return {
      kind: "path",
      path: photo.path,
      filename: typeof photo.filename === "string" ? photo.filename : undefined,
      contentType: typeof photo.contentType === "string" ? photo.contentType : undefined
    };
  }
  return undefined;
}

function mediaRecordForOutbound(source: TelegramPhotoSource | undefined): MessagingMessageMedia | undefined {
  if (!source) return undefined;
  if (source.kind === "url") return { kind: "photo", url: source.url };
  if (source.kind === "fileId") return { kind: "photo", fileId: source.fileId };
  if (source.kind === "path") return { kind: "photo", path: source.path };
  return { kind: "photo" };
}

export function readBridgeBotToken(config: RuntimeConfig, bridge: MessagingBridgeRecord): string | undefined {
  const ref = bridge.secretRefs?.find((candidate) => candidate.purpose === "bot-token");
  if (!ref) return undefined;
  return readSecret(config.instance, ref);
}

// Read the bot token without surfacing ENOENT — used by the API
// callers (checkMessagingBridge, sendMessagingOutput) that need to
// distinguish "no secret on record" (undefined) from "secret on
// record but unreadable" (still undefined here; the poller's
// markBridgeError path handles flipping status to "error"). Without
// this, a missing/corrupt secret file 500s the HTTP endpoint instead
// of producing a typed bridge error.
function readBridgeBotTokenQuiet(config: RuntimeConfig, bridge: MessagingBridgeRecord): string | undefined {
  try {
    return readBridgeBotToken(config, bridge);
  } catch {
    return undefined;
  }
}

export async function addMessagingBridge(config: RuntimeConfig, input: Record<string, unknown>) {
  const name = String(input.name ?? "");
  const kind = String(input.kind ?? "demo");
  if (!name) throw new Error("Messaging bridge name is required.");

  // Telegram and Discord both need a bot token. The credential travels
  // in on the create payload exactly once and is immediately handed to
  // the encrypted secret store; the plaintext never lands on the bridge
  // record or in audit evidence.
  const requiresToken = kind === "telegram" || kind === "discord";
  const botToken = requiresToken && typeof input.botToken === "string" ? input.botToken.trim() : "";
  if (requiresToken && !botToken) {
    throw new Error(`${kind === "telegram" ? "Telegram" : "Discord"} bridges require a botToken in the create payload.`);
  }
  if (requiresToken) {
    // Reject malformed tokens at create time. Without this, a token
    // containing a control character would be accepted, persisted to
    // the encrypted secret store, and then leak via the eventual
    // fetch error (Bun's HTTP layer echoes the auth header value in
    // its rejection message, which we persist to bridge.message).
    assertHeaderSafeToken(kind, botToken);
  }

  const bridge = await mutateState(config.instance, (state) => createMessagingBridgeRecord(state, {
    name,
    kind,
    deliveryTargets: Array.isArray(input.deliveryTargets) ? input.deliveryTargets.map(String) : []
  }));

  if (requiresToken) {
    const ref = writeSecret(config.instance, bridgeSecretNamespace(bridge.id), "bot-token", botToken);
    return mutateState(config.instance, (state) => attachSecretRef(state.messagingBridges, bridge.id, ref));
  }

  return bridge;
}

function attachSecretRef(
  bridges: MessagingBridgeRecord[],
  bridgeId: string,
  ref: ConnectorSecretRef
): MessagingBridgeRecord {
  const bridge = bridges.find((item) => item.id === bridgeId);
  if (!bridge) throw new Error(`Messaging bridge not found: ${bridgeId}`);
  const existing = bridge.secretRefs ?? [];
  const filtered = existing.filter((candidate) => candidate.purpose !== ref.purpose);
  bridge.secretRefs = [...filtered, ref];
  bridge.updatedAt = now();
  return bridge;
}

export async function checkMessagingBridge(config: RuntimeConfig, idOrName: string) {
  const bridge = readState(config.instance).messagingBridges.find(
    (item) => item.id === idOrName || item.name === idOrName
  );
  if (!bridge) throw new Error(`Messaging bridge not found: ${idOrName}`);

  // Per-kind health round-trip. We do the network call *outside*
  // mutateState so the lock isn't held for the duration of the
  // request, then fold the outcome back in. Only fields we actually
  // refresh (botUsername, botId) land in `metadataPatch` — the final
  // mutateState merges them into the live bridge so concurrent
  // metadata writes (the inbound poller advancing watermarks, etc.)
  // don't get clobbered by a stale snapshot.
  let nextStatus: MessagingBridgeRecord["status"] = "configured";
  let nextMessage: string;
  const metadataPatch: Record<string, unknown> = {};

  if (bridge.kind === "telegram") {
    const token = readBridgeBotTokenQuiet(config, bridge);
    if (!token) {
      nextStatus = "error";
      nextMessage = "Telegram bot token is missing — recreate the bridge with a botToken.";
    } else {
      try {
        const me = await telegramClientFor(token).getMe();
        metadataPatch.botUsername = me.username;
        metadataPatch.botId = me.id;
        nextMessage = me.username
          ? `Connected as @${me.username}.`
          : `Connected as bot ${me.id}.`;
      } catch (error) {
        nextStatus = "error";
        nextMessage = sanitizeBridgeError(error instanceof Error ? error.message : String(error));
      }
    }
  } else if (bridge.kind === "discord") {
    const token = readBridgeBotTokenQuiet(config, bridge);
    if (!token) {
      nextStatus = "error";
      nextMessage = "Discord bot token is missing — recreate the bridge with a botToken.";
    } else {
      try {
        const me = await discordClientFor(token).getMe();
        metadataPatch.botUsername = me.username;
        metadataPatch.botId = me.id;
        if (typeof me.global_name === "string" && me.global_name.length > 0) {
          metadataPatch.globalName = me.global_name;
        }
        // Newer Discord accounts return discriminator "0" and surface
        // the handle via global_name; older bots keep username#discriminator.
        const handle = me.global_name && me.global_name.length > 0
          ? me.global_name
          : me.discriminator && me.discriminator !== "0"
            ? `${me.username}#${me.discriminator}`
            : me.username;
        nextMessage = `Connected as ${handle}.`;
      } catch (error) {
        nextStatus = "error";
        nextMessage = sanitizeBridgeError(error instanceof Error ? error.message : String(error));
      }
    }
  } else if (bridge.kind === "demo") {
    nextMessage = "Demo messaging bridge is available for local inbound/outbound task messages.";
  } else {
    nextMessage = `${bridge.kind} bridge is configured with local Gini task routing.`;
  }

  return mutateState(config.instance, (state) => {
    const live = state.messagingBridges.find((item) => item.id === bridge.id);
    if (!live) throw new Error(`Messaging bridge not found: ${idOrName}`);
    live.lastHealthAt = now();
    live.status = nextStatus;
    live.message = nextMessage;
    // Merge into the live metadata instead of overwriting from the
    // pre-await snapshot — concurrent poller writes to
    // metadata.lastInboundExternalIds / lastOffset must survive.
    live.metadata = { ...(live.metadata ?? {}), ...metadataPatch };
    live.updatedAt = live.lastHealthAt;
    addAudit(state, {
      actor: "runtime",
      action: "messaging.health",
      target: live.id,
      risk: "low",
      evidence: { kind: live.kind, status: live.status }
    });
    return live;
  });
}

export function listMessagingMessages(config: RuntimeConfig, bridgeId?: string) {
  const messages = readState(config.instance).messagingMessages;
  return bridgeId ? messages.filter((message) => message.bridgeId === bridgeId) : messages;
}

export async function receiveMessagingInput(config: RuntimeConfig, idOrName: string, input: Record<string, unknown>) {
  const bridge = readState(config.instance).messagingBridges.find((item) => item.id === idOrName || item.name === idOrName);
  if (!bridge) throw new Error(`Messaging bridge not found: ${idOrName}`);
  if (bridge.status !== "configured") throw new Error(`Messaging bridge is not configured: ${idOrName}`);
  const text = String(input.text ?? "").trim();
  const media = parseInboundMedia(input.media);
  if (!text && !media) throw new Error("Inbound message text or media is required.");

  // Target validation is per-kind. Don't coerce a missing target to
  // "local" before the kind branches — that would mask required-target
  // guards (e.g. Discord's channel id). Each branch decides whether
  // the target is optional and what default applies. We accept
  // strings and finite numbers (JSON clients commonly send Telegram
  // chat_ids as numbers); everything else collapses to the empty
  // string which the per-kind guards reject.
  const rawTarget = typeof input.target === "string"
    ? input.target
    : typeof input.target === "number" && Number.isFinite(input.target)
      ? String(input.target)
      : "";

  // Telegram + Discord inbound run through the chat-task path so each
  // chat / channel gets a persistent conversation — same surface as the
  // web chat UI. The session carries a `source` descriptor so the
  // runtime can mirror assistant replies back out to the originating
  // chat. demo / generic bridges keep the standalone-task path for
  // tests and CLI parity.
  let taskId: string;
  let sessionId: string | undefined;
  let target: string;
  if (bridge.kind === "telegram") {
    const chatId = Number.parseInt(rawTarget, 10);
    if (!Number.isFinite(chatId)) {
      throw new Error(`Telegram inbound target must be a numeric chat_id (got '${rawTarget}').`);
    }
    target = String(chatId);
    const session = await mutateState(config.instance, (state) =>
      findOrCreateTelegramChatSession(state, bridge.id, chatId)
    );
    const result = await submitChatMessage(config, session.id, { content: text });
    taskId = result.taskId;
    sessionId = session.id;
  } else if (bridge.kind === "discord") {
    const channelId = rawTarget.trim();
    if (!channelId) {
      throw new Error("Discord inbound target (channel id) is required.");
    }
    target = channelId;
    const session = await mutateState(config.instance, (state) =>
      findOrCreateDiscordChatSession(state, bridge.id, channelId)
    );
    const result = await submitChatMessage(config, session.id, { content: text });
    taskId = result.taskId;
    sessionId = session.id;
  } else {
    target = rawTarget || "local";
    const task = await submitTask(config, text);
    taskId = task.id;
  }

  // The chat session id is preserved on the message record itself —
  // see notificationId field reuse below would be wrong, so we just
  // re-resolve via taskId when the reply mirror needs it.
  void sessionId;
  return mutateState(config.instance, (state) =>
    createMessagingMessageRecord(state, {
      bridgeId: bridge.id,
      direction: "inbound",
      status: "received",
      target,
      text,
      taskId,
      media
    })
  );
}

// Resolve a telegram-sourced chat session from a (bridge, chat_id)
// pair. The reply-mirror loop calls this to find where to land the
// assistant message and where to dispatch the outbound reply.
export function findTelegramChatSession(
  config: RuntimeConfig,
  bridgeId: string,
  chatId: number
): ChatSessionRecord | undefined {
  return readState(config.instance).chatSessions.find(
    (session) =>
      session.source?.kind === "telegram" &&
      session.source.bridgeId === bridgeId &&
      session.source.chatId === chatId
  );
}

// Same shape, Discord side: resolve the chat session bound to a
// (bridge, channel) pair so the reply-mirror in the discord poller can
// look up the dispatch target without re-querying Discord.
export function findDiscordChatSession(
  config: RuntimeConfig,
  bridgeId: string,
  channelId: string
): ChatSessionRecord | undefined {
  return readState(config.instance).chatSessions.find(
    (session) =>
      session.source?.kind === "discord" &&
      session.source.bridgeId === bridgeId &&
      session.source.channelId === channelId
  );
}

function parseInboundMedia(raw: unknown): MessagingMessageMedia | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as MessagingMessageMedia;
  if (value.kind !== "photo") return undefined;
  return {
    kind: "photo",
    ...(typeof value.url === "string" ? { url: value.url } : {}),
    ...(typeof value.fileId === "string" ? { fileId: value.fileId } : {}),
    ...(typeof value.path === "string" ? { path: value.path } : {})
  };
}

// In-process options that don't travel over HTTP. Today this carries
// only an AbortSignal so the supervisor's stopAll can cancel an
// in-flight Discord POST instead of waiting it out. HTTP callers
// (POST /api/messaging/:id/send) pass undefined; internal callers
// (the poller's detached reply mirror) pass the loop's signal.
export interface SendMessagingOptions {
  signal?: AbortSignal;
}

export async function sendMessagingOutput(
  config: RuntimeConfig,
  idOrName: string,
  input: Record<string, unknown>,
  options: SendMessagingOptions = {}
) {
  const bridge = readState(config.instance).messagingBridges.find(
    (item) => item.id === idOrName || item.name === idOrName
  );
  if (!bridge) throw new Error(`Messaging bridge not found: ${idOrName}`);

  // Photo input variants. Callers supply at most one of url/fileId/path
  // on `input.photo`. When present, `text` becomes the optional caption;
  // a caption-only send still requires non-empty text-or-photo somewhere.
  const photoSource = parsePhotoInput(input.photo);
  const text = String(input.text ?? "").trim();
  if (!text && !photoSource) throw new Error("Outbound message requires text or a photo.");

  // Active-agent messaging-target whitelist. When the caller supplies an
  // explicit target outside the filter we reject loudly so a misrouted
  // message can't sneak past the agent's policy. When the caller doesn't
  // specify a target we pick the first bridge.deliveryTarget that's
  // permitted; if none are permitted we fall back to the bridge's
  // first target so messaging never silently fails on a fresh instance
  // with no agent restriction.
  const state = readState(config.instance);
  const effective = resolveEffectiveContext(state, config);
  const requested = typeof input.target === "string" && input.target.length > 0 ? input.target : undefined;
  let target: string;
  if (requested !== undefined) {
    if (effective.messagingTargetFilter && !effective.messagingTargetFilter.has(requested)) {
      const agentLabel = effective.agentId ?? "active agent";
      throw new Error(`Target '${requested}' not permitted by active agent '${agentLabel}'`);
    }
    target = requested;
  } else if (effective.messagingTargetFilter) {
    const permitted = bridge.deliveryTargets.find((t) => effective.messagingTargetFilter!.has(t));
    target = permitted ?? bridge.deliveryTargets[0] ?? "local";
  } else {
    target = bridge.deliveryTargets[0] ?? "local";
  }

  let status: "sent" | "failed" = bridge.status === "configured" ? "sent" : "failed";
  let errorMessage: string | undefined =
    status === "failed" ? `Bridge is ${bridge.status}` : undefined;

  if (status === "sent" && bridge.kind === "telegram") {
    const token = readBridgeBotTokenQuiet(config, bridge);
    if (!token) {
      status = "failed";
      errorMessage = "Telegram bot token is missing.";
    } else {
      // Default: render the body as MarkdownV2 so the common agent
      // outputs (bold, inline code, fenced blocks) survive instead of
      // arriving as plain text. Callers that already speak Telegram's
      // dialect (or want a literal payload) can pass `parseMode: "none"`
      // to skip the converter and send the raw string.
      const parseModeRaw = typeof input.parseMode === "string" ? input.parseMode : undefined;
      const useMdv2 = parseModeRaw !== "none";
      const formatted = useMdv2 ? formatTelegramMarkdownV2(text) : text;
      try {
        const client = telegramClientFor(token);
        if (photoSource) {
          await client.sendPhoto(target, photoSource, {
            caption: formatted || undefined,
            parseMode: useMdv2 && formatted ? "MarkdownV2" : undefined
          });
        } else {
          await client.sendMessage(target, formatted, useMdv2 ? { parseMode: "MarkdownV2" } : undefined);
        }
      } catch (error) {
        status = "failed";
        errorMessage = sanitizeBridgeError(error instanceof Error ? error.message : String(error));
      }
    }
  } else if (status === "sent" && bridge.kind === "discord") {
    const token = readBridgeBotTokenQuiet(config, bridge);
    if (!token) {
      status = "failed";
      errorMessage = "Discord bot token is missing.";
    } else if (photoSource) {
      // Photo uploads are a follow-up — Discord requires multipart
      // attachments with a different payload shape. Fail loudly so the
      // outbound record records the reason instead of silently dropping.
      status = "failed";
      errorMessage = "Discord bridge does not support photo sends yet.";
    } else if (!text) {
      // Discord rejects content-less messages with HTTP 400. We
      // intercept before the network call so the audit row carries a
      // useful reason.
      status = "failed";
      errorMessage = "Discord messages require non-empty text.";
    } else {
      try {
        await discordClientFor(token).sendMessage(target, text, { signal: options.signal });
      } catch (error) {
        status = "failed";
        errorMessage = sanitizeBridgeError(error instanceof Error ? error.message : String(error));
      }
    }
  }

  const media = mediaRecordForOutbound(photoSource);

  return mutateState(config.instance, (live) => {
    const message = createMessagingMessageRecord(live, {
      bridgeId: bridge.id,
      direction: "outbound",
      status,
      target,
      text,
      notificationId: typeof input.notificationId === "string" ? input.notificationId : undefined,
      error: errorMessage,
      media
    });
    addAudit(live, {
      actor: "runtime",
      action: "messaging.sent",
      target: bridge.id,
      risk: "low",
      evidence: { messageId: message.id, status, target }
    });
    return message;
  });
}

export async function disableMessagingBridge(config: RuntimeConfig, idOrName: string) {
  const bridge = await mutateState(config.instance, (state) => {
    const live = state.messagingBridges.find((item) => item.id === idOrName || item.name === idOrName);
    if (!live) throw new Error(`Messaging bridge not found: ${idOrName}`);
    live.status = "disabled";
    live.updatedAt = now();
    addAudit(state, { actor: "user", action: "messaging.disabled", target: live.id, risk: "medium" });
    return live;
  });
  // Drop the on-disk encrypted secret files. We do this after the state
  // mutation so a crash mid-disable leaves the bridge marked disabled even
  // if the file cleanup fails — the inbound poller skips disabled bridges
  // so a stranded token can't be used.
  deleteConnectorSecrets(config.instance, bridgeSecretNamespace(bridge.id));
  await mutateState(config.instance, (state) => {
    const live = state.messagingBridges.find((item) => item.id === bridge.id);
    if (live) live.secretRefs = [];
    return live;
  });
  return bridge;
}
