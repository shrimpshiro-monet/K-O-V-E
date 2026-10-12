// Frame-accurate render verification: scrubs to each effect moment and
// captures the player canvas region into $HARNESS/frames/ for pixel analysis.
// Plan anchors (14s): title 0.3-3.2 | crossfade ends ~3.0 | dip~9.0-9.45 |
// lower-third 9.9-13.9 | talking tail 13.95 | glow on gameplay (3.0-9.5).
// Run: NODE_PATH=$HARNESS/tools/node_modules node verify-render.cjs
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");

const HARNESS = process.env.HARNESS_HOME || "/home/user/kove-e2e-harness";
const SHOTS = path.join(HARNESS, "frames");
const APP_URL = "http://localhost:5173/";

const SETTINGS = {
  version: 8,
  defaultLlmProvider: "openai-compatible",
  llmModel: "mock-director-1",
  llmBaseUrl: "http://127.0.0.1:8799/v1",
  agentAutoConfirm: true,
  agentDryRun: false,
};

const playerRegion = { x: 530, y: 80, width: 620, height: 470 };

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({
    executablePath: "/usr/local/bin/google-chrome",
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--mute-audio",
      "--autoplay-policy=no-user-gesture-required",
      "--enable-unsafe-swiftshader",
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addInitScript(([settings]) => {
    try {
      localStorage.setItem("kove-advanced-settings", JSON.stringify({ state: settings, version: 8 }));
    } catch {}
  }, [SETTINGS]);
  const page = await context.newPage();
  page.setDefaultTimeout(150_000);

  // Recreate the exact planned project via the real product path.
  await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
  await page.getByText(/Ready to kreate\?/).first().waitFor({ timeout: 90_000 });
  const files = ["gameplay-a.webm", "talking-b.webm", "broll-c.webm", "music-bed.wav"].map((f) =>
    path.join(HARNESS, "media", f),
  );
  const fileInputs = await page.$$('input[type="file"]');
  await fileInputs[0].setInputFiles(files);
  await page.getByText("music-bed.wav").waitFor();
  await page
    .getByPlaceholder(/hype reel/)
    .fill(
      "Cut a 14-second hype montage from my clips: b-roll hook, then gameplay, then me talking. Music bed under it, a bold title up top to open, a lower-third to close.",
    );
  await page.getByRole("button", { name: "Kreate" }).click();
  await page.waitForURL(/#\/editor/, { timeout: 150_000 });

  const tourWatchdog = setInterval(() => {
    page
      .getByRole("button", { name: /skip tour/i })
      .first()
      .click({ timeout: 400 })
      .catch(() => {});
  }, 1200);

  await page.getByText(/Done — I cut your 14-second montage/).waitFor({ timeout: 150_000 });
  console.log("✓ plan materialized — beginning frame verification");

  // Derive time->pixel scale from the ruler's own tick labels.
  const ruler = await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll("span,div")).filter(
      (el) => el.childElementCount === 0 && /^\d{2}:\d{2}$/.test((el.textContent || "").trim()),
    );
    const at = (t) => {
      const el = spans.find((s) => (s.textContent || "").trim() === t);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x };
    };
    const a = at("00:00");
    const secs = [5, 10, 15, 20, 25, 30]
      .map((s) => ({ s, m: at("00:" + String(s).padStart(2, "0")) }))
      .filter((e) => e.m);
    if (!a || !secs.length) return null;
    const last = secs[secs.length - 1];
    const zero = spans.find((s) => (s.textContent || "").trim() === "00:00");
    return {
      x0: a.x,
      pxPerSec: (last.m.x - a.x) / last.s,
      tickY: zero ? zero.getBoundingClientRect().y : 0,
    };
  });
  console.log("ruler geometry:", JSON.stringify(ruler));
  if (!ruler) throw new Error("ruler geometry unresolved");

  // Player clock is MM:SS:FF (30fps). Read the actual clock element only.
  const CLOCK_EXPR = `(() => {
    const el = Array.from(document.querySelectorAll("div,span")).find((n) =>
      /^\\d{2}:\\d{2}:\\d{2}\\s*\\/\\s*\\d{2}:\\d{2}:\\d{2}$/.test((n.textContent || "").trim()),
    );
    if (!el) return null;
    const m = (el.textContent || "").trim().match(/(\\d{2}):(\\d{2}):(\\d{2})/);
    return Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 100;
  })()`;
  const readClock = () => page.evaluate(CLOCK_EXPR);
  const capture = async (t, label) => {
    await page.waitForTimeout(350);
    const name = `t-${label}s.png`;
    await page.screenshot({ path: path.join(SHOTS, name), clip: playerRegion });
    const clock = await readClock();
    console.log(`✓ captured t=${label}s -> ${name} (player clock: ${clock})`);
    captures.push({ t, name, clock });
  };

  // Honest playback: Home, then play in realtime and freeze at each anchor.
  const targets = [1.5, 2.9, 5.0, 9.49, 11.0, 13.6];
  const captures = [];
  await page.keyboard.press("Home");
  await page.waitForTimeout(500);
  const startClock = await readClock();
  console.log(`mode: realtime-playback (clock at start: ${startClock})`);
  await page.keyboard.press("Space"); // play
  const clockProbe = (target) =>
    page.waitForFunction(
      (args) => {
        const el = Array.from(document.querySelectorAll("div,span")).find((n) =>
          /^\d{2}:\d{2}:\d{2}\s*\/\s*\d{2}:\d{2}:\d{2}$/.test((n.textContent || "").trim()),
        );
        if (!el) return false;
        const m = (el.textContent || "").trim().match(/(\d{2}):(\d{2}):(\d{2})/);
        const s = Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 100;
        return s >= args[0] - 0.3;
      },
      [target],
      { polling: 60, timeout: 60_000 },
    );
  for (const t of targets) {
    const crossed = await clockProbe(t)
      .then(() => true)
      .catch(() => false);
    if (!crossed) {
      console.log(`!! never reached t=${t} — clock stuck at ${await readClock()}`);
      break;
    }
    await page.keyboard.press("Space"); // pause
    await capture(t, String(t.toFixed(2)).replace(".", "_"));
    if (t !== targets[targets.length - 1]) await page.keyboard.press("Space"); // resume
  }

  // Audio-path probe: was the music bed actually fetched into the session?
  const audioInfo = await page.evaluate(() => {
    const res = performance
      .getEntriesByType("resource")
      .map((r) => r.name)
      .filter((n) => n.includes("music-bed") || n.includes(".wav"));
    const mediaEls = document.querySelectorAll("audio, video").length;
    return { wavResourceCount: res.length, wavSample: res.slice(0, 3), mediaEls };
  });
  console.log("audio probe:", JSON.stringify(audioInfo));

  console.log(JSON.stringify(captures));
  clearInterval(tourWatchdog);
  await browser.close();
})().catch((e) => {
  console.error("VERIFY FAILED:", e);
  process.exit(1);
});
