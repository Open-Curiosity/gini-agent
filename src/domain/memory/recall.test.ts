// Hindsight phase 3 — recall pipeline tests.
//
// We seed the SQLite memory store with hand-crafted units (bypassing retain
// where convenient) so each channel can be exercised in isolation, then
// exercise full RRF fusion + token budget.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  closeAllMemoryDbs,
  ensureDefaultBank,
  insertEntity,
  insertLink,
  insertMemoryUnit,
  linkUnitToEntity,
  DEFAULT_BANK_ID
} from "../../state";
import { recall } from "./recall";
import { echoEmbed } from "../../embeddings";
import type { RuntimeConfig } from "../../types";

const ROOT = "/tmp/gini-recall-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
  process.env.GINI_EMBEDDING_PROVIDER = "echo";
});

afterAll(() => {
  closeAllMemoryDbs();
  delete process.env.GINI_EMBEDDING_PROVIDER;
  rmSync(ROOT, { recursive: true, force: true });
});

function makeConfig(lane: string): RuntimeConfig {
  return {
    lane,
    port: 0,
    token: "test",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: ROOT,
    stateRoot: ROOT,
    logRoot: `${ROOT}-logs`
  };
}

describe("recall — semantic channel", () => {
  test("returns the unit closest to the query embedding first", async () => {
    const lane = "recall-semantic";
    ensureDefaultBank(lane);
    const target = insertMemoryUnit(lane, {
      text: "alpha bravo charlie delta echo",
      embedding: echoEmbed("alpha bravo charlie delta echo"),
      embeddingModel: "echo-embed-v0",
      network: "world"
    });
    insertMemoryUnit(lane, {
      text: "completely unrelated topic about gardens and hedges",
      embedding: echoEmbed("completely unrelated topic about gardens and hedges"),
      embeddingModel: "echo-embed-v0",
      network: "world"
    });
    const result = await recall(makeConfig(lane), { query: "alpha bravo charlie delta echo" });
    expect(result.units.length).toBeGreaterThan(0);
    expect(result.units[0]!.unit.id).toBe(target.id);
    expect(result.units[0]!.channels).toContain("semantic");
  });
});

describe("recall — bm25 channel", () => {
  test("surfaces a lexical match when semantic similarity is weaker", async () => {
    const lane = "recall-bm25";
    ensureDefaultBank(lane);
    // Distinct lexical word that exists in only one unit.
    const target = insertMemoryUnit(lane, {
      text: "the quokka is a small marsupial",
      embedding: echoEmbed("the quokka is a small marsupial"),
      embeddingModel: "echo-embed-v0",
      network: "world"
    });
    insertMemoryUnit(lane, {
      text: "office supplies inventory list",
      embedding: echoEmbed("office supplies inventory list"),
      embeddingModel: "echo-embed-v0",
      network: "world"
    });
    const result = await recall(makeConfig(lane), { query: "quokka" });
    const hit = result.units.find((entry) => entry.unit.id === target.id);
    expect(hit).toBeDefined();
    expect(hit!.channels).toContain("bm25");
  });
});

describe("recall — graph channel", () => {
  test("surfaces an indirectly connected unit via entity link", async () => {
    const lane = "recall-graph";
    ensureDefaultBank(lane);
    const seed = insertMemoryUnit(lane, {
      text: "Alice joined the company",
      embedding: echoEmbed("Alice joined the company"),
      embeddingModel: "echo-embed-v0",
      network: "world"
    });
    const linked = insertMemoryUnit(lane, {
      text: "Alice gave a talk at the all-hands",
      embedding: echoEmbed("xyzzy plover something completely different"), // make semantic miss
      embeddingModel: "echo-embed-v0",
      network: "world"
    });
    // override embedding so the semantic channel won't surface it directly.
    const entity = insertEntity(lane, { canonicalName: "Alice", entityType: "PERSON" });
    linkUnitToEntity(lane, seed.id, entity.id, "Alice");
    linkUnitToEntity(lane, linked.id, entity.id, "Alice");
    insertLink(lane, { fromUnit: seed.id, toUnit: linked.id, linkType: "entity", weight: 1.0, entityId: entity.id });
    insertLink(lane, { fromUnit: linked.id, toUnit: seed.id, linkType: "entity", weight: 1.0, entityId: entity.id });

    const result = await recall(makeConfig(lane), { query: "Alice joined the company" });
    const hit = result.units.find((entry) => entry.unit.id === linked.id);
    expect(hit).toBeDefined();
    expect(hit!.channels).toContain("graph");
  });
});

describe("recall — temporal channel", () => {
  test("matches units within the query date range", async () => {
    const lane = "recall-temporal";
    ensureDefaultBank(lane);
    insertMemoryUnit(lane, {
      text: "happened in april",
      embedding: echoEmbed("happened in april"),
      embeddingModel: "echo-embed-v0",
      network: "world",
      occurredStart: "2025-04-10T00:00:00Z",
      occurredEnd: "2025-04-10T23:59:59Z"
    });
    insertMemoryUnit(lane, {
      text: "happened way later",
      embedding: echoEmbed("happened way later"),
      embeddingModel: "echo-embed-v0",
      network: "world",
      occurredStart: "2025-09-01T00:00:00Z",
      occurredEnd: "2025-09-01T23:59:59Z"
    });
    const result = await recall(makeConfig(lane), {
      query: "what happened on 2025-04-10",
      reference: "2025-12-01T00:00:00Z"
    });
    const hits = result.units.filter((entry) => entry.channels.includes("temporal"));
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.unit.text).toContain("april");
  });

  test("returns nothing temporal when the query has no temporal expression", async () => {
    const lane = "recall-temporal-empty";
    ensureDefaultBank(lane);
    insertMemoryUnit(lane, {
      text: "neutral fact",
      embedding: echoEmbed("neutral fact"),
      embeddingModel: "echo-embed-v0",
      network: "world",
      occurredStart: "2025-04-10T00:00:00Z",
      occurredEnd: "2025-04-10T23:59:59Z"
    });
    const result = await recall(makeConfig(lane), { query: "tell me everything you know" });
    const temporal = result.units.filter((entry) => entry.channels.includes("temporal"));
    expect(temporal.length).toBe(0);
  });
});

describe("recall — RRF fusion + token budget", () => {
  test("a unit appearing in multiple channels ranks higher than one in a single channel", async () => {
    const lane = "recall-fusion";
    ensureDefaultBank(lane);
    // Multi-channel hit: lexical match on "elephant" AND embedding close to query.
    const multi = insertMemoryUnit(lane, {
      text: "elephant elephant elephant matters here",
      embedding: echoEmbed("elephant elephant elephant matters here"),
      embeddingModel: "echo-embed-v0",
      network: "world"
    });
    // Single-channel hit: only the embedding has overlap.
    const single = insertMemoryUnit(lane, {
      text: "matters here truly",
      embedding: echoEmbed("matters here truly"),
      embeddingModel: "echo-embed-v0",
      network: "world"
    });
    const result = await recall(makeConfig(lane), { query: "elephant matters here" });
    const multiPos = result.units.findIndex((entry) => entry.unit.id === multi.id);
    const singlePos = result.units.findIndex((entry) => entry.unit.id === single.id);
    expect(multiPos).toBeGreaterThanOrEqual(0);
    expect(singlePos).toBeGreaterThanOrEqual(0);
    expect(multiPos).toBeLessThan(singlePos);
  });

  test("token budget caps the packed unit list", async () => {
    const lane = "recall-budget";
    ensureDefaultBank(lane);
    // Insert ten 200-character units; budget = 100 tokens (~400 chars) packs ~2.
    const text = "padding ".repeat(25); // ~200 chars
    for (let i = 0; i < 10; i++) {
      insertMemoryUnit(lane, {
        text: `${text} unique-token-${i}`,
        embedding: echoEmbed(`${text} unique-token-${i}`),
        embeddingModel: "echo-embed-v0",
        network: "world"
      });
    }
    const result = await recall(makeConfig(lane), { query: "padding", tokenBudget: 100 });
    expect(result.totalTokens).toBeLessThanOrEqual(100);
    expect(result.units.length).toBeLessThan(10);
  });
});
