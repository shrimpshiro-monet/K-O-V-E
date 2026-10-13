// Runtime ground-truth probe (does not rely on screenshots):
//  1. timeline DOM: are transition markers present? where?
//  2. canvas luminance sweep across the two junction windows
//     (crossfade around 3.0s, dipToBlack around 9.5s)
//  3. glow: purple pixel fraction on gameplay vs the raw source pixels
//  4. lower-third text clip: its rendered size/position vs plan intent
//  5. store truth via IndexedDB persisted project (if reachable)
// Run: NODE_PATH=$HARNESS/tools/node_modules node probe-render.cjs
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");

const HARNESS = process.env.HARNESS_HOME || "/home/user/kove-e2e-harness";
const SHOTS = path.join(HARNESS, "probe");
const APP_URL = "http://localhost:5173/";
const SETTINGS = {
  version: 8,
  defaultLlmProvider: "openai-compatible",
  llmModel: "mock-director-1",
  llmBaseUrl: "http://127.0.0.1:8799/v1",
  agentAutoConfirm: true,
  agentDryRun: false,
};

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({
    executablePath: "/usr/local/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--mute-audio",
      "--autoplay-policy=no-user-gesture-required", "--enable-unsafe-swiftshader"],
  });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addInitScript(([settings]) => {
    try { localStorage.setItem("kove-advanced-settings", JSON.stringify({ state: settings, version: 8 })); } catch {}
  }, [SETTINGS]);
  const page = await context.newPage();
  page.setDefaultTimeout(150_000);
  const consoleLines = [];
  page.on("console", (m) => consoleLines.push(`[${m.type()}] ${m.text().slice(0, 400)}`));
  page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${String(e).slice(0, 400)}`));

  await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
  await page.getByText(/Ready to kreate\?/).first().waitFor({ timeout: 90_000 });
  const files = ["gameplay-a.webm", "talking-b.webm", "broll-c.webm", "music-bed.wav"].map((f) => path.join(HARNESS, "media", f));
  await (await page.$$('input[type="file"]'))[0].setInputFiles(files);
  await page.getByText("music-bed.wav").waitFor();
  await page.getByPlaceholder(/hype reel/).fill("Cut a 14-second hype montage from my clips: b-roll hook, then gameplay, then me talking. Music bed under it, a bold title up top to open, a lower-third to close.");
  await page.getByRole("button", { name: "Kreate" }).click();
  await page.waitForURL(/#\/editor/, { timeout: 150_000 });
  const tourWatchdog = setInterval(() => {
    page.getByRole("button", { name: /skip tour/i }).first().click({ timeout: 400 }).catch(() => {});
  }, 1200);
  await page.getByText(/Done — I cut your 14-second montage/).waitFor({ timeout: 150_000 });
  console.log("✓ plan materialized");

  // ---- 1. transition markers in the timeline DOM ----
  const markers = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll("[class*='ransition'], [data-testid*='ransition']"));
    return els.slice(0, 12).map((e) => {
      const r = e.getBoundingClientRect();
      return { cls: String(e.className).slice(0, 60), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), text: (e.textContent || "").slice(0, 24) };
    });
  });
  console.log("timeline transition markers:", JSON.stringify(markers, null, 1));

  // ---- 2. find the preview canvas + read its pixels ----
  const canvasInfo = await page.evaluate(() => {
    const cvs = Array.from(document.querySelectorAll("canvas")).map((c) => {
      const r = c.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, iw: c.width, ih: c.height };
    });
    return cvs;
  });
  console.log("canvases:", JSON.stringify(canvasInfo));

  // Luminance sampler: mean + stddev of the central canvas region at time t.
  // IMPORTANT: seek by clicking the ruler tick is unreliable -> we poll fast
  // playback; but for stationary analysis we instead pause at neighbors.
  const sweep = async (label, seconds) => {
    // brute precise seek: use Home then play to t with the centisecond clock
    const result = [];
    for (const t of seconds) {
      // rewind
      await page.keyboard.press("Home");
      await page.waitForTimeout(260);
      await page.keyboard.press("Space");
      // poll to (t - 0.05); poll@40ms, then pause
      const crossed = await page
        .waitForFunction(
          ([tt]) => {
            const el = Array.from(document.querySelectorAll("div,span")).find((n) =>
              /^\d{2}:\d{2}:\d{2}\s*\/\s*\d{2}:\d{2}:\d{2}$/.test((n.textContent || "").trim()),
            );
            if (!el) return false;
            const m = (el.textContent || "").trim().match(/(\d{2}):(\d{2}):(\d{2})/);
            const s = Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 100;
            return s >= tt - 0.05;
          },
          [t],
          { polling: 40, timeout: 60_000 },
        )
        .then(() => true)
        .catch(() => false);
      await page.keyboard.press("Space");
      await page.waitForTimeout(420);
      const read = await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll("div,span")).find((n) =>
          /^\d{2}:\d{2}:\d{2}\s*\/\s*\d{2}:\d{2}:\d{2}$/.test((n.textContent || "").trim()),
        );
        const m = el ? (el.textContent || "").trim().match(/(\d{2}):(\d{2}):(\d{2})/) : null;
        const clock = m ? Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 100 : null;
        const cvs = Array.from(document.querySelectorAll("canvas"))
          .filter((c) => { const r = c.getBoundingClientRect(); return r.width > 80 && r.height > 40; })
          .sort((a, b) => b.width * b.height - a.width * a.height)[0];
        if (!cvs) return { clock, err: "no canvas" };
        const ctx = cvs.getContext("2d", { willReadFrequently: true });
        if (!ctx) return { clock, err: "no 2d ctx" };
        const { width: w, height: h } = cvs;
        const img = ctx.getImageData(Math.floor(w * 0.08), Math.floor(h * 0.08), Math.floor(w * 0.84), Math.floor(h * 0.84)).data;
        let sum = 0, sq = 0, n = 0, purple = 0;
        for (let i = 0; i < img.length; i += 4 * 64) {
          const r = img[i], g = img[i + 1], b = img[i + 2];
          const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          sum += y; sq += y * y; n++;
          if (b > 80 && r > 60 && b > g * 1.4 && r > g * 1.25) purple++;
        }
        const mean = sum / n;
        const sd = Math.sqrt(sq / n - mean * mean);
        return { clock, mean: +mean.toFixed(1), sd: +sd.toFixed(1), purpleFrac: +(purple / n).toFixed(4) };
      });
      result.push({ target: t, ...read, crossed });
      console.log(`  ${label} t=${t}:`, JSON.stringify(result[result.length - 1]));
    }
    return result;
  };

  console.log("-- crossfade window sweep (expect blend/dip in [2.55,3.0]) --");
  const cross = await sweep("XF", [2.2, 2.55, 2.7, 2.85, 3.0, 3.15]);
  console.log("-- dip window sweep (expect sharp V to black in [~9.05,9.5]) --");
  const dip = await sweep("DIP", [8.6, 8.9, 9.05, 9.2, 9.35, 9.5, 9.65]);
  console.log("-- glow probe on gameplay (expect purple halo fraction > 0) --");
  const glow = await sweep("GLOW", [4.0, 5.0, 6.0]);

  fs.writeFileSync(path.join(SHOTS, "sweep.json"), JSON.stringify({ cross, dip, glow }, null, 2));
  const tb = consoleLines.filter((l) => l.includes("TransitionBridge") || l.includes("pageerror"));
  console.log("bridge/pageerror console lines:", tb.length ? tb.slice(0, 10) : "none");
  clearInterval(tourWatchdog);
  await browser.close();
})().catch((e) => { console.error("PROBE FAILED:", e); process.exit(1); });
