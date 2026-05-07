import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Lane, TraceRecord } from "../types";
import { ensureDir, logDir, traceDir } from "../paths";
import { id, now } from "./ids";

export function tracePath(lane: Lane, taskId: string): string {
  return join(traceDir(lane), `${taskId}.jsonl`);
}

export function appendTrace(
  lane: Lane,
  taskId: string,
  record: Omit<TraceRecord, "id" | "taskId" | "lane" | "at">
): TraceRecord {
  ensureDir(traceDir(lane));
  const trace: TraceRecord = {
    id: id("trace"),
    taskId,
    lane,
    at: now(),
    ...record
  };
  const path = tracePath(lane, taskId);
  const line = `${JSON.stringify(trace)}\n`;
  writeFileSync(path, line, { flag: "a" });
  return trace;
}

export function readTrace(lane: Lane, taskId: string): TraceRecord[] {
  const path = tracePath(lane, taskId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TraceRecord);
}

export function appendLog(lane: Lane, message: string, data?: Record<string, unknown>): void {
  ensureDir(logDir(lane));
  writeFileSync(
    join(logDir(lane), "runtime.jsonl"),
    `${JSON.stringify({ at: now(), lane, message, data })}\n`,
    { flag: "a" }
  );
}
