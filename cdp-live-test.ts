// Live check: does playwright-core 1.61.1 (patched) complete a CDP websocket
// handshake under Bun? Without the bundled-ws->built-in-ws patch this deadlocks.
import { chromium } from "playwright-core";

const port = 9333;
const server = await chromium.launchServer({
  headless: true,
  args: [`--remote-debugging-port=${port}`],
});
const wsEndpoint = server.wsEndpoint();
console.log("launched, wsEndpoint:", wsEndpoint);

// Derive the browser-level CDP http endpoint and fetch the ws url, then attach.
const res = await fetch(`http://127.0.0.1:${port}/json/version`);
const info = await res.json();
const cdpWs = info.webSocketDebuggerUrl as string;
console.log("cdp ws url:", cdpWs);

const t0 = Bun.nanoseconds();
const browser = await chromium.connectOverCDP(cdpWs);
const elapsedMs = (Bun.nanoseconds() - t0) / 1e6;
console.log("connectOverCDP RESOLVED in", elapsedMs.toFixed(1), "ms");

const ctx = browser.contexts()[0] ?? (await browser.newContext());
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto("data:text/html,<title>patchcheck</title><h1>ok</h1>");
const title = await page.title();
console.log("page title:", title);

await browser.close();
await server.close();
console.log("RESULT: PASS — CDP handshake completed under Bun, no deadlock");
