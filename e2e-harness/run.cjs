// Full-flow driver: welcome -> import 4 media -> brief -> Kreate ->
// director turn (stub) -> materialized timeline -> screenshots + DOM probe.
// Run: NODE_PATH=$HARNESS/tools/node_modules node run.cjs
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");

const HARNESS = process.env.HARNESS_HOME || "/home/user/kove-e2e-harness";
const MEDIA = path.join(HARNESS, "media");
const SHOTS = path.join(HARNESS, "shots");
const APP_URL = "http://localhost:5173/";

const SETTINGS = {
  version: 8,
  defaultLlmProvider: "openai-compatible",
  llmModel: "mock-director-1",
  llmBaseUrl: "http://127.0.0.1:8799/v1",
  agentAutoConfirm: true,
  agentDryRun: false,
};

function shotLogLine(page, lines) {
  page.on("console", (m) => lines.push(`[console:${m.type()}] ${m.text().slice(0, 300)}`));
  page.on("pageerror", (e) => lines.push(`[pageerror] ${String(e).slice(0, 300)}`));
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const lines = [];
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
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
  });
  await context.addInitScript(([settings]) => {
    try {
      localStorage.setItem("kove-advanced-settings", JSON.stringify({ state: settings, version: 8 }));
    } catch {}
  }, [SETTINGS]);
  const page = await context.newPage();
  shotLogLine(page, lines);
  page.setDefaultTimeout(150_000);

  // 1. Welcome entry.
  await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
  await page.getByText(/Ready to kreate\?/).first().waitFor({ timeout: 90_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(SHOTS, "01-welcome.png") });
  console.log("✓ welcome rendered");

  // 2. Upload media + brief.
  const files = ["gameplay-a.webm", "talking-b.webm", "broll-c.webm", "music-bed.wav"].map((f) =>
    path.join(MEDIA, f),
  );
  const fileInputs = await page.$$('input[type="file"]');
  console.log(`file inputs: ${fileInputs.length}`);
  await fileInputs[0].setInputFiles(files);
  await page.getByText("music-bed.wav").waitFor();
  await page
    .getByPlaceholder(/hype reel/)
    .fill(
      "Cut a 14-second hype montage from my clips: b-roll hook, then gameplay, then me talking. Music bed under it, a bold title up top to open, a lower-third to close.",
    );
  await page.screenshot({ path: path.join(SHOTS, "02-uploaded.png") });
  console.log("✓ media staged + brief typed");

  // 3. Kreate.
  await page.getByRole("button", { name: "Kreate" }).click();
  await page.waitForURL(/#\/editor/, { timeout: 150_000 });
  console.log("✓ navigated to editor — director turn in flight");

  // Onboarding tour can appear at any point around editor entry: watchdog.
  const tourWatchdog = setInterval(() => {
    page
      .getByRole("button", { name: /skip tour/i })
      .first()
      .click({ timeout: 400 })
      .then(() => console.log("✓ tour dismissed"))
      .catch(() => {});
  }, 1200);

  await page.getByText(/Done — I cut your 14-second montage/).waitFor({ timeout: 150_000 });
  console.log("✓ assistant final message visible — turn complete");
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(SHOTS, "03-chat-complete.png") });

  // 4. Probe the timeline for the materialized plan.
  const probe = await page.evaluate(() => {
    const text = document.body.innerText;
    const clips = document.querySelectorAll("[data-clip-id], [class*='timeline-clip'], [class*='TimelineClip']");
    const trackLabels = ["Music", "SFX", "Video 1", "Text"];
    const timelineText = (() => {
      const els = document.querySelectorAll("[class*='timeline'], [data-testid*='imeline']");
      return Array.from(els)
        .map((e) => e.innerText || "")
        .join("|")
        .slice(0, 500);
    })();
    const clipsByName = ["gameplay-a.webm", "talking-b.webm", "broll-c.webm", "music-bed.wav"].filter((n) =>
      text.includes(n),
    );
    return {
      clipNodeCount: clips.length,
      trackLabelHits: trackLabels.filter((l) => text.includes(l)),
      clipsByName,
      hasMusicTrack: text.includes("Music"),
      hasFailedApply: text.includes("EDIT_PLAN_APPLY_FAILED"),
      hasGate: text.includes("unknown_audio_media"),
      hasError: text.includes("Error") && text.includes("plan"),
      titleTextInDom: text.includes("MONET CUTS IT"),
      lowerThirdInDom: text.includes("zero timeline work"),
      timelineTextSample: timelineText,
      bodyTextSample: text.slice(0, 400),
    };
  });
  console.log("PROBE:", JSON.stringify(probe, null, 2));

  await page.screenshot({ path: path.join(SHOTS, "04-timeline.png") });

  // 5. Jab the playhead + play a beat for a live preview frame.
  await page.keyboard.press("Home");
  await page.waitForTimeout(400);
  await page.keyboard.press("Space");
  await page.waitForTimeout(1300);
  await page.keyboard.press("Space");
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, "05-preview.png") });

  const errors = lines.filter((l) => l.startsWith("[pageerror]") || l.includes("console:error"));
  fs.writeFileSync(path.join(SHOTS, "console.log"), lines.join("\n"));
  console.log(`console lines: ${lines.length}`);
  console.log(`signal errors: ${errors.length ? errors.slice(0, 5).join("\n") : "none"}`);
  clearInterval(tourWatchdog);
  await browser.close();
})().catch(async (e) => {
  console.error("DRIVER FAILED:", e);
  process.exit(1);
});
