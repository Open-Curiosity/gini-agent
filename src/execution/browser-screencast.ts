// Sign-in screencast bridge. When a chat task hits a login wall it calls
// browser_connect, which (after the user approves the standard "Connect to
// agent's browser" card) needs to show the user the live headless page so they
// can sign in. This bridge attaches a SCREENCAST to the agent's
// already-running spawned Chrome and relays the user's mouse/keyboard back.
//
// Transport: a single RAW CDP WebSocket to the spawned Chrome's debug port
// (Page.startScreencast → screencastFrame → ack), exactly the technique the
// standalone control panel uses. Raw CDP is used — NOT playwright
// connectOverCDP — because connectOverCDP hangs on the WebSocket handshake
// under playwright-core 1.60 + Bun, whereas a raw WebSocket to the same debug
// endpoint works. The agent's automation keeps driving the SAME Chrome over
// its pipe transport; this screencast is a SEPARATE read/drive channel on the
// same process, so the two never conflict.
//
// Security: the bridge dials ONLY a loopback debug port supplied by the
// browser manager (getScreencastPort → the spawned handle's port, always
// ≥ DEFAULT_CDP_PORT_BASE). It never accepts a port/URL from the client, so it
// can't be pointed at the user's personal :9222 or any other endpoint. Frames
// are raw JPEGs of the live page (they can show a typed password mid-sign-in),
// so they only ever travel over the bearer-gated gateway→BFF channel to the
// authenticated operator — never persisted, never sent to the model.
import { getScreencastPort } from "../tools/browser";

// CDP modifier bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8. macOS Command maps to
// Meta so page-level Cmd shortcuts fire.
const CTRL_OR_META = 0b0110;

// Upper bound on the Page.stopScreencast teardown send, so a wedged CDP socket
// can't hang the /complete or /cancel HTTP response.
const STOP_SCREENCAST_TIMEOUT_MS = 2_000;

// How often the bridge re-polls /json to follow a popup / new-tab sign-in. The
// watch interval is unref'd so it never holds the process open.
const TARGET_WATCH_INTERVAL_MS = 700;

// The input events the modal can send. Deliberately does NOT include page
// navigation: the modal is for signing in on the page the agent already
// reached, and a free URL bar would bypass the agent's SSRF / domain-policy
// gate (which lives on browser_navigate). Sign-in links are followed by
// clicking them on the page, which Chrome routes normally.
export type ScreencastInput =
  | { kind: "click"; x: number; y: number; clickCount?: number; modifiers?: number }
  | { kind: "move"; x: number; y: number; modifiers?: number }
  | { kind: "scroll"; x: number; y: number; dx: number; dy: number; modifiers?: number }
  | { kind: "dragselect"; x0: number; y0: number; x1: number; y1: number; modifiers?: number }
  | { kind: "key"; text?: string; key?: string; code?: string; vk?: number; modifiers?: number };

export interface CdpVersionTarget {
  id?: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

interface ScreencastFrame {
  // base64 JPEG, ready to drop into a data: URL.
  data: string;
  // CDP screencast frame metadata (deviceWidth/deviceHeight/etc.) for scaling.
  meta: Record<string, unknown>;
}

// Injection seam for tests: the raw WebSocket constructor and the /json fetch.
export interface ScreencastDeps {
  openSocket: (wsUrl: string) => WebSocketLike;
  fetchJson: (url: string) => Promise<CdpVersionTarget[]>;
  // Resolves the spawned Chrome's debug port (production: getScreencastPort).
  resolvePort: () => number | null;
}

// The minimal WebSocket surface we use, so a test can inject a fake.
export interface WebSocketLike {
  addEventListener(event: "open" | "message" | "close" | "error", listener: (ev: { data?: unknown }) => void): void;
  send(data: string): void;
  close(): void;
}

// Production externalities. Exported so a test can exercise the real
// openSocket / fetchJson wiring without standing up a Chrome.
export function defaultDeps(): ScreencastDeps {
  return {
    openSocket: (wsUrl) => new WebSocket(wsUrl) as unknown as WebSocketLike,
    fetchJson: async (url) => (await (await fetch(url)).json()) as CdpVersionTarget[],
    resolvePort: getScreencastPort
  };
}

// One live screencast attachment to the spawned Chrome's first page target.
// Holds the raw CDP socket, the latest frame, and a set of frame subscribers
// (the SSE responses). Translates ScreencastInput into CDP Input.* calls.
export class ScreencastBridge {
  private cdp: WebSocketLike | undefined;
  private cdpId = 0;
  private readonly pending = new Map<number, (v: unknown) => void>();
  private latest: ScreencastFrame | undefined;
  private readonly subscribers = new Set<(frame: ScreencastFrame) => void>();
  private readonly deps: ScreencastDeps;
  private closed = false;
  // How long stop() waits for Page.stopScreencast before forcing the socket
  // shut. Bounded so a wedged CDP socket can't hang the /complete or /cancel
  // HTTP response (those await stopActiveBridge → stop()). Test-injectable.
  private readonly stopTimeoutMs: number;
  // Target-follow state (popup / new-tab sign-in support).
  private currentWsUrl: string | undefined;
  private knownTargetIds = new Set<string>();
  private targetWatch: ReturnType<typeof setInterval> | undefined;
  // True for the whole switchTo window: suppresses the dropped socket's close
  // handler from tearing the whole bridge down, and pauses the watcher.
  private switching = false;
  private readonly targetWatchMs: number;

  constructor(
    deps: Partial<ScreencastDeps> = {},
    stopTimeoutMs = STOP_SCREENCAST_TIMEOUT_MS,
    targetWatchMs = TARGET_WATCH_INTERVAL_MS
  ) {
    this.deps = { ...defaultDeps(), ...deps };
    this.stopTimeoutMs = stopTimeoutMs;
    this.targetWatchMs = targetWatchMs;
  }

  // Open the raw CDP socket to the spawned Chrome's first page target and start
  // the screencast. Throws when no spawned Chrome is live (the caller surfaces
  // that as "the agent's browser isn't running").
  // `preferUrl` is the URL of the page the requesting task is actually on
  // (from peekCurrentBrowserUrl). Because the spawned Chrome is a single
  // shared context that can hold several page targets (other tasks, agent-
  // opened tabs), we attach to the target whose URL matches the requesting
  // task rather than blindly taking the first page — otherwise the operator
  // could sign in on the wrong tab. Falls back to the first page target when
  // no preferred URL is given or none matches.
  async start(preferUrl?: string): Promise<void> {
    const port = this.deps.resolvePort();
    if (port === null) {
      throw new Error("No spawned browser is running to screencast.");
    }
    const targets = await this.deps.fetchJson(`http://127.0.0.1:${port}/json`);
    const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
    const pageTarget =
      (preferUrl ? pages.find((t) => t.url === preferUrl) : undefined) ?? pages[0];
    if (!pageTarget?.webSocketDebuggerUrl) {
      throw new Error("No page target available on the spawned browser.");
    }
    // Remember the page targets present at attach time so the watcher can
    // recognize a NEW one (a popup the sign-in flow opens) as it appears.
    this.knownTargetIds = new Set(pages.map((p) => p.id).filter((id): id is string => typeof id === "string"));
    await this.attachTo(pageTarget.webSocketDebuggerUrl);
    // Follow popup / new-tab sign-in: many OAuth flows open a popup window
    // (a new page target) the user must complete in. Poll the target list and
    // re-point the screencast to a freshly-opened page, falling back to the
    // remaining page when it closes. Same-tab redirect sign-in needs no switch
    // (the screencast follows the page target through its own navigations).
    this.startTargetWatch(port);
  }

  // Open a raw CDP socket to one page target's wsUrl and start its screencast.
  // The returned promise ALWAYS settles: it resolves once the screencast starts,
  // and rejects if the socket closes/errors before that. Both start() (the
  // initial attach) and switchTo() (a target swap) await it, so neither can hang
  // on a target that dies mid-attach — a rejected switch is caught and leaves
  // the prior frame. A reject after a post-open resolve is a no-op, so this also
  // stays correct for steady-state teardown.
  private attachTo(wsUrl: string): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const socket = this.deps.openSocket(wsUrl);
    this.cdp = socket;
    this.currentWsUrl = wsUrl;
    socket.addEventListener("open", () => {
      void (async () => {
        try {
          await this.send("Page.enable");
          // A backgrounded headless tab is throttled and won't paint, so bring
          // it to the foreground before starting the screencast or the stream
          // yields zero frames.
          await this.send("Page.bringToFront");
          await this.send("Page.startScreencast", {
            format: "jpeg",
            quality: 70,
            maxWidth: 1280,
            maxHeight: 800,
            everyNthFrame: 1
          });
          resolve();
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });
    socket.addEventListener("message", (ev) => this.onCdpMessage(ev.data));
    // A close/error BEFORE open (Chrome died mid-attach, the page target
    // vanished, the handshake dropped) must settle this promise unconditionally,
    // or the awaiting caller (start() or switchTo()) hangs forever.
    socket.addEventListener("close", () => {
      reject(new Error("CDP socket closed before the screencast started."));
      // A deliberate switch closes the old socket and may attach a new one that
      // dies mid-handshake — neither should tear the whole bridge down (the
      // watcher falls back on its next tick). Only an unexpected drop of the
      // live socket outside a swap does. A stale socket (already replaced) is
      // likewise ignored.
      if (this.switching || socket !== this.cdp) return;
      this.handleClosed();
    });
    socket.addEventListener("error", () => {
      reject(new Error("CDP socket errored before the screencast started."));
      if (this.switching || socket !== this.cdp) return;
      this.handleClosed();
    });
    return promise;
  }

  // Poll /json and switch the screencast to a popup/new tab when one appears,
  // or back to a remaining page when the watched one closes. Best-effort; the
  // interval is unref'd so it never holds the process open.
  private startTargetWatch(port: number): void {
    this.targetWatch = setInterval(() => {
      void (async () => {
        if (this.closed || this.switching) return;
        let pages: CdpVersionTarget[];
        try {
          const targets = await this.deps.fetchJson(`http://127.0.0.1:${port}/json`);
          pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
        } catch {
          return; // transient; try again next tick
        }
        const current = pages.find((p) => p.webSocketDebuggerUrl === this.currentWsUrl);
        // A brand-new page target (not seen at attach and not the current one)
        // is a popup the sign-in opened — switch the screencast to it.
        const fresh = pages.find(
          (p) => typeof p.id === "string" && !this.knownTargetIds.has(p.id) && p.webSocketDebuggerUrl !== this.currentWsUrl
        );
        if (fresh?.webSocketDebuggerUrl) {
          if (typeof fresh.id === "string") this.knownTargetIds.add(fresh.id);
          await this.switchTo(fresh.webSocketDebuggerUrl);
          return;
        }
        // The watched page closed (popup dismissed / tab gone) — fall back to
        // whatever page remains so the operator isn't left on a dead frame.
        if (!current && pages[0]?.webSocketDebuggerUrl) {
          await this.switchTo(pages[0].webSocketDebuggerUrl);
        }
      })();
    }, this.targetWatchMs);
    if (typeof this.targetWatch.unref === "function") this.targetWatch.unref();
  }

  // Re-point the live screencast to a different page target: drop the current
  // socket (without tearing the whole bridge down) and attach to the new one.
  private async switchTo(wsUrl: string): Promise<void> {
    if (this.closed || wsUrl === this.currentWsUrl) return;
    this.switching = true;
    try {
      const old = this.cdp;
      this.cdp = undefined;
      // The old socket's close handler is bypassed during a deliberate switch,
      // so it never drains this.pending. Resolve any in-flight send awaiting the
      // old socket now (its reply can never arrive on the new session) — mirrors
      // handleClosed's resolve(undefined) so a dispatchInput await can't hang.
      for (const resolve of this.pending.values()) resolve(undefined);
      this.pending.clear();
      // The old socket's close handler is suppressed for the whole swap window
      // (this.switching stays true, and this.cdp is already nulled), so closing
      // it can't tear the bridge down.
      try {
        old?.close();
      } catch {
        // ignore
      }
      // A new target that dies mid-attach rejects here; swallow it so switching
      // always clears and the next watch tick can fall back to a live page. Null
      // the dead socket so send() short-circuits until that fallback re-attaches.
      await this.attachTo(wsUrl).catch(() => {
        if (this.currentWsUrl === wsUrl) this.cdp = undefined;
      });
    } finally {
      this.switching = false;
    }
  }

  private onCdpMessage(raw: unknown): void {
    let msg: { id?: number; method?: string; result?: unknown; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      this.pending.get(msg.id)!(msg.result);
      this.pending.delete(msg.id);
      return;
    }
    if (msg.method === "Page.screencastFrame" && msg.params) {
      const sessionId = msg.params["sessionId"];
      // Ack immediately so Chrome keeps streaming.
      void this.send("Page.screencastFrameAck", { sessionId });
      const frame: ScreencastFrame = {
        data: String(msg.params["data"] ?? ""),
        meta: (msg.params["metadata"] as Record<string, unknown>) ?? {}
      };
      this.latest = frame;
      for (const fn of this.subscribers) {
        try {
          fn(frame);
        } catch {
          // a slow/broken subscriber must not break the others
        }
      }
    }
  }

  private handleClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.cdp = undefined;
    if (this.targetWatch) {
      clearInterval(this.targetWatch);
      this.targetWatch = undefined;
    }
    this.subscribers.clear();
    for (const resolve of this.pending.values()) resolve(undefined);
    this.pending.clear();
  }

  // Fire-and-await a CDP method over the raw socket.
  private send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.cdp) return Promise.resolve(undefined);
    const { promise, resolve } = Promise.withResolvers<unknown>();
    const id = ++this.cdpId;
    this.pending.set(id, resolve);
    this.cdp.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  // Subscribe to frames. Immediately replays the latest frame (if any) so a
  // newly-connected viewer paints without waiting for the next page change,
  // then streams subsequent frames. Returns an unsubscribe fn.
  subscribe(onFrame: (frame: ScreencastFrame) => void): () => void {
    this.subscribers.add(onFrame);
    if (this.latest) {
      try {
        onFrame(this.latest);
      } catch {
        // ignore
      }
    }
    return () => this.subscribers.delete(onFrame);
  }

  // Translate one modal input event into CDP Input.* calls. Mirrors the proven
  // control-panel mapping: printable chars with no Ctrl/Meta go through as
  // typed text; everything else (Enter/Tab/Backspace/arrows and any Cmd+<key>)
  // is a real key event carrying the modifier bitmask so page shortcuts fire.
  async dispatchInput(m: ScreencastInput): Promise<void> {
    const mods = m.modifiers ?? 0;
    switch (m.kind) {
      case "click": {
        const clickCount = m.clickCount ?? 1;
        await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: m.x, y: m.y, button: "left", clickCount, modifiers: mods });
        await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: m.x, y: m.y, button: "left", clickCount, modifiers: mods });
        break;
      }
      case "move":
        await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: m.x, y: m.y, modifiers: mods });
        break;
      case "scroll":
        await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: m.x, y: m.y, deltaX: m.dx, deltaY: m.dy, modifiers: mods });
        break;
      case "dragselect":
        await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: m.x0, y: m.y0, button: "left", clickCount: 1, modifiers: mods });
        await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: m.x1, y: m.y1, button: "left", modifiers: mods });
        await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: m.x1, y: m.y1, button: "left", clickCount: 1, modifiers: mods });
        break;
      case "key":
        if (m.text && m.text.length === 1 && (mods & CTRL_OR_META) === 0) {
          await this.send("Input.dispatchKeyEvent", { type: "char", text: m.text, modifiers: mods });
        } else {
          const base = { key: m.key, code: m.code, windowsVirtualKeyCode: m.vk, modifiers: mods };
          await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
          await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
        }
        break;
    }
  }

  isClosed(): boolean {
    return this.closed;
  }

  // Stop the screencast and drop the socket. Best-effort; never throws. The
  // stopScreencast send is bounded by stopTimeoutMs: if the CDP socket is
  // wedged (an unresponsive renderer on a heavy login page) the send never
  // resolves, so we race it against a timer and force the socket shut
  // regardless — otherwise /complete and /cancel, which await this, would hang.
  async stop(): Promise<void> {
    if (this.cdp && !this.closed) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.stopTimeoutMs);
      });
      try {
        await Promise.race([this.send("Page.stopScreencast").then(() => undefined), timeout]);
      } catch {
        // ignore — we're tearing down
      } finally {
        // Clear the bound so the fast path (stopScreencast replied first) doesn't
        // leave a ref'd timer pending until it fires.
        if (timer) clearTimeout(timer);
      }
    }
    try {
      this.cdp?.close();
    } catch {
      // ignore
    }
    this.handleClosed();
  }
}

// One bridge per instance (the spawned Chrome is per-instance). Lazily created
// on first screencast request and reused across the frames-SSE and input-POST
// endpoints; torn down when the sign-in completes or the socket drops.
let activeBridge: ScreencastBridge | undefined;
// The setupRequest id that owns the active/starting bridge. The screencast is a
// single per-instance channel, but two concurrent browser.connect sign-ins (two
// tasks, or one task on two hosts) can be pending at once. Without an owner, the
// second sign-in's frames/input would bind to the FIRST sign-in's page (the
// operator would see and type into the wrong task's login), and completing or
// cancelling either would tear down the other's live screencast. So the bridge
// is claimed by one setup id; a different owner is rejected (the HTTP layer
// turns the throw into a 409) until the holder finishes.
let activeOwner: string | undefined;
let startingOwner: string | undefined;
// In-flight start promise so concurrent first-callers (the frames-SSE GET and
// the input-POST arriving together on the first request) share ONE bridge
// instead of each launching a CDP socket and leaking the loser's. Cleared once
// the start settles.
let startingBridge: Promise<ScreencastBridge> | undefined;
// Monotonic teardown counter. Bumped by stopActiveBridge so a start() that is
// in flight when teardown fires doesn't install (and orphan) a now-unwanted
// bridge: the start captures the generation up front and, if it changed by the
// time start() resolves, stops the freshly-built bridge instead of installing
// it. Without this, "I've signed in" (which calls stopActiveBridge) racing the
// modal's still-connecting frames request would leave a live CDP socket that
// nothing ever closes.
let bridgeGeneration = 0;

// Raised when a screencast request targets the instance's bridge while another
// sign-in setup already owns it. The HTTP layer maps this to a 409.
export class ScreencastBusyError extends Error {
  constructor() {
    super("Another sign-in is using the agent's browser screencast.");
    this.name = "ScreencastBusyError";
  }
}

// Get the live bridge for `owner` (the setupRequest id), creating + starting one
// if none is active (or the previous one closed). A request from a DIFFERENT
// owner while the bridge is held throws ScreencastBusyError → 409, so two
// concurrent sign-ins can't cross-wire onto one page. `preferUrl` is forwarded
// to start() so the bridge attaches to the requesting task's page. Test seam:
// pass a factory to inject a fake bridge.
export async function getOrStartBridge(
  owner: string,
  preferUrl?: string,
  factory: () => ScreencastBridge = () => new ScreencastBridge()
): Promise<ScreencastBridge> {
  if (activeBridge && !activeBridge.isClosed()) {
    if (activeOwner !== owner) throw new ScreencastBusyError();
    return activeBridge;
  }
  if (startingBridge) {
    if (startingOwner !== owner) throw new ScreencastBusyError();
    return startingBridge;
  }
  const bridge = factory();
  const startedAtGeneration = bridgeGeneration;
  startingOwner = owner;
  startingBridge = bridge
    .start(preferUrl)
    .then(() => {
      // A teardown landed while we were starting — don't install this bridge;
      // stop it so its CDP socket isn't orphaned.
      if (bridgeGeneration !== startedAtGeneration) {
        void bridge.stop();
        return bridge;
      }
      activeBridge = bridge;
      activeOwner = owner;
      return bridge;
    })
    .finally(() => {
      startingBridge = undefined;
      startingOwner = undefined;
    });
  return startingBridge;
}

// Tear down the active bridge (sign-in completed / cancelled / shutdown). Bumps
// the generation so any start() still in flight tears its own bridge down
// instead of installing it after this returns. When `owner` is given, only the
// bridge OWNED by that setup is torn down — completing or cancelling one sign-in
// must not kill another's live screencast; a mismatch is a no-op. Pass no owner
// for an unconditional teardown (shutdown / closeAll).
export async function stopActiveBridge(owner?: string): Promise<void> {
  if (owner !== undefined && activeOwner !== undefined && activeOwner !== owner && startingOwner !== owner) {
    return;
  }
  bridgeGeneration += 1;
  const bridge = activeBridge;
  activeBridge = undefined;
  activeOwner = undefined;
  startingBridge = undefined;
  startingOwner = undefined;
  if (bridge) await bridge.stop();
}

// Test-only: install a ready bridge as the active one so the HTTP endpoints
// reuse it (exercises the success-path wiring without launching Chrome). The
// owner must match the setup id the reusing request carries, or it would 409.
export function __setActiveBridgeForTest(bridge: ScreencastBridge, owner?: string): void {
  activeBridge = bridge;
  activeOwner = owner;
  startingBridge = undefined;
  startingOwner = undefined;
}

// Test-only reset so a suite doesn't leak the module-level bridge.
export function __resetActiveBridgeForTest(): void {
  activeBridge = undefined;
  activeOwner = undefined;
  startingBridge = undefined;
  startingOwner = undefined;
}
