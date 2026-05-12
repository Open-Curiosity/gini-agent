// Browser automation tools. Drives a headless Chromium via playwright-core.
// One Chromium instance is shared across tasks; each task gets its own
// BrowserContext for cookie/storage isolation. Sessions are keyed by
// taskId and idle-swept after 5 minutes. All tools are sync — they return
// a JSON string immediately. Side-effecting actions (click/type) skip the
// approval gate; the snapshot itself is the trace evidence.
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";

const SNAPSHOT_CHAR_BUDGET = 32_000;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30_000;

interface Session {
  context: BrowserContext;
  page: Page;
  refs: Map<string, Locator>;
  lastActivity: number;
}

let sharedBrowser: Browser | undefined;
let chromiumImport: Promise<typeof import("playwright-core").chromium> | undefined;
const sessions = new Map<string, Session>();
let sweepTimer: ReturnType<typeof setInterval> | undefined;
let exitHookRegistered = false;

function loadChromium(): Promise<typeof import("playwright-core").chromium> {
  if (!chromiumImport) {
    chromiumImport = import("playwright-core").then((mod) => mod.chromium);
  }
  return chromiumImport;
}

async function ensureBrowser(): Promise<Browser> {
  if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
  const chromium = await loadChromium();
  try {
    sharedBrowser = await chromium.launch({ headless: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to launch Chromium: ${message}. ` +
        "Run `bunx playwright install chromium` to install the browser."
    );
  }
  registerExitHook();
  startSweeper();
  return sharedBrowser;
}

function registerExitHook(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  const handler = () => {
    void closeAll();
  };
  process.on("beforeExit", handler);
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}

function startSweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const cutoff = Date.now() - IDLE_TIMEOUT_MS;
    for (const [taskId, session] of sessions.entries()) {
      if (session.lastActivity < cutoff) {
        void closeSession(taskId);
      }
    }
  }, SWEEP_INTERVAL_MS);
  // Don't keep the event loop alive just for the sweeper.
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();
}

async function getOrCreate(taskId: string): Promise<Session> {
  const existing = sessions.get(taskId);
  if (existing) {
    existing.lastActivity = Date.now();
    return existing;
  }
  const browser = await ensureBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  const session: Session = { context, page, refs: new Map(), lastActivity: Date.now() };
  sessions.set(taskId, session);
  return session;
}

function touch(taskId: string): void {
  const session = sessions.get(taskId);
  if (session) session.lastActivity = Date.now();
}

async function closeSession(taskId: string): Promise<void> {
  const session = sessions.get(taskId);
  if (!session) return;
  sessions.delete(taskId);
  try {
    await session.context.close();
  } catch {
    // Already closed or browser disconnected; nothing useful to do.
  }
  if (sessions.size === 0 && sharedBrowser) {
    try {
      await sharedBrowser.close();
    } catch {
      // ignore
    }
    sharedBrowser = undefined;
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = undefined;
    }
  }
}

export async function closeAll(): Promise<void> {
  const ids = Array.from(sessions.keys());
  for (const id of ids) {
    const session = sessions.get(id);
    sessions.delete(id);
    if (!session) continue;
    try {
      await session.context.close();
    } catch {
      // ignore
    }
  }
  if (sharedBrowser) {
    try {
      await sharedBrowser.close();
    } catch {
      // ignore
    }
    sharedBrowser = undefined;
  }
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = undefined;
  }
}

// Cloud metadata endpoints and link-local IPs we never want the agent to
// poke at, even though Gini is local-first. The 169.254.0.0/16 check
// covers AWS, Azure, and other cloud-provider quirks in one shot.
const BLOCKED_HOSTNAMES = new Set([
  "169.254.169.254",
  "100.100.100.200",
  "metadata.google.internal",
  "metadata.goog"
]);

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /xoxb-[A-Za-z0-9-]{20,}/,
  /xoxp-[A-Za-z0-9-]{20,}/,
  /AKIA[0-9A-Z]{16}/
];

function isLinkLocal(host: string): boolean {
  // 169.254.0.0/16
  return /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host);
}

function safetyCheck(rawUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return `Invalid URL: ${rawUrl}`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Blocked: only http(s) URLs are allowed (got ${parsed.protocol}).`;
  }
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host)) {
    return `Blocked: ${host} is a cloud metadata endpoint.`;
  }
  if (isLinkLocal(host)) {
    return `Blocked: ${host} is a link-local address.`;
  }
  let decoded = rawUrl;
  try {
    decoded = decodeURIComponent(rawUrl);
  } catch {
    // Malformed escape — fall back to the raw form.
  }
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(rawUrl) || pattern.test(decoded)) {
      return "Blocked: URL appears to contain an API key or token.";
    }
  }
  return undefined;
}

interface SnapEntry {
  ref: string;
  role: string;
  name: string;
  value: string;
  url: string;
  depth: number;
  full: boolean; // true when emitted only because we're in `full` mode
}

interface SnapshotResult {
  text: string;
  refs: Map<string, Locator>;
  elementCount: number;
  truncated: boolean;
}

// Walk the page in the browser and return a flat list of "interesting"
// nodes plus a unique CSS-attribute ref we can use to resolve a Locator
// later. Built in a single page.evaluate so we minimize round-trips and
// reuse one DOM walk for both the snapshot text and the locator map.
async function snapshot(page: Page, full: boolean): Promise<SnapshotResult> {
  const REF_ATTR = "data-gini-ref";
  // First, clear stale refs from prior snapshots so id allocation stays
  // stable across calls.
  await page.evaluate((attr) => {
    for (const el of document.querySelectorAll(`[${attr}]`)) el.removeAttribute(attr);
  }, REF_ATTR).catch(() => undefined);

  type Raw = {
    ref: string;
    role: string;
    name: string;
    value: string;
    url: string;
    depth: number;
    full: boolean;
  };

  const raw = await page.evaluate(
    ({ attr, fullMode }: { attr: string; fullMode: boolean }) => {
      const INTERACTIVE_TAGS = new Set([
        "A",
        "BUTTON",
        "INPUT",
        "SELECT",
        "TEXTAREA",
        "OPTION",
        "SUMMARY"
      ]);
      const ROLE_FROM_TAG: Record<string, string> = {
        A: "link",
        BUTTON: "button",
        SELECT: "combobox",
        TEXTAREA: "textbox",
        OPTION: "option",
        SUMMARY: "button"
      };
      const INPUT_ROLE: Record<string, string> = {
        button: "button",
        submit: "button",
        reset: "button",
        checkbox: "checkbox",
        radio: "radio",
        range: "slider",
        search: "searchbox",
        email: "textbox",
        text: "textbox",
        password: "textbox",
        tel: "textbox",
        url: "textbox",
        number: "spinbutton"
      };

      const roleOf = (el: Element): string | undefined => {
        const explicit = el.getAttribute("role");
        if (explicit) return explicit;
        if (el.tagName === "INPUT") {
          const type = (el as HTMLInputElement).type?.toLowerCase() ?? "text";
          return INPUT_ROLE[type] ?? "textbox";
        }
        return ROLE_FROM_TAG[el.tagName];
      };

      const nameOf = (el: Element): string => {
        const aria = el.getAttribute("aria-label");
        if (aria) return aria.trim();
        const labelledby = el.getAttribute("aria-labelledby");
        if (labelledby) {
          const refs = labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "");
          const joined = refs.join(" ").trim();
          if (joined) return joined;
        }
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
          const id = el.getAttribute("id");
          if (id) {
            const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            const text = lbl?.textContent?.trim();
            if (text) return text;
          }
          const placeholder = el.getAttribute("placeholder");
          if (placeholder) return placeholder.trim();
        }
        const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        return text.slice(0, 120);
      };

      const isVisible = (el: Element): boolean => {
        const rect = (el as HTMLElement).getBoundingClientRect?.();
        if (!rect) return false;
        if (rect.width === 0 && rect.height === 0) return false;
        const style = window.getComputedStyle(el as HTMLElement);
        if (style.display === "none" || style.visibility === "hidden") return false;
        return true;
      };

      const out: Raw[] = [];
      let nextId = 1;
      const walk = (el: Element, depth: number): void => {
        const tag = el.tagName;
        const role = roleOf(el);
        const interactive = role !== undefined && (INTERACTIVE_TAGS.has(tag) || el.getAttribute("role"));
        const visible = isVisible(el);
        if (interactive && visible) {
          const ref = `@e${nextId++}`;
          el.setAttribute(attr, ref.slice(1));
          let value = "";
          if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
            value = (el as HTMLInputElement).value ?? "";
          } else if (el.tagName === "SELECT") {
            value = (el as HTMLSelectElement).value ?? "";
          }
          const url = el.tagName === "A" ? (el as HTMLAnchorElement).href : "";
          out.push({
            ref,
            role: role!,
            name: nameOf(el),
            value,
            url,
            depth,
            full: false
          });
        } else if (fullMode && visible) {
          // In full mode, also record landmark/heading text so the snapshot
          // captures structural cues the model can use for orientation.
          const landmarkRoles = ["heading", "main", "navigation", "banner", "contentinfo", "region"];
          const tagToRole: Record<string, string> = {
            H1: "heading",
            H2: "heading",
            H3: "heading",
            H4: "heading",
            MAIN: "main",
            NAV: "navigation",
            HEADER: "banner",
            FOOTER: "contentinfo",
            ARTICLE: "article",
            SECTION: "region"
          };
          const fallbackRole = role ?? tagToRole[tag];
          if (fallbackRole && landmarkRoles.includes(fallbackRole)) {
            const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
            if (text) {
              out.push({ ref: "", role: fallbackRole, name: text, value: "", url: "", depth, full: true });
            }
          }
        }
        for (const child of Array.from(el.children)) walk(child, depth + 1);
      };
      walk(document.body, 0);
      return out;
    },
    { attr: REF_ATTR, fullMode: full }
  );

  const refs = new Map<string, Locator>();
  const lines: string[] = [];
  let charCount = 0;
  let truncated = false;
  let elementCount = 0;
  for (const entry of raw as SnapEntry[]) {
    const indent = "  ".repeat(entry.depth);
    let line: string;
    if (entry.ref) {
      line = `${indent}[${entry.ref}] ${entry.role}`;
      if (entry.name) line += ` "${entry.name}"`;
      if (entry.value) line += ` value="${entry.value}"`;
      if (entry.role === "link" && entry.url) line += ` url="${entry.url}"`;
    } else {
      line = `${indent}${entry.role} "${entry.name}"`;
    }
    if (charCount + line.length + 1 > SNAPSHOT_CHAR_BUDGET) {
      truncated = true;
      break;
    }
    lines.push(line);
    charCount += line.length + 1;
    if (entry.ref) {
      refs.set(entry.ref, page.locator(`[${REF_ATTR}="${entry.ref.slice(1)}"]`));
      elementCount++;
    }
  }
  let text = lines.join("\n");
  if (truncated) text += "\n[...truncated]";
  return { text, refs, elementCount, truncated };
}

function ok(payload: Record<string, unknown>): string {
  return JSON.stringify({ success: true, ...payload });
}

function fail(error: string): string {
  return JSON.stringify({ success: false, error });
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function browserNavigate(taskId: string, args: Record<string, unknown>): Promise<string> {
  const url = str(args.url);
  if (!url) return fail("Missing required string argument: url");
  const blocked = safetyCheck(url);
  if (blocked) return fail(blocked);
  try {
    const session = await getOrCreate(taskId);
    const response = await session.page.goto(url, { waitUntil: "domcontentloaded" });
    touch(taskId);
    const snap = await snapshot(session.page, false);
    session.refs = snap.refs;
    return ok({
      url: session.page.url(),
      status: response?.status() ?? null,
      title: await session.page.title(),
      snapshot: snap.text,
      elementCount: snap.elementCount,
      truncated: snap.truncated
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export async function browserSnapshot(taskId: string, args: Record<string, unknown>): Promise<string> {
  const full = bool(args.full, false);
  try {
    const session = await getOrCreate(taskId);
    const snap = await snapshot(session.page, full);
    session.refs = snap.refs;
    touch(taskId);
    return ok({
      url: session.page.url(),
      title: await session.page.title(),
      snapshot: snap.text,
      elementCount: snap.elementCount,
      truncated: snap.truncated
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export async function browserClick(taskId: string, args: Record<string, unknown>): Promise<string> {
  const ref = str(args.ref);
  if (!ref) return fail("Missing required string argument: ref");
  try {
    const session = await getOrCreate(taskId);
    const locator = session.refs.get(ref);
    if (!locator) return fail(`Unknown ref ${ref}. Take a fresh snapshot first.`);
    await locator.click({ timeout: 10_000 });
    await session.page.waitForLoadState("domcontentloaded").catch(() => undefined);
    touch(taskId);
    const snap = await snapshot(session.page, false);
    session.refs = snap.refs;
    return ok({
      url: session.page.url(),
      title: await session.page.title(),
      snapshot: snap.text,
      elementCount: snap.elementCount,
      truncated: snap.truncated
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export async function browserType(taskId: string, args: Record<string, unknown>): Promise<string> {
  const ref = str(args.ref);
  const text = typeof args.text === "string" ? args.text : undefined;
  if (!ref) return fail("Missing required string argument: ref");
  if (text === undefined) return fail("Missing required string argument: text");
  try {
    const session = await getOrCreate(taskId);
    const locator = session.refs.get(ref);
    if (!locator) return fail(`Unknown ref ${ref}. Take a fresh snapshot first.`);
    await locator.fill(text, { timeout: 10_000 });
    touch(taskId);
    const snap = await snapshot(session.page, false);
    session.refs = snap.refs;
    return ok({
      url: session.page.url(),
      snapshot: snap.text,
      elementCount: snap.elementCount,
      truncated: snap.truncated
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export async function browserPress(taskId: string, args: Record<string, unknown>): Promise<string> {
  const key = str(args.key);
  if (!key) return fail("Missing required string argument: key");
  try {
    const session = await getOrCreate(taskId);
    await session.page.keyboard.press(key);
    await session.page.waitForLoadState("domcontentloaded").catch(() => undefined);
    touch(taskId);
    const snap = await snapshot(session.page, false);
    session.refs = snap.refs;
    return ok({
      url: session.page.url(),
      snapshot: snap.text,
      elementCount: snap.elementCount,
      truncated: snap.truncated
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export async function browserScroll(taskId: string, args: Record<string, unknown>): Promise<string> {
  const direction = str(args.direction);
  if (direction !== "up" && direction !== "down") {
    return fail("Argument direction must be 'up' or 'down'.");
  }
  try {
    const session = await getOrCreate(taskId);
    const dy = direction === "down" ? 600 : -600;
    await session.page.evaluate((delta) => window.scrollBy(0, delta), dy);
    touch(taskId);
    const snap = await snapshot(session.page, false);
    session.refs = snap.refs;
    return ok({
      url: session.page.url(),
      snapshot: snap.text,
      elementCount: snap.elementCount,
      truncated: snap.truncated
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export async function browserBack(taskId: string, _args: Record<string, unknown>): Promise<string> {
  try {
    const session = await getOrCreate(taskId);
    const response = await session.page.goBack({ waitUntil: "domcontentloaded" });
    touch(taskId);
    const snap = await snapshot(session.page, false);
    session.refs = snap.refs;
    return ok({
      url: session.page.url(),
      status: response?.status() ?? null,
      title: await session.page.title(),
      snapshot: snap.text,
      elementCount: snap.elementCount,
      truncated: snap.truncated
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

const consoleLogs = new Map<string, Array<{ type: string; text: string }>>();
const consoleHooked = new WeakSet<Page>();

function attachConsole(taskId: string, page: Page): void {
  if (consoleHooked.has(page)) return;
  consoleHooked.add(page);
  page.on("console", (msg) => {
    const buf = consoleLogs.get(taskId) ?? [];
    buf.push({ type: msg.type(), text: msg.text() });
    if (buf.length > 200) buf.splice(0, buf.length - 200);
    consoleLogs.set(taskId, buf);
  });
}

export async function browserConsole(taskId: string, args: Record<string, unknown>): Promise<string> {
  const expression = str(args.expression);
  const clear = bool(args.clear, false);
  try {
    const session = await getOrCreate(taskId);
    attachConsole(taskId, session.page);
    if (clear) {
      consoleLogs.set(taskId, []);
    }
    let evalResult: unknown = undefined;
    let evalError: string | undefined;
    if (expression) {
      try {
        evalResult = await session.page.evaluate((expr) => {
          // eslint-disable-next-line no-new-func
          return new Function(`return (${expr});`)();
        }, expression);
      } catch (error) {
        evalError = error instanceof Error ? error.message : String(error);
      }
    }
    touch(taskId);
    const messages = consoleLogs.get(taskId) ?? [];
    return ok({
      url: session.page.url(),
      messages,
      evalResult: evalResult === undefined ? null : evalResult,
      evalError: evalError ?? null
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export async function browserClose(taskId: string, _args: Record<string, unknown>): Promise<string> {
  try {
    consoleLogs.delete(taskId);
    await closeSession(taskId);
    return ok({ closed: true, taskId });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
