// CRUD + query-building tests for email watchers (ADR email-watch.md).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig } from "../types";
import {
  addEmailWatcher,
  buildWatcherQuery,
  closeAllMemoryDbs,
  getEmailWatcher,
  isEmailSeen,
  listEmailWatchers,
  markEmailSeen,
  readState,
  removeEmailWatcher,
  updateEmailWatcher
} from ".";

const ROOT = mkdtempSync(join(tmpdir(), "gini-email-watchers-test-"));

beforeAll(() => {
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  closeAllMemoryDbs();
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(`${ROOT}-logs`, { recursive: true, force: true });
});

function buildConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot: ROOT,
    stateRoot: ROOT,
    logRoot: `${ROOT}-logs`
  };
}

describe("buildWatcherQuery", () => {
  test("raw query wins over sender", () => {
    expect(buildWatcherQuery({ sender: "a@x.com", query: "subject:urgent" })).toBe("subject:urgent");
  });
  test("sender builds from:<sender> is:unread", () => {
    expect(buildWatcherQuery({ sender: "a@x.com" })).toBe("from:a@x.com is:unread");
  });
  test("no sender/query falls back to is:unread", () => {
    expect(buildWatcherQuery({})).toBe("is:unread");
  });
});

describe("watcher CRUD", () => {
  test("add creates an enabled watcher with a dedicated chat session", async () => {
    const config = buildConfig("ew-add");
    const watcher = await addEmailWatcher(config, { sender: "alice@x.com" });
    expect(watcher.enabled).toBe(true);
    expect(watcher.status).toBe("ok");
    expect(watcher.query).toBe("from:alice@x.com is:unread");
    expect(watcher.chatSessionId).toBeDefined();
    // The dedicated chat session exists.
    const state = readState(config.instance);
    expect(state.chatSessions.some((s) => s.id === watcher.chatSessionId)).toBe(true);
    expect(state.emailWatchers).toHaveLength(1);
  });

  test("list + get reflect the created watcher", async () => {
    const config = buildConfig("ew-list");
    const watcher = await addEmailWatcher(config, { query: "subject:invoice is:unread" });
    expect(listEmailWatchers(config).map((w) => w.id)).toContain(watcher.id);
    expect(getEmailWatcher(config, watcher.id)?.query).toBe("subject:invoice is:unread");
  });

  test("update patches fields and bumps updatedAt", async () => {
    const config = buildConfig("ew-update");
    const watcher = await addEmailWatcher(config, { sender: "bob@x.com" });
    const updated = await updateEmailWatcher(config, watcher.id, {
      lastSeenInternalDate: "12345",
      status: "needs_auth"
    });
    expect(updated?.lastSeenInternalDate).toBe("12345");
    expect(updated?.status).toBe("needs_auth");
  });

  test("update on a missing watcher returns undefined", async () => {
    const config = buildConfig("ew-update-missing");
    expect(await updateEmailWatcher(config, "nope", { status: "ok" })).toBeUndefined();
  });

  test("remove deletes the watcher", async () => {
    const config = buildConfig("ew-remove");
    const watcher = await addEmailWatcher(config, { sender: "carol@x.com" });
    await removeEmailWatcher(config, watcher.id);
    expect(getEmailWatcher(config, watcher.id)).toBeUndefined();
    expect(listEmailWatchers(config)).toHaveLength(0);
  });

  test("remove on a missing watcher throws", async () => {
    const config = buildConfig("ew-remove-missing");
    await expect(removeEmailWatcher(config, "nope")).rejects.toThrow("Email watcher not found");
  });
});

describe("email_seen dedup store", () => {
  test("markEmailSeen is idempotent and isEmailSeen reflects it", () => {
    const config = buildConfig("ew-seen");
    expect(isEmailSeen(config.instance, "w1", "m1")).toBe(false);
    markEmailSeen(config.instance, "w1", "m1");
    markEmailSeen(config.instance, "w1", "m1"); // idempotent
    expect(isEmailSeen(config.instance, "w1", "m1")).toBe(true);
    // Scoped per watcher.
    expect(isEmailSeen(config.instance, "w2", "m1")).toBe(false);
  });
});
