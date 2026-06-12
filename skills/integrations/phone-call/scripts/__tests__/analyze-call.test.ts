// Unit tests for the pure helper of the analyze-call script.
//
// Only the side-effect-free export is covered here: the POST
// /v1/calls/<id>/analyze body builder. No network — the imperative analyze
// flow is exercised end-to-end through a real chat turn, not here.

import { describe, expect, test } from "bun:test";
import { buildAnalyzeBody } from "../analyze-call";

describe("buildAnalyzeBody", () => {
  test("normalizes bare-string questions to [question, \"string\"] pairs", () => {
    expect(buildAnalyzeBody({ questions: ["Did they confirm the reservation?"] })).toEqual({
      questions: [["Did they confirm the reservation?", "string"]]
    });
  });

  test("passes [question, answerType] tuples through unchanged", () => {
    expect(
      buildAnalyzeBody({
        questions: [
          ["Did they confirm the reservation?", "boolean"],
          ["What time was booked?", "string"]
        ]
      })
    ).toEqual({
      questions: [
        ["Did they confirm the reservation?", "boolean"],
        ["What time was booked?", "string"]
      ]
    });
  });

  test("mixes bare strings and tuples in one questions array", () => {
    expect(
      buildAnalyzeBody({ questions: ["Who answered?", ["How many seats?", "number"]] })
    ).toEqual({
      questions: [
        ["Who answered?", "string"],
        ["How many seats?", "number"]
      ]
    });
  });

  test("omits goal when missing or blank", () => {
    expect("goal" in buildAnalyzeBody({ questions: ["Q?"] })).toBe(false);
    expect("goal" in buildAnalyzeBody({ goal: "   ", questions: ["Q?"] })).toBe(false);
  });

  test("includes goal when non-empty", () => {
    expect(buildAnalyzeBody({ goal: "Book a dinner reservation", questions: ["Q?"] })).toEqual({
      questions: [["Q?", "string"]],
      goal: "Book a dinner reservation"
    });
  });
});
