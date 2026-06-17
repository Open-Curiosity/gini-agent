// Pin the zone before any Date is constructed so calendar-day bucketing is
// deterministic across machines AND so the DST test below actually crosses a
// transition (America/Los_Angeles springs forward Mar 8 2026). bun --isolate
// runs each test file in its own worker, so this doesn't leak to other files.
process.env.TZ = "America/Los_Angeles";

import { describe, expect, it } from "bun:test";
import type { Task } from "@runtime/types";
import { bucketTokensByDay, taskTokens } from "./observability";

// Minimal Task factory — only the fields the token helpers read. Everything
// else is filled with throwaway-but-valid values so the cast is honest.
function makeTask(over: Partial<Task> & { createdAt: string }): Task {
  return {
    id: "t",
    title: "t",
    input: "",
    status: "completed",
    updatedAt: over.createdAt,
    ...over
  } as Task;
}

describe("taskTokens", () => {
  it("reads input/output from the cost record", () => {
    const task = makeTask({
      createdAt: "2026-06-17T10:00:00Z",
      cost: { provider: "anthropic", model: "m", inputTokens: 1200, outputTokens: 340 }
    });
    expect(taskTokens(task)).toEqual({ input: 1200, output: 340 });
  });

  it("treats a missing cost record as zero", () => {
    const task = makeTask({ createdAt: "2026-06-17T10:00:00Z" });
    expect(taskTokens(task)).toEqual({ input: 0, output: 0 });
  });

  it("treats missing or non-finite fields as zero", () => {
    const task = makeTask({
      createdAt: "2026-06-17T10:00:00Z",
      cost: { provider: "anthropic", model: "m", inputTokens: 500, outputTokens: Number.NaN }
    });
    expect(taskTokens(task)).toEqual({ input: 500, output: 0 });
  });
});

describe("bucketTokensByDay", () => {
  // Fixed "now" at local noon so day-boundary math never lands on midnight.
  const now = new Date(2026, 5, 17, 12, 0, 0).getTime(); // Jun 17 2026, local

  function localDaysAgoAt(days: number, hour: number): string {
    const d = new Date(now);
    d.setDate(d.getDate() - days);
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  }

  it("returns `days` buckets oldest-first ending today", () => {
    const buckets = bucketTokensByDay([], 14, now);
    expect(buckets).toHaveLength(14);
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    expect(buckets[13].dayStart).toBe(todayStart.getTime());
    // Strictly increasing day starts.
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i].dayStart).toBeGreaterThan(buckets[i - 1].dayStart);
    }
  });

  it("attributes tokens to the calendar day of createdAt", () => {
    const tasks = [
      makeTask({
        createdAt: localDaysAgoAt(0, 9),
        cost: { provider: "p", model: "m", inputTokens: 100, outputTokens: 10 }
      }),
      makeTask({
        createdAt: localDaysAgoAt(0, 18),
        cost: { provider: "p", model: "m", inputTokens: 50, outputTokens: 5 }
      }),
      makeTask({
        createdAt: localDaysAgoAt(2, 12),
        cost: { provider: "p", model: "m", inputTokens: 200, outputTokens: 20 }
      })
    ];
    const buckets = bucketTokensByDay(tasks, 14, now);
    // Two tasks on today (last bucket) accumulate.
    expect(buckets[13]).toMatchObject({ input: 150, output: 15 });
    // One task two days ago → bucket index 11.
    expect(buckets[11]).toMatchObject({ input: 200, output: 20 });
    // An untouched day stays zero.
    expect(buckets[12]).toMatchObject({ input: 0, output: 0 });
  });

  it("drops tasks outside the window and unparseable timestamps", () => {
    const tasks = [
      makeTask({
        createdAt: localDaysAgoAt(30, 12),
        cost: { provider: "p", model: "m", inputTokens: 999, outputTokens: 999 }
      }),
      makeTask({
        createdAt: "not-a-date",
        cost: { provider: "p", model: "m", inputTokens: 999, outputTokens: 999 }
      })
    ];
    const buckets = bucketTokensByDay(tasks, 14, now);
    expect(buckets.reduce((s, b) => s + b.input + b.output, 0)).toBe(0);
  });

  it("contributes zero for tasks without a cost record", () => {
    const buckets = bucketTokensByDay([makeTask({ createdAt: localDaysAgoAt(0, 9) })], 7, now);
    expect(buckets[6]).toMatchObject({ input: 0, output: 0 });
  });

  it("attributes correctly across a DST spring-forward (the Math.round defense)", () => {
    // America/Los_Angeles springs forward 2026-03-08 02:00. Viewed from
    // Mar 12 noon, a task created Mar 7 (pre-transition) is 5 calendar days
    // back, but only ~4.96 * 24h of wall-clock — the gap a naive Math.floor
    // would misattribute to Mar 8 (4 days back). With a 14-day window: Mar 12
    // is index 13, so Mar 7 must land in index 13 - 5 = 8, NOT 9.
    const mar12noon = new Date(2026, 2, 12, 12, 0, 0).getTime();
    const mar7 = new Date(2026, 2, 7, 9, 0, 0).toISOString();
    const buckets = bucketTokensByDay(
      [makeTask({ createdAt: mar7, cost: { provider: "p", model: "m", inputTokens: 70, outputTokens: 7 } })],
      14,
      mar12noon
    );
    expect(buckets[8]).toMatchObject({ input: 70, output: 7 });
    expect(buckets[9]).toMatchObject({ input: 0, output: 0 });
    // The bucket day-start must be a true local midnight (built via setDate),
    // not an hour off because of the DST shift.
    expect(new Date(buckets[8].dayStart).getHours()).toBe(0);
  });

  it("attributes correctly across a month boundary", () => {
    const apr2noon = new Date(2026, 3, 2, 12, 0, 0).getTime();
    const mar31 = new Date(2026, 2, 31, 9, 0, 0).toISOString();
    const buckets = bucketTokensByDay(
      [makeTask({ createdAt: mar31, cost: { provider: "p", model: "m", inputTokens: 5, outputTokens: 1 } })],
      7,
      apr2noon
    );
    // Apr 2 is index 6; Mar 31 is 2 days back → index 4.
    expect(buckets[4]).toMatchObject({ input: 5, output: 1 });
    expect(new Date(buckets[6].dayStart).getDate()).toBe(2);
    expect(new Date(buckets[4].dayStart).getDate()).toBe(31);
  });
});
