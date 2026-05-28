// iOS deep-link interstitial. The page is reached at
//   https://<web-host>/connect?api=<runtime-url>&web=<web-url>
// and tries to hand off to a custom URL scheme (default `gini://connect`).
// If iOS doesn't route the scheme to an installed app within `fallbackMs`,
// the script navigates to the supplied `web` URL.
//
// The redirect-or-fallback signal uses `document.visibilitychange`: when iOS
// switches to the app, the Safari tab is backgrounded and `document.hidden`
// flips to true. That is the only reliable cross-version way to detect a
// successful scheme handoff from a web page.

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ConnectClient } from "./ConnectClient";
import {
  DEFAULT_FALLBACK_MS,
  DEFAULT_SCHEME,
  clampMs,
  singleParam,
  userAgentLooksMobile,
  validateHttpUrl,
  validateScheme,
  validateToken,
} from "./validators";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function ConnectPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const apiUrl = validateHttpUrl(singleParam(params.api));
  const webUrl = validateHttpUrl(singleParam(params.web));
  const token = validateToken(singleParam(params.token));
  const scheme = validateScheme(singleParam(params.scheme), DEFAULT_SCHEME);
  const fallbackMs = clampMs(singleParam(params.ms), DEFAULT_FALLBACK_MS);

  if (webUrl) {
    const requestHeaders = await headers();
    const ua = requestHeaders.get("user-agent");
    if (!userAgentLooksMobile(ua)) {
      // Desktop / unknown UA — the deep-link can't succeed, so skip the
      // interstitial and ship straight to the web app. `redirect()`
      // throws past the rest of the render, so nothing else executes.
      redirect(webUrl);
    }
  }

  if (!apiUrl || !webUrl) {
    return (
      <div className="mx-auto max-w-md p-6 text-sm">
        <h1 className="mb-3 text-base font-semibold">Gini connect</h1>
        <p className="text-muted-foreground">Missing required params.</p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-muted-foreground">
          <li>
            <code className="font-mono text-xs">?api=&lt;runtime URL&gt;</code> — the runtime gateway (e.g. the 7778 ngrok)
          </li>
          <li>
            <code className="font-mono text-xs">&amp;web=&lt;web URL&gt;</code> — the browser fallback (e.g. the 7777 ngrok)
          </li>
        </ul>
        <p className="mt-3 text-muted-foreground">
          Optional:{" "}
          <code className="font-mono text-xs">scheme=gini://connect</code>,{" "}
          <code className="font-mono text-xs">ms=1500</code>.
        </p>
      </div>
    );
  }

  const sep = scheme.includes("?") ? "&" : "?";
  const tokenSuffix = token ? `&token=${encodeURIComponent(token)}` : "";
  const schemeUrl = `${scheme}${sep}api=${encodeURIComponent(apiUrl)}${tokenSuffix}`;

  return (
    <div className="mx-auto max-w-md p-6 text-sm">
      <p>Opening Gini…</p>
      <noscript>
        <p className="mt-3">
          JavaScript is required to deep-link into the app.{" "}
          <a className="underline" href={webUrl}>
            Continue to the web app
          </a>
          .
        </p>
      </noscript>
      <ConnectClient schemeUrl={schemeUrl} webUrl={webUrl} fallbackMs={fallbackMs} />
    </div>
  );
}
