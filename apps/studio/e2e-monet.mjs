import { chromium } from "@playwright/test";
import fs from "node:fs";

const BASE = "http://localhost:5391";
const REF = "/Users/hamza/Desktop/k.o.v.e/evaluation-files/reference videos (priority, needs to look LIKE or BETTER than)/steph curry.MP4";
const SRC = [
  "/Users/hamza/Desktop/k.o.v.e/evaluation-files/Steph Curry IGNITES For 56 PTS In Orlando | February 27, 2025.mp4",
  "/Users/hamza/Desktop/k.o.v.e/evaluation-files/High Quality Steph Curry Clips for Edits! (2024-25).mp4",
];
const OUT = "/var/folders/xg/79c6mh7n3jl31j6s_j41yl6r0000gp/T/opencode/e2e-monet";
const PROMPT = "Create a 25-second vertical hype edit for TikTok using the imported clips. Tone: energetic, fast-paced and triumphant. Keep the best scoring moments, crossovers and crowd reactions; drop slow intros, dead air, replays and filler. Match the pacing, shot energy and rhythm of the attached reference video as closely as possible.";

fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const stamp = () => `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`;
const log = (...a) => console.log(stamp(), ...a);

const browser = await chromium.launch({ headless: false, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const consoleLines = [];
page.on("console", (m) => {
  const line = `[console:${m.type()}] ${m.text().slice(0, 400)}`;
  consoleLines.push(line);
  if (m.type() === "error" || m.type() === "warning" || /agent|monet|omni|ladder|tool|kove|proxy/i.test(m.text())) log(line);
});
page.on("pageerror", (e) => { consoleLines.push(`[pageerror] ${e.message.slice(0, 400)}`); log("[pageerror]", e.message.slice(0, 300)); });
page.on("response", (r) => {
  const u = r.url();
  if (/\/api\/(omni|agent|proxy|llm)/.test(u)) log("[net]", r.status(), u.replace(BASE, "").slice(0, 140));
});
page.on("requestfailed", (r) => {
  if (/\/api\//.test(r.url())) log("[netfail]", r.url().replace(BASE, "").slice(0, 140), r.failure()?.errorText);
});

// ---- boot + overlays ----
log("goto", BASE);
await page.goto(`${BASE}/#new`, { waitUntil: "domcontentloaded" });
await sleep(4000);
const skipTour = page.getByRole("button", { name: "Skip Tour" });
try { await skipTour.waitFor({ state: "visible", timeout: 8000 }); await skipTour.click(); log("tour skipped"); } catch { log("no tour modal"); }
const overlay = page.locator("div.fixed.inset-0.z-\\[100\\]");
if (await overlay.count()) { await page.evaluate(() => document.querySelectorAll("div.fixed.inset-0.z-\\[100\\]").forEach((el) => el.remove())); log("overlay force-removed"); }

// ---- open AI editor chat (patient, retries) ----
let composer = page.getByRole("textbox", { name: "AI edit request" });
{
  let ready = await composer.isVisible().catch(() => false);
  for (let attempt = 0; attempt < 4 && !ready; attempt++) {
    const chatBtn = page.getByRole("button", { name: "AI Editor chat" });
    if (await chatBtn.isVisible().catch(() => false)) await chatBtn.click({ timeout: 5000 }).catch(() => {});
    await sleep(3000);
    ready = await composer.isVisible().catch(() => false);
    log("chat open attempt", attempt + 1, "->", ready);
  }
  if (!ready) {
    await page.screenshot({ path: `${OUT}/chat-open-failed.png` });
    throw new Error("AI chat composer never became visible");
  }
}
log("chat composer ready");

// ---- import sources ----
log("importing sources...");
await page.locator('input[aria-label="Import media"]').setInputFiles(SRC);
{
  const deadline = Date.now() + 180000;
  let ok = false;
  while (Date.now() < deadline) {
    const body = await page.locator("body").innerText().catch(() => "");
    const a = /Steph Curry IGNITES/i.test(body);
    const b = /High Quality Steph Curry/i.test(body);
    if (a && b) { ok = true; break; }
    await sleep(2000);
  }
  if (!ok) { log("WARN: source import not confirmed in media panel after 180s"); }
  else log("sources imported (visible in media panel)");
}
await sleep(1500);

// ---- attach reference (wait for import + chip: import queues behind sources) ----
log("attaching reference...");
await page.locator('input[aria-label="Attach reference video"]').setInputFiles(REF);
{
  const deadline = Date.now() + 240000;
  let ready = false;
  while (Date.now() < deadline) {
    const chip = await page.getByText("steph curry.MP4", { exact: false }).first().isVisible().catch(() => false);
    const intents = await page.getByRole("group", { name: "Reference intent" }).isVisible().catch(() => false);
    if (chip && intents) { ready = true; break; }
    await sleep(2000);
  }
  if (!ready) { log("ERROR: reference chip never appeared — aborting to avoid a no-reference turn"); await page.screenshot({ path: `${OUT}/no-chip.png` }); throw new Error("reference attach timed out"); }
  log("reference chip + intent controls visible");
}
await sleep(1000);

// ---- dismiss any modal overlay that appeared ----
const dismissBlockers = async (tag) => {
  const blocker = page.locator("div.fixed.inset-0.z-\\[100\\]");
  if (!(await blocker.count())) return false;
  await page.screenshot({ path: `${OUT}/modal-${tag}.png` });
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(600);
  for (const label of ["Continue", "Close", "Done", "Got it", "Skip", "OK", "Dismiss"]) {
    if (!(await blocker.count())) break;
    const b = page.getByRole("button", { name: label, exact: true }).first();
    if (await b.isVisible().catch(() => false)) await b.click({ timeout: 2000 }).catch(() => {});
    await sleep(300);
  }
  if (await blocker.count()) {
    await page.evaluate(() => document.querySelectorAll("div.fixed.inset-0.z-\\[100\\]").forEach((el) => el.remove()));
    log("force-removed modal overlay at", tag);
  }
  return true;
};
await dismissBlockers("before-send");

// ---- prompt + send ----
log("filling prompt");
await composer.fill(PROMPT);
await sleep(500);
const send = page.getByRole("button", { name: "Send" });
if (!(await send.isEnabled())) { log("ERROR: Send disabled — aborting"); await page.screenshot({ path: `${OUT}/send-disabled.png` }); }
else {
  await send.click();
  log("SENT");
}
await page.screenshot({ path: `${OUT}/00-after-send.png` });

// ---- run watch loop ----
const APPROVE = /^(approve|allow|confirm|proceed|accept|yes|run|continue)(\s|$)/i;
let lastChatSnapshot = "";
let stableSince = Date.now();
let approvals = 0;
let done = false;
const deadline = Date.now() + 15 * 60 * 1000;
let lastStatusLine = "";
const loggedErrors = new Set();

while (Date.now() < deadline && !done) {
  await dismissBlockers("watch");
  // approval / confirmation buttons inside the chat
  const buttons = page.locator('[role="banner"] button, [role="dialog"] button, button');
  const n = Math.min(await buttons.count(), 400);
  for (let i = 0; i < n; i++) {
    const b = buttons.nth(i);
    try {
      const name = ((await b.getAttribute("aria-label")) || (await b.textContent()) || "").trim();
      if (!name || name.length > 60) continue;
      if (!APPROVE.test(name)) continue;
      if (/send|attach|approve all/i.test(name)) continue;
      if (await b.isVisible() && await b.isEnabled()) {
        await b.click({ timeout: 2000 });
        approvals++;
        log("clicked approval-like button:", JSON.stringify(name));
        await sleep(800);
      }
    } catch { /* transient */ }
  }

  // chat transcript snapshot
  let snapshot = "";
  try {
    const body = await page.locator("body").innerText({ timeout: 3000 });
    const idx = body.lastIndexOf("AI Editor");
    snapshot = idx >= 0 ? body.slice(idx, idx + 3500) : body.slice(-2500);
  } catch { /* keep last */ }
  if (snapshot && snapshot !== lastChatSnapshot) {
    lastChatSnapshot = snapshot;
    stableSince = Date.now();
    const lines = snapshot.split("\n").filter(Boolean).slice(-6);
    log("chat update:", JSON.stringify(lines.join(" | ")).slice(0, 600));
  }

  // status line near composer (measurement progress etc.)
  try {
    const status = await page.getByRole("status").first().innerText({ timeout: 400 });
    if (status && status !== lastStatusLine) {
      lastStatusLine = status;
      stableSince = Date.now();
      log("status:", status.slice(0, 200));
    }
  } catch { /* none */ }

  // surface any error bubbles promptly
  const errText = await page.locator('text=/failed|error|unavailable|rate.?limit/i').first().innerText({ timeout: 300 }).catch(() => "");
  if (errText && !loggedErrors.has(errText)) { loggedErrors.add(errText); log("error text:", errText.slice(0, 200)); }

  // completion: not busy (Stop button gone), timeline populated, chat quiet 20s
  const timelineEmpty = await page.getByText("Your timeline is empty").isVisible().catch(() => false);
  const busyIndicator = await page.getByRole("button", { name: "Stop" }).isVisible().catch(() => false);
  const statusVisible = await page.getByRole("status").first().isVisible().catch(() => false);
  const stableMs = Date.now() - stableSince;
  if (!busyIndicator && !statusVisible && !timelineEmpty && stableMs > 20000 && Date.now() > t0 + 120000) {
    const lastWords = snapshot.split("\n").filter(Boolean).slice(-1)[0] ?? "";
    log("completion heuristic hit; last line:", JSON.stringify(lastWords.slice(0, 200)));
    done = true;
  }
  await sleep(2000);
}
log("watch loop end; done =", done);

// ---- capture ----
await page.screenshot({ path: `${OUT}/01-final.png`, fullPage: false });
let transcript = "";
try {
  const body = await page.locator("body").innerText({ timeout: 5000 });
  const idx = body.lastIndexOf("AI Editor");
  transcript = idx >= 0 ? body.slice(idx) : body;
} catch {
  transcript = await page.locator("body").innerText().catch(() => "");
}
fs.writeFileSync(`${OUT}/transcript.txt`, transcript);
log("=== TRANSCRIPT ===");
console.log(transcript.slice(0, 6000));

// project duration + timeline emptiness
const bannerText = await page.locator("header, [role=banner]").first().innerText().catch(() => "");
log("=== PROJECT BANNER ===", JSON.stringify(bannerText.slice(0, 300)));
const timelineEmptyNow = await page.getByText("Your timeline is empty").isVisible().catch(() => false);
log("timeline empty:", timelineEmptyNow);

// preview player frames at three points of the timeline
try {
  const ruler = page.locator('[aria-label="Timeline zoom"]').first();
  const bar = ruler.locator("xpath=ancestor::*[2]");
  const box = await bar.boundingBox();
  if (box) {
    for (const [name, frac] of [["a", 0.2], ["b", 0.5], ["c", 0.8]]) {
      await page.mouse.click(box.x + box.width * frac, box.y + 2);
      await sleep(1200);
      const player = page.locator("canvas").first();
      if (await player.isVisible()) await player.screenshot({ path: `${OUT}/preview-${name}.png` });
    }
    log("preview frames a/b/c captured");
  }
} catch (e) { log("preview frames failed:", e.message); }

// timeline clip count + duration from banner
try {
  const banner = await page.locator("header, [role=banner]").first().innerText({ timeout: 3000 });
  const dur = banner.match(/\d{2}:\d{2}:\d{2}/g);
  log("banner durations:", JSON.stringify(dur));
  const clipRows = await page.locator('[data-clip-id], [class*="clip"]').count();
  log("clip-ish DOM nodes:", clipRows);
} catch (e) { log("timeline capture failed:", e.message); }

// export attempt (time-boxed)
try {
  await page.getByRole("button", { name: "Export", exact: true }).first().click({ timeout: 5000 });
  await sleep(2500);
  await page.screenshot({ path: `${OUT}/export-dialog.png` });
  const startBtn = page.getByRole("button", { name: /^(Start export|Export|Render|Start)\b/ }).first();
  if (await startBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    log("export dialog open; clicking", JSON.stringify(await startBtn.textContent().catch(() => "")));
    const downloadPromise = page.waitForEvent("download", { timeout: 420000 }).catch(() => null);
    await startBtn.click();
    const dl = await downloadPromise;
    if (dl) {
      const dest = `${OUT}/export-output.bin`;
      await dl.saveAs(dest);
      log("download saved:", dl.suggestedFilename(), "->", dest);
    } else {
      for (let i = 0; i < 60; i++) {
        await sleep(5000);
        const bodyTxt = await page.locator("body").innerText().catch(() => "");
        if (/export (complete|finished|done)/i.test(bodyTxt)) { log("export reports complete (no download event)"); break; }
      }
    }
  } else {
    log("no start-export button found; screenshot saved");
    await page.keyboard.press("Escape");
  }
} catch (e) { log("export attempt failed:", e.message); }

fs.writeFileSync(`${OUT}/console.log`, consoleLines.join("\n"));
fs.writeFileSync(`${OUT}/report.json`, JSON.stringify({ done, approvals, timelineEmpty: timelineEmptyNow, banner: bannerText.slice(0, 300) }, null, 2));
log("artifacts in", OUT);
log(done ? "E2E RESULT: agent run completed" : "E2E RESULT: timeout / incomplete");

await browser.close();
