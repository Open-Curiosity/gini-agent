// Shared logic for the anthropic auth-mode fields on a /setup/provider POST,
// used by both the Add and Edit provider forms so the payload shape is defined
// once. The Add/Edit forms own the chosen mode, so anthropic always sends an
// explicit authMode: "bearer" downgrades a SigV4 provider back to a key, and
// "aws-sigv4" upgrades it. SigV4 also sends the region when supplied (a blank
// region is inferred from the Bedrock Base URL host). The backend's "preserve
// the current mode when authMode is absent" path is reserved for callers that
// don't touch auth at all — e.g. the Settings set-active radio, which posts
// only {provider, model}.
export function authPayloadFields(
  isAnthropic: boolean,
  authMode: "bearer" | "aws-sigv4",
  awsRegion: string
): Record<string, string> {
  if (!isAnthropic) return {};
  if (authMode !== "aws-sigv4") return { authMode: "bearer" };
  const region = awsRegion.trim();
  return { authMode: "aws-sigv4", ...(region ? { awsRegion: region } : {}) };
}

// The auth-method chip shown on a provider row. SigV4 mode reads "AWS SigV4";
// every other mode (including a missing/bearer one) keeps the provider's
// static fallback label (e.g. "API key", "OAuth", "Local"). Only the active
// provider has a persisted authMode, so callers pass undefined for rows whose
// mode isn't known.
export function providerAuthLabel(authMode: string | undefined, fallback: string): string {
  return authMode === "aws-sigv4" ? "AWS SigV4" : fallback;
}
