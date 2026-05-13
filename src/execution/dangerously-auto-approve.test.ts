// Regression tests for the dangerouslyAutoApprove dispatch path.
//
// The flag flips every approval-gated tool from "create a pending
// approval, pause the task" into "create the approval, immediately
// resolve it through executeApprovedAction, return the result string
// synchronously." These tests use the echo provider with stubbed tool-
// calling responses to drive the chat-task loop end-to-end without a
// real LLM, then verify both the task outcome and the audit trail
// (approval.requested -> approval.approved -> <action>) carries the
// autoApprovedReason marker that downstream auditors rely on.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearEchoToolCallingResponses,
  setEchoToolCallingResponse,
  normalizeProvider
} from "../provider";
import { submitTask, resolveApproval, decideApproval } from "../agent";
import { readState, mutateState, createApproval } from "../state";
import type { RuntimeConfig, Task } from "../types";

function buildConfig(workspaceRoot: string, instance: string, opts: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    instance,
    port: 7338,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: process.env.GINI_STATE_ROOT ?? "/tmp/gini-dangerously-test",
    logRoot: process.env.GINI_LOG_ROOT ?? "/tmp/gini-dangerously-test-logs",
    ...opts
  };
}

async function waitForTerminal(config: RuntimeConfig, taskId: string, timeoutMs = 5000): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readState(config.instance);
    const task = state.tasks.find((t) => t.id === taskId);
    if (task && (task.status === "completed" || task.status === "failed" || task.status === "cancelled" || task.status === "waiting_approval")) {
      return task;
    }
    await Bun.sleep(20);
  }
  throw new Error(`Task ${taskId} did not reach terminal state within ${timeoutMs}ms`);
}

describe("dangerouslyAutoApprove dispatch", () => {
  let root: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-dangerously-"));
    prevState = process.env.GINI_STATE_ROOT;
    prevLog = process.env.GINI_LOG_ROOT;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
    clearEchoToolCallingResponses();
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = prevLog;
    rmSync(root, { recursive: true, force: true });
    clearEchoToolCallingResponses();
  });

  test("file_write auto-resolves when the flag is on (no pause, file on disk, audit marker stamped)", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-dangerously-ws-"));
    const config = buildConfig(workspaceRoot, "dangerously-fw", { dangerouslyAutoApprove: true });
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_w", type: "function", function: { name: "file_write", arguments: JSON.stringify({ path: "auto.txt", content: "auto" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Wrote it.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "write auto.txt", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Wrote it.");
    expect(finished.toolCallState).toBeUndefined();
    expect(await Bun.file(join(workspaceRoot, "auto.txt")).text()).toBe("auto");

    const state = readState(config.instance);

    // Approval row was created AND marked approved automatically.
    const approvals = state.approvals.filter((a) => a.taskId === task.id);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.status).toBe("approved");
    expect(approvals[0]?.action).toBe("file.write");

    // The approval-approved audit row carries the marker (actor=runtime
    // because this was the auto-approve path, not a human deciding).
    const approveAudits = state.audit.filter((a) => a.action === "approval.approved" && a.approvalId === approvals[0]?.id);
    expect(approveAudits).toHaveLength(1);
    expect(approveAudits[0]?.actor).toBe("runtime");
    expect(approveAudits[0]?.evidence?.autoApproved).toBe(true);
    expect(approveAudits[0]?.evidence?.autoApprovedReason).toBe("dangerouslyAutoApprove");

    // The side-effect audit row (file.write) also carries the marker so
    // a reviewer scanning by action sees why the human gate was skipped.
    const writeAudits = state.audit.filter((a) => a.action === "file.write" && a.taskId === task.id);
    expect(writeAudits).toHaveLength(1);
    expect(writeAudits[0]?.evidence?.autoApprovedReason).toBe("dangerouslyAutoApprove");
    expect(writeAudits[0]?.evidence?.beforeBytes).toBe(0);
    expect(writeAudits[0]?.evidence?.afterBytes).toBe(4);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("file_write pauses normally when the flag is off (default behavior preserved)", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-dangerously-ws-"));
    const config = buildConfig(workspaceRoot, "dangerously-off");
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_w", type: "function", function: { name: "file_write", arguments: JSON.stringify({ path: "still.txt", content: "still" }) } }
      ],
      finishReason: "tool_calls"
    });

    const task = await submitTask(config, "write still.txt", { mode: "chat" });
    const paused = await waitForTerminal(config, task.id);

    expect(paused.status).toBe("waiting_approval");
    expect(paused.approvalIds).toHaveLength(1);
    expect(existsSync(join(workspaceRoot, "still.txt"))).toBe(false);

    // The approval-approved audit row must NOT exist yet — the human
    // hasn't approved and the flag is off so nothing auto-fired.
    const state = readState(config.instance);
    const approveAudits = state.audit.filter((a) => a.action === "approval.approved" && a.taskId === task.id);
    expect(approveAudits).toHaveLength(0);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("terminal_exec auto-resolves through the same path when the flag is on", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-dangerously-ws-"));
    // No autoApproveCommands — so the allowlist fast path is OFF and the
    // command must go through pendingOrAuto -> resolveApproval.
    const config = buildConfig(workspaceRoot, "dangerously-term", { dangerouslyAutoApprove: true });
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_t", type: "function", function: { name: "terminal_exec", arguments: JSON.stringify({ command: "echo from-dangerous" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Ran it.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "run echo", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Ran it.");

    const state = readState(config.instance);
    const approvals = state.approvals.filter((a) => a.taskId === task.id);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.status).toBe("approved");
    expect(approvals[0]?.action).toBe("terminal.exec");

    const execAudits = state.audit.filter((a) => a.action === "terminal.exec" && a.taskId === task.id);
    expect(execAudits).toHaveLength(1);
    expect(execAudits[0]?.evidence?.autoApprovedReason).toBe("dangerouslyAutoApprove");
    expect(execAudits[0]?.evidence?.exitCode).toBe(0);
    expect(typeof execAudits[0]?.evidence?.stdout).toBe("string");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("terminal_exec allowlist fast path stays separate and uses its matched pattern as the reason", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-dangerously-ws-"));
    // Flag is OFF; allowlist match should produce the existing
    // no-approval-row behavior with autoApprovedReason=<pattern>.
    const config = buildConfig(workspaceRoot, "dangerously-allowlist", {
      autoApproveCommands: ["echo *"]
    });
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_t", type: "function", function: { name: "terminal_exec", arguments: JSON.stringify({ command: "echo allowlist-hit" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Allowlist ran it.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "run echo via allowlist", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);

    expect(finished.status).toBe("completed");

    const state = readState(config.instance);
    // Allowlist path bypasses approval-row creation entirely.
    expect(state.approvals.filter((a) => a.taskId === task.id)).toHaveLength(0);

    // But the side-effect audit still records why the human gate was skipped.
    const execAudits = state.audit.filter((a) => a.action === "terminal.exec" && a.taskId === task.id);
    expect(execAudits).toHaveLength(1);
    expect(execAudits[0]?.evidence?.autoApprovedReason).toBe("echo *");
    expect(execAudits[0]?.evidence?.autoApproved).toBe(true);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("decideApproval still completes a paused task end-to-end (backward compat through resolveApproval)", async () => {
    // decideApproval now delegates to resolveApproval for the approve
    // case. This regression test ensures the existing human-driven flow
    // still: marks the approval approved, runs the side effect, and
    // resumes the chat-task loop to completion.
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-dangerously-ws-"));
    const config = buildConfig(workspaceRoot, "dangerously-decide");
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_w", type: "function", function: { name: "file_write", arguments: JSON.stringify({ path: "human.txt", content: "human" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Approved and wrote.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "write human.txt", { mode: "chat" });
    const paused = await waitForTerminal(config, task.id);
    expect(paused.status).toBe("waiting_approval");

    await decideApproval(config, paused.approvalIds[0]!, "approve");
    const finished = await waitForTerminal(config, task.id);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Approved and wrote.");
    expect(await Bun.file(join(workspaceRoot, "human.txt")).text()).toBe("human");

    const state = readState(config.instance);
    const approveAudits = state.audit.filter((a) => a.action === "approval.approved" && a.taskId === task.id);
    expect(approveAudits).toHaveLength(1);
    // Human path — actor must be "user" and there should be NO
    // autoApprovedReason marker (only the runtime path stamps it).
    expect(approveAudits[0]?.actor).toBe("user");
    expect(approveAudits[0]?.evidence?.autoApprovedReason).toBeUndefined();

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("resolveApproval returns the per-action result string the dispatcher relays back to the model", async () => {
    // Direct unit test of the new agent.resolveApproval helper. We build
    // an approval row by hand so the test doesn't depend on chat-task
    // routing, then call resolveApproval and assert both the returned
    // toolResult and the audit-row evidence stamping.
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-dangerously-ws-"));
    const config = buildConfig(workspaceRoot, "dangerously-resolve");

    const approval = await mutateState(config.instance, (state) =>
      createApproval(state, {
        action: "file.write",
        target: "direct.txt",
        risk: "high",
        reason: "Direct resolveApproval unit test.",
        payload: { path: "direct.txt", content: "direct" }
      })
    );

    const { approval: resolved, toolResult } = await resolveApproval(config, approval.id, {
      actor: "runtime",
      resumeChatTask: false,
      evidenceExtra: { autoApproved: true, autoApprovedReason: "test-marker" }
    });

    expect(resolved.status).toBe("approved");
    expect(toolResult).toBe("File write completed: direct.txt");
    expect(await Bun.file(join(workspaceRoot, "direct.txt")).text()).toBe("direct");

    const state = readState(config.instance);
    const writeAudits = state.audit.filter((a) => a.action === "file.write" && a.approvalId === approval.id);
    expect(writeAudits).toHaveLength(1);
    expect(writeAudits[0]?.evidence?.autoApprovedReason).toBe("test-marker");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });
});
