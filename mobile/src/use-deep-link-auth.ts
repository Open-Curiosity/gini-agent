import * as Linking from "expo-linking";
import { useEffect } from "react";
import { router } from "expo-router";
import { saveCredentials } from "@/src/auth";

// Handles `gini://connect?api=<base-url>&token=<bearer>` deep links by
// persisting the credentials and navigating into the app. The connect
// interstitial page on the web side constructs the URL; this hook
// consumes it.
//
// Triggered for both cold starts (app launched by tapping the deep link
// while not running) and warm hand-offs (app already running in
// background, then iOS routes the URL to it). `Linking.useURL()` covers
// both cases — it returns the launch URL on cold start, then updates
// whenever a new URL is dispatched to the app.

const CONNECT_PATH = "connect";

interface ParsedCredentials {
  baseUrl: string;
  token: string;
}

function parseConnectUrl(url: string | null): ParsedCredentials | null {
  if (!url) return null;
  const parsed = Linking.parse(url);
  // Expo's parser drops the `gini://` scheme; the host portion of
  // `gini://connect?api=...` lands in `hostname`, the rest in
  // `queryParams`. Some iOS handlers route as `gini://connect` (path
  // empty, hostname=connect), others as `gini:///connect`
  // (hostname empty, path=connect). Accept both shapes.
  const route = parsed.hostname ?? parsed.path?.replace(/^\//, "") ?? "";
  if (route !== CONNECT_PATH) return null;

  const apiParam = parsed.queryParams?.api;
  const tokenParam = parsed.queryParams?.token;
  const api = typeof apiParam === "string" ? apiParam : null;
  const token = typeof tokenParam === "string" ? tokenParam : null;
  if (!api || !token) return null;

  return { baseUrl: api, token };
}

export function useDeepLinkAuth(): void {
  // `useURL` returns the current launch URL on cold start AND subsequent
  // URLs delivered while the app is running.
  const url = Linking.useURL();

  useEffect(() => {
    let active = true;
    const creds = parseConnectUrl(url);
    if (!creds) return;
    // `saveCredentials` runs URL normalization and broadcasts to every
    // mounted `useAuth` listener — the auth gate in `app/index.tsx`
    // notices the new identity and the user lands on /agents on the
    // next render tick. We still call `router.replace` explicitly so a
    // user who tapped the deep link while sitting on /setup is moved
    // off it immediately instead of waiting for state propagation.
    saveCredentials(creds)
      .then(() => {
        if (!active) return;
        router.replace("/agents");
      })
      .catch(() => {
        // Saving can fail if the base URL fails normalization. The
        // setup screen is the right recovery surface — bounce the user
        // there so they can paste/correct by hand.
        if (!active) return;
        router.replace("/setup");
      });
    return () => {
      active = false;
    };
  }, [url]);
}

export const __test = { parseConnectUrl };
