import { chromium } from "@playwright/test";

const REF = process.env.REF_FILE ??
  "/Users/hamza/Desktop/unedited files/reference videos (priority, needs to look LIKE or BETTER than)/steph curry.MP4";
const BASE = process.env.BASE_URL ?? "http://localhost:5391";
const OUT = "/tmp/freeze-profile.json";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: false, args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 1680, height: 1000 } });

await context.addInitScript(() => {
  window.__hb = [];
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    window.__hb.push(now - last);
    last = now;
  }, 200);
  window.__longTasks = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__longTasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
    }).observe({ entryTypes: ["longtask"] });
  } catch { /* unsupported */ }
});

const page = await context.newPage();
page.on("console", (m) => {
  const t = m.text();
  console.log(`[console:${m.type()}] ${t.slice(0, 300)}`);
});
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message.slice(0, 300)}`));
page.on("crash", () => console.log("[PAGE CRASH]"));

console.log("goto", `${BASE}/#new`);
await page.goto(`${BASE}/#new`, { waitUntil: "domcontentloaded" });
await sleep(4000);

// dismiss first-run tour / anything in the way
const skipTour = page.getByRole("button", { name: "Skip Tour" });
if (await skipTour.isVisible().catch(() => false)) {
  await skipTour.click({ timeout: 10000 }).catch((e) => console.log("skip tour click failed:", e.message));
} else {
  try {
    await skipTour.waitFor({ state: "visible", timeout: 12000 });
    await skipTour.click({ timeout: 10000 }).catch((e) => console.log("skip tour click failed:", e.message));
  } catch { console.log("no tour modal"); }
}
await sleep(800);
const overlay = page.locator("div.fixed.inset-0.z-\\[100\\]");
if (await overlay.count()) {
  console.log("overlay still present, pressing Escape / clicking dismissers");
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(500);
  for (const label of ["Skip", "Close", "Done", "Back", "Got it"]) {
    if (!(await overlay.count())) break;
    const b = page.getByRole("button", { name: label, exact: true }).first();
    if (await b.isVisible().catch(() => false)) { await b.click({ timeout: 3000 }).catch(() => {}); await sleep(400); }
  }
  if (await overlay.count()) {
    await page.evaluate(() => document.querySelectorAll("div.fixed.inset-0.z-\\[100\\]").forEach((el) => el.remove()));
    console.log("force-removed overlay");
  }
}

const aiTab = page.getByRole("button", { name: /AI Generate/ }).first();
await aiTab.waitFor({ state: "visible", timeout: 20000 }).catch(async () => {
  console.log("AI tab not found; page text sample:");
  console.log((await page.locator("body").innerText()).slice(0, 2000));
  throw new Error("AI Generate tab not reachable");
});
await aiTab.click();
await sleep(800);

const mirrorCard = page.getByText("Mirror Reference 1:1", { exact: false }).first();
await mirrorCard.waitFor({ state: "visible", timeout: 10000 });
await mirrorCard.click();
await sleep(500);

const fileInput = page.locator('input[aria-label="Reference video"]');
await fileInput.waitFor({ state: "attached", timeout: 10000 });

// No warm step anymore: OpenCV never loads on the main thread (worker client).
console.log("attaching", REF);

await fileInput.setInputFiles(REF);

const t0 = Date.now();
let lastStatus = "";
let sawUnresponsivePoll = false;
const deadline = t0 + 180000;
let done = false;
while (Date.now() < deadline && !done) {
  let status = null;
  try {
    status = await Promise.race([
      page.getByRole("status").first().textContent().catch(() => null),
      new Promise((_, rej) => setTimeout(() => rej(new Error("poll-hang")), 5000)),
    ]);
  } catch {
    if (!sawUnresponsivePoll) { console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] MAIN THREAD NOT RESPONDING (status poll hung)`); sawUnresponsivePoll = true; }
    await sleep(1000);
    continue;
  }
  if (status && status !== lastStatus) {
    console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] status: ${status}`);
    lastStatus = status;
    if (/shots measured|failed|cancelled/i.test(status)) done = true;
  }
  if (await page.getByText(/FPS unknown/i).first().isVisible().catch(() => false)) {
    console.log("FPS prompt appeared; filling 30000/1001");
    await page.getByLabel("FPS numerator").fill("30000");
    await page.getByLabel("FPS denominator").fill("1001");
    await page.getByRole("button", { name: /Analyze using selected FPS/ }).click();
  }
  await sleep(400);
}

console.log(`loop end after ${((Date.now() - t0) / 1000).toFixed(1)}s done=${done}`);
console.log("final status:", lastStatus || "(none)");

const heartbeats = await page.evaluate(() => window.__hb ?? []).catch(() => []);
const longTasks = await page.evaluate(() => window.__longTasks ?? []).catch(() => []);
const maxGap = heartbeats.length ? Math.max(...heartbeats) : 0;
console.log("max main-thread heartbeat gap (ms):", Math.round(maxGap));
console.log("long tasks >50ms:", JSON.stringify(longTasks.filter((t) => t.dur > 50).slice(0, 30)));
console.log(done && !sawUnresponsivePoll && maxGap < 3000 ? "RESULT: PASS (measurement completed, tab stayed responsive)" : "RESULT: FAIL");

await browser.close();
