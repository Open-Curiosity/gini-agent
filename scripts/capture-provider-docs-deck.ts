// Drives the running Gini web UI and captures screenshots of the inline
// provider setup-guide feature for EVERY provider, capturing each guide at its
// full rendered height (the DocSheet is a scroll container, so we size the
// viewport to the doc's scrollHeight before shooting — nothing is cut off).
// Then writes a self-contained HTML slide deck + a manifest for verification.
//
// Prereqs: the worktree's web dev server must be running (gini run). Pass the
// web port as WEB_PORT (defaults to 3089). Uses the system Chrome via
// playwright-core (no extra browser download).
//
// Run:  WEB_PORT=3089 bun scripts/capture-provider-docs-deck.ts
import { chromium, type Locator, type Page } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PORT = process.env.WEB_PORT ?? "3089";
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = join(import.meta.dir, "..", "deck");
const SHOTS = join(OUT, "shots");
const BASE_W = 1440;
const BASE_H = 900;
// Hard ceiling on viewport height so a runaway doc can't ask for a gigapixel
// image. Logged per provider; if any guide's scrollHeight exceeds this we warn
// (the shot would clip), but real docs render well under it.
const MAX_H = 12000;

// Provider tiles in display order. `label` is the exact tile/label text and the
// {X} in "Read the {X} setup guide"; `title` is the doc's H1 (the sheet title).
const PROVIDERS = [
  { name: "codex", label: "Codex", title: "Codex" },
  { name: "openai", label: "OpenAI", title: "OpenAI" },
  { name: "anthropic", label: "Anthropic", title: "Anthropic (first-party Claude API)" },
  { name: "bedrock", label: "Amazon Bedrock", title: "Amazon Bedrock" },
  { name: "openrouter", label: "OpenRouter", title: "OpenRouter" },
  { name: "deepseek", label: "DeepSeek", title: "DeepSeek" },
  { name: "azure", label: "Azure OpenAI", title: "Azure OpenAI" },
  { name: "local", label: "Local", title: "Local (OpenAI-compatible)" }
];

interface Slide {
  file: string;
  title: string;
  caption: string;
}
interface ManifestRow {
  provider: string;
  label: string;
  guideShot: string;
  scrollHeight: number;
  hitCap: boolean;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: BASE_W, height: BASE_H }, deviceScaleFactor: 2 });
  const slides: Slide[] = [];
  const manifest: ManifestRow[] = [];

  async function shootPage(name: string, title: string, caption: string) {
    const file = `shots/${name}.png`;
    await page.screenshot({ path: join(OUT, file) });
    slides.push({ file, title, caption });
    console.log(`captured ${file}`);
  }
  async function shootEl(loc: Locator, name: string, title: string, caption: string) {
    const file = `shots/${name}.png`;
    await loc.screenshot({ path: join(OUT, file) });
    slides.push({ file, title, caption });
    console.log(`captured ${file}`);
  }

  async function selectTile(label: string) {
    await page.locator("section").filter({ hasText: "Provider type" })
      .getByText(label, { exact: true }).click();
    // The Configure heading reflects the selected provider — wait for it.
    await page.getByRole("heading", { name: `Configure ${label}` }).waitFor({ state: "visible", timeout: 30000 });
  }

  // Open a provider's guide, size the viewport to the doc's full height, return
  // the dialog locator + its scrollHeight so the caller can shoot + record.
  // `title` is the doc's expected H1 (the sheet title) — asserting it confirms
  // the link opened the RIGHT provider's guide, not just some dialog.
  async function openGuideFull(label: string, title: string): Promise<{ dialog: Locator; scrollHeight: number; hitCap: boolean }> {
    const link = new RegExp(`Read the ${escapeRegExp(label)} setup guide`);
    await page.getByRole("button", { name: link }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ state: "visible", timeout: 30000 });
    await dialog.getByRole("heading", { name: title, exact: true }).waitFor({ state: "visible", timeout: 30000 });
    // Body loaded (skeletons replaced by rendered markdown).
    await dialog.locator(".doc-panel").waitFor({ state: "visible", timeout: 30000 });
    await page.waitForTimeout(300);
    // Grow the viewport so the whole doc fits with no scroll, guaranteeing a
    // full capture. Content can reflow slightly TALLER after a resize (font /
    // markdown settle), so re-measure and re-grow until the scroll container no
    // longer overflows (clientHeight >= scrollHeight) or we hit the cap.
    const PAD = 80;
    let scrollHeight = 0;
    let hitCap = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const m = await dialog.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
      scrollHeight = m.scroll;
      if (m.client >= m.scroll) break; // no overflow — fully visible
      const target = Math.min(m.scroll + PAD, MAX_H);
      hitCap = m.scroll + PAD > MAX_H;
      await page.setViewportSize({ width: BASE_W, height: target });
      await page.waitForTimeout(400);
      if (hitCap) break;
    }
    return { dialog, scrollHeight, hitCap };
  }

  async function closeSheet() {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.setViewportSize({ width: BASE_W, height: BASE_H });
    await page.waitForTimeout(150);
  }

  // --- Intro: the Add Provider tile grid ---
  await page.goto(`${BASE}/settings/add-provider`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /Read the Codex setup guide/ }).waitFor({ state: "visible", timeout: 60000 });
  await shootPage(
    "00-add-provider-overview",
    "Add Provider — every provider links to its guide",
    "Each tile's Configure panel carries a “Read the {provider} setup guide” link, derived from the runtime catalog's setupDocUrl. Walkthrough follows for all eight."
  );

  // --- Per provider: the setup link, then the FULL guide ---
  for (let i = 0; i < PROVIDERS.length; i += 1) {
    const p = PROVIDERS[i]!;
    const n = String(i + 1).padStart(2, "0");
    await selectTile(p.label);

    // Link slide: the Configure section showing this provider's setup-guide link.
    const section = page.locator("section").filter({ hasText: `Configure ${p.label}` });
    await shootEl(
      section,
      `${n}a-${p.name}-link`,
      `${p.label} — setup-guide link`,
      `Selecting ${p.label} shows its own “Read the ${p.label} setup guide” link in the Configure panel.`
    );

    // Full-guide slide: the whole doc, captured at full scroll height.
    const { dialog, scrollHeight, hitCap } = await openGuideFull(p.label, p.title);
    const guideFile = `shots/${n}b-${p.name}-guide.png`;
    await dialog.screenshot({ path: join(OUT, guideFile) });
    slides.push({
      file: guideFile,
      title: `${p.label} — full setup guide`,
      caption: `The complete ${p.label} guide rendered inline (top to bottom): credentials, prerequisites, CLI + web config, and re-authentication.`
    });
    manifest.push({ provider: p.name, label: p.label, guideShot: guideFile, scrollHeight, hitCap });
    console.log(`captured ${guideFile}  (scrollHeight=${scrollHeight}px${hitCap ? " — HIT CAP" : ""})`);
    await closeSheet();
  }

  // --- Settings: every connected row links to its guide ---
  await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Setup guide" }).first().waitFor({ state: "visible", timeout: 60000 });
  await shootPage(
    "99-settings-rows",
    "Settings — every connected row links too",
    "Each connected provider row gains an always-present “Setup guide” link — visible while healthy, not only on a re-auth failure. The same slide-over opens here."
  );

  await browser.close();

  writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(OUT, "index.html"), buildDeck(slides));
  console.log(`\nDeck written to ${join(OUT, "index.html")} (${slides.length} slides)`);
  const capped = manifest.filter((m) => m.hitCap);
  if (capped.length) console.warn(`WARNING: ${capped.length} guide(s) exceeded MAX_H and may be clipped: ${capped.map((m) => m.provider).join(", ")}`);
}

function buildDeck(slides: Slide[]): string {
  const slideEls = slides
    .map(
      (s, i) => `    <section class="slide${i === 0 ? " active" : ""}" data-i="${i}">
      <div class="meta"><span class="num">${i + 1} / ${slides.length}</span><h2>${esc(s.title)}</h2></div>
      <div class="imgwrap"><img src="${s.file}" alt="${esc(s.title)}" /></div>
      <p class="cap">${esc(s.caption)}</p>
    </section>`
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Inline provider setup guides — feature deck</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         background: #0b0b12; color: #e7e7ee; display: grid; place-items: start center; min-height: 100vh; padding: 28px 0 80px; }
  .deck { width: min(1180px, 94vw); }
  .slide { display: none; }
  .slide.active { display: block; animation: fade .25s ease; }
  @keyframes fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  .meta { display: flex; align-items: baseline; gap: 14px; margin-bottom: 12px; }
  .num { font-variant-numeric: tabular-nums; color: #8b8ba7; font-size: 13px; letter-spacing: .04em; }
  h2 { margin: 0; font-size: 22px; font-weight: 650; }
  /* Tall guide shots get a scrollable frame so a long doc stays readable
     without blowing up the slide; short shots just sit at natural size. */
  .imgwrap { max-height: 74vh; overflow-y: auto; border-radius: 12px; border: 1px solid #23233a;
             box-shadow: 0 10px 40px rgba(0,0,0,.45); background: #fff; }
  img { width: 100%; display: block; }
  .cap { margin: 14px 2px 0; color: #b9b9cc; max-width: 92ch; }
  .bar { display: flex; align-items: center; justify-content: space-between; margin-top: 18px;
         position: sticky; bottom: 0; background: linear-gradient(transparent, #0b0b12 40%); padding-top: 14px; }
  .dots { display: flex; flex-wrap: wrap; gap: 7px; max-width: 70%; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #2c2c44; border: 0; padding: 0; cursor: pointer; }
  .dot.on { background: #6f6ff0; }
  button.nav { background: #1a1a2c; color: #e7e7ee; border: 1px solid #2c2c44; border-radius: 8px;
               padding: 8px 14px; cursor: pointer; font-size: 14px; }
  button.nav:hover { background: #23233a; }
  .hint { color: #6a6a85; font-size: 12px; text-align: center; margin-top: 10px; }
</style>
</head>
<body>
  <div class="deck">
${slideEls}
    <div class="bar">
      <button class="nav" id="prev">← Prev</button>
      <div class="dots" id="dots"></div>
      <button class="nav" id="next">Next →</button>
    </div>
    <p class="hint">Use ← → arrow keys, click Next/Prev, or tap a dot. Long guides scroll inside their frame.</p>
  </div>
<script>
  const slides = [...document.querySelectorAll(".slide")];
  const dotsWrap = document.getElementById("dots");
  let cur = 0;
  slides.forEach((_, i) => {
    const d = document.createElement("button");
    d.className = "dot" + (i === 0 ? " on" : "");
    d.addEventListener("click", () => go(i));
    dotsWrap.appendChild(d);
  });
  const dots = [...dotsWrap.children];
  function go(i) {
    cur = (i + slides.length) % slides.length;
    slides.forEach((s, j) => s.classList.toggle("active", j === cur));
    dots.forEach((d, j) => d.classList.toggle("on", j === cur));
    window.scrollTo({ top: 0 });
  }
  document.getElementById("next").addEventListener("click", () => go(cur + 1));
  document.getElementById("prev").addEventListener("click", () => go(cur - 1));
  document.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") go(cur + 1);
    if (e.key === "ArrowLeft") go(cur - 1);
  });
</script>
</body>
</html>
`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
