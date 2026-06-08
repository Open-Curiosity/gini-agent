// Pins the /setup/provider auth-mode payload shared by the Add and Edit
// provider forms. Imports the pure providerAuth helper directly — NOT the
// dialog/page components — so their UI imports aren't pulled into the
// component coverage gate by this logic test.

import { describe, expect, test } from "bun:test";
import { authPayloadFields, providerAuthLabel } from "./providerAuth";

describe("authPayloadFields", () => {
  test("anthropic bearer sends an explicit authMode so it can downgrade a SigV4 provider", () => {
    expect(authPayloadFields(true, "bearer", "us-east-1")).toEqual({ authMode: "bearer" });
  });

  test("a non-anthropic provider never sends auth fields, even if authMode is somehow SigV4", () => {
    expect(authPayloadFields(false, "aws-sigv4", "us-east-1")).toEqual({});
    expect(authPayloadFields(false, "bearer", "")).toEqual({});
  });

  test("SigV4 sends authMode plus the region when one is provided", () => {
    expect(authPayloadFields(true, "aws-sigv4", "us-east-1")).toEqual({
      authMode: "aws-sigv4",
      awsRegion: "us-east-1"
    });
  });

  test("SigV4 trims the region before sending it", () => {
    expect(authPayloadFields(true, "aws-sigv4", "  eu-west-1  ")).toEqual({
      authMode: "aws-sigv4",
      awsRegion: "eu-west-1"
    });
  });

  test("SigV4 omits a blank/whitespace region so the host infers it from the Bedrock Base URL", () => {
    expect(authPayloadFields(true, "aws-sigv4", "   ")).toEqual({ authMode: "aws-sigv4" });
    expect(authPayloadFields(true, "aws-sigv4", "")).toEqual({ authMode: "aws-sigv4" });
  });
});

describe("providerAuthLabel", () => {
  test("SigV4 mode retitles the chip to 'AWS SigV4'", () => {
    expect(providerAuthLabel("aws-sigv4", "API key")).toBe("AWS SigV4");
  });

  test("a missing authMode (unknown/non-active row) keeps the static fallback", () => {
    expect(providerAuthLabel(undefined, "API key")).toBe("API key");
    expect(providerAuthLabel(undefined, "OAuth")).toBe("OAuth");
  });

  test("an explicit bearer mode keeps the static fallback", () => {
    expect(providerAuthLabel("bearer", "API key")).toBe("API key");
  });
});
