import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetRedactionForTests,
  redact,
  setRedactionPublicUrl,
  setRedactionSecret
} from "./redact";

afterEach(() => __resetRedactionForTests());

describe("redact", () => {
  test("replaces the current secret", () => {
    setRedactionSecret("SECRETVALUE");
    expect(redact("Visit /SECRETVALUE/api/foo")).toBe("Visit /<redacted-secret>/api/foo");
  });

  test("replaces a prior secret within the rotation window", () => {
    setRedactionSecret("OLD");
    setRedactionSecret("NEW");
    expect(redact("OLD and NEW")).toBe("<redacted-secret> and <redacted-secret>");
  });

  test("replaces the public URL string", () => {
    setRedactionPublicUrl("https://abc.trycloudflare.com");
    expect(redact("URL=https://abc.trycloudflare.com")).toBe("URL=<redacted-secret>");
  });

  test("replaces trycloudflare.com hostname suffix", () => {
    expect(redact("dns: trycloudflare.com")).toBe("dns: <redacted-secret>");
  });

  test("leaves unrelated strings alone", () => {
    setRedactionSecret("ABC");
    expect(redact("no match here")).toBe("no match here");
  });

  test("idempotent setRedactionSecret is a no-op", () => {
    setRedactionSecret("X");
    setRedactionSecret("X");
    expect(redact("X")).toBe("<redacted-secret>");
  });
});
