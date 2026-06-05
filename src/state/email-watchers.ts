// Email watcher state helpers (ADR email-watch.md).
//
// An EmailWatcherRecord is a durable per-(account, sender-query) watcher.
// The gmail poll worker reads each enabled watcher and wakes an agent turn
// on each new matching message. These helpers follow the createXRecord
// convention in records.ts: the builder mutates a RuntimeState in place and
// emits an audit row; the config-level wrappers go through mutateState so
// all state I/O serializes through the per-instance lock.

import type { EmailWatcherRecord, RuntimeConfig, RuntimeState } from "../types";
import { id, now } from "./ids";
import { addAudit } from "./audit";
import { createChatSession } from "./records";
import { deleteEmailSeenForWatcher } from "./memory-db";
import { mutateState, readState } from "./store";

export interface AddEmailWatcherInput {
  // Watch for mail from this address (builds `from:<sender> is:unread`).
  sender?: string;
  // Raw Gmail search query; wins over `sender` when both are given.
  query?: string;
  // The account to watch. v1 watches the single signed-in gws identity;
  // recorded for the multi-account future.
  account?: string;
  // Owning agent for the watcher + its dedicated chat session. Threaded by
  // internal callers (the email_watch tool) so the woken turns attribute to
  // the originating agent; the HTTP path leaves it to the active agent.
  agentId?: string;
}

// Build the Gmail query for a watcher: a raw query wins; otherwise
// `from:<sender> is:unread`; otherwise all unread mail.
export function buildWatcherQuery(input: { sender?: string; query?: string }): string {
  if (input.query) return input.query;
  if (input.sender) return `from:${input.sender} is:unread`;
  return "is:unread";
}

// Create a watcher plus its dedicated chat session in ONE mutateState write
// so a failure leaves no orphan session. The woken turns post their proposed
// replies into this session. Shared by the email_watch tool and the
// POST /api/email/watchers handler so both produce identical records.
export async function addEmailWatcher(
  config: RuntimeConfig,
  input: AddEmailWatcherInput
): Promise<EmailWatcherRecord> {
  const query = buildWatcherQuery(input);
  return mutateState(config.instance, (state) => {
    const owningAgentId = input.agentId ?? state.activeAgentId;
    const title = input.sender ? `Email watch: ${input.sender}` : "Email watch";
    const session = createChatSession(state, title, undefined, owningAgentId, "job", "channel");
    return createEmailWatcher(state, {
      agentId: owningAgentId,
      provider: "gmail",
      accountEmail: input.account,
      query,
      chatSessionId: session.id,
      enabled: true,
      status: "ok"
    });
  });
}

export function createEmailWatcher(
  state: RuntimeState,
  watcher: Omit<EmailWatcherRecord, "id" | "instance" | "status" | "createdAt" | "updatedAt"> &
    Partial<Pick<EmailWatcherRecord, "status">>
): EmailWatcherRecord {
  const at = now();
  const item: EmailWatcherRecord = {
    id: id("emailwatch"),
    instance: state.instance,
    status: "ok",
    createdAt: at,
    updatedAt: at,
    ...watcher
  };
  state.emailWatchers.unshift(item);
  addAudit(
    state,
    {
      actor: "user",
      action: "email.watcher.created",
      target: item.id,
      risk: "low",
      evidence: { provider: item.provider, query: item.query, accountEmail: item.accountEmail }
    },
    item.agentId ? { agentId: item.agentId } : { system: true }
  );
  return item;
}

export function listEmailWatchers(config: RuntimeConfig): EmailWatcherRecord[] {
  return readState(config.instance).emailWatchers;
}

export function getEmailWatcher(config: RuntimeConfig, watcherId: string): EmailWatcherRecord | undefined {
  return readState(config.instance).emailWatchers.find((item) => item.id === watcherId);
}

// Apply a field patch to a watcher inside the per-instance lock. Used by the
// poll worker to advance the cursor / flip status crash-safely, and by the
// tool/API to enable/disable. Returns the updated record (or undefined when
// the watcher vanished mid-flight).
export async function updateEmailWatcher(
  config: RuntimeConfig,
  watcherId: string,
  patch: Partial<Pick<EmailWatcherRecord, "query" | "labelIds" | "lastSeenInternalDate" | "enabled" | "status" | "lastError" | "lastPolledAt" | "accountEmail" | "credentialName">>
): Promise<EmailWatcherRecord | undefined> {
  return mutateState(config.instance, (state) => {
    const item = state.emailWatchers.find((candidate) => candidate.id === watcherId);
    if (!item) return undefined;
    Object.assign(item, patch);
    item.updatedAt = now();
    return item;
  });
}

export async function removeEmailWatcher(config: RuntimeConfig, watcherId: string): Promise<EmailWatcherRecord> {
  const removed = await mutateState(config.instance, (state) => {
    const index = state.emailWatchers.findIndex((candidate) => candidate.id === watcherId);
    if (index < 0) throw new Error(`Email watcher not found: ${watcherId}`);
    const [item] = state.emailWatchers.splice(index, 1);
    addAudit(
      state,
      {
        actor: "user",
        action: "email.watcher.removed",
        target: item!.id,
        risk: "low",
        evidence: { provider: item!.provider, query: item!.query }
      },
      item!.agentId ? { agentId: item!.agentId } : { system: true }
    );
    return item!;
  });
  // Drop the watcher's dedup rows so they don't outlive it. Lives in memory.db
  // (not state.json), so it's done outside the state lock.
  deleteEmailSeenForWatcher(config.instance, watcherId);
  return removed;
}
