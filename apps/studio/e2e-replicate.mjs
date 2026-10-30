import { chromium } from "@playwright/test";
import fs from "node:fs";

const BASE = "http://localhost:5391";
const SRC = "/Users/hamza/Desktop/k.o.v.e/evaluation-files/High Quality Steph Curry Clips for Edits! (2024-25).mp4";
const REF = "/Users/hamza/Desktop/k.o.v.e/evaluation-files/reference videos (priority, needs to look LIKE or BETTER than)/steph curry.MP4";
const OUT = "/var/folders/xg/79c6mh7n3jl31j6s_j41yl6r0000gp/T/opencode/replicate";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

const browser = await chromium.launch({ headless: false, args: ["--autoplay-policy=no-user-gesture-required", "--remote-debugging-port=9222"] });
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
page.on("response", (r) => { if (/\/api\/omni\/.*chat\/completions/.test(r.url())) log("[net]", r.status()); });
page.on("pageerror", (e) => log("[pageerror]", e.message.slice(0, 200)));

await page.goto(`${BASE}/#new`, { waitUntil: "domcontentloaded" });
await sleep(5000);
try { await page.getByRole("button", { name: "Skip Tour" }).waitFor({ state: "visible", timeout: 6000 }); await page.getByRole("button", { name: "Skip Tour" }).click(); } catch {}
await page.evaluate(() => document.querySelectorAll("div.fixed.inset-0.z-\\[100\\]").forEach((el) => el.remove()));

let composer = page.getByRole("textbox", { name: "AI edit request" });
for (let i = 0; i < 4 && !(await composer.isVisible().catch(() => false)); i++) {
  await page.getByRole("button", { name: "AI Editor chat" }).click().catch(() => {});
  await sleep(3000);
}
log("chat ready");

const dismiss = async () => {
  const b = page.locator("div.fixed.inset-0.z-\\[100\\]");
  if (!(await b.count())) return;
  await page.keyboard.press("Escape").catch(() => {}); await sleep(500);
  if (await b.count()) { await page.evaluate(() => document.querySelectorAll("div.fixed.inset-0.z-\\[100\\]").forEach((el) => el.remove())); log("modal removed"); }
};

// import source
log("importing source...");
await page.locator('input[aria-label="Import media"]').setInputFiles([SRC]);
for (let i = 0; i < 90; i++) {
  if (/High Quality Steph Curry/i.test(await page.locator("body").innerText().catch(() => ""))) break;
  await sleep(2000);
}
log("source imported");

// attach reference, wait for chip
await page.locator('input[aria-label="Attach reference video"]').setInputFiles(REF);
for (let i = 0; i < 120; i++) {
  const chip = await page.getByText("steph curry.MP4", { exact: false }).first().isVisible().catch(() => false);
  const intents = await page.getByRole("group", { name: "Reference intent" }).isVisible().catch(() => false);
  if (chip && intents) break;
  await sleep(2000);
}
log("reference attached");

// force Replicate intent
const rep = page.getByRole("group", { name: "Reference intent" }).getByRole("button", { name: "Replicate" });
await rep.click({ timeout: 5000 });
log("intent = Replicate (aria-pressed:", await rep.getAttribute("aria-pressed"), ")");

// force auto-confirm + expose store diagnostics
await page.evaluate(async () => {
  const st = await import("/src/stores/settings-store.ts");
  st.useSettingsStore.getState().setAgentAutoConfirm(true);
  st.useSettingsStore.getState().setAgentDryRun(false);
  window.__koveSettings = st.useSettingsStore;
  const cs = await import("/src/stores/chat-store.ts");
  window.__koveChat = cs.useChatStore;
  const pj = await import("/src/stores/project-store.ts");
  window.__koveProject = pj.useProjectStore;
});
log("autoConfirm forced ON; stores exposed");

await dismiss();
await composer.fill("Replicate the attached reference video 1:1 with my footage: identical shot structure, pacing and rhythm. Keep it at 25 seconds for TikTok, energetic hype tone. Keep the best scoring moments and crowd reactions; drop slow intros and dead air.");
await sleep(400);
for (let i = 0; i < 12; i++) {
  await page.evaluate(() =>
    document.querySelectorAll("div.fixed.inset-0").forEach((el) => {
      const cs = getComputedStyle(el);
      if (cs.pointerEvents === "auto" || el.querySelector(".bg-black")) el.remove();
    }),
  ).catch(() => {});
  try {
    await page.getByRole("button", { name: "Send" }).click({ timeout: 4000 });
    break;
  } catch (e) {
    log("send click retry", i + 1, e.message.slice(0, 80));
    await sleep(1000);
  }
}
log("SENT");

// watch until timeline populated + agent idle
let lastSnap = "", stable = Date.now(), done = false, lastBeat = 0;
const deadline = Date.now() + 20 * 60 * 1000;
while (Date.now() < deadline && !done) {
  await dismiss();
  const body = await page.locator("body").innerText().catch(() => "");
  const idx = body.lastIndexOf("AI Editor");
  const snap = idx >= 0 ? body.slice(idx, idx + 3500) : "";
  if (snap && snap !== lastSnap) {
    lastSnap = snap; stable = Date.now();
    const lines = snap.split("\n").filter(Boolean);
    const interesting = lines.filter((l) => /measur|rebuild|done|error|fail|shot|plan|edit|export|captions|beat/i.test(l)).slice(-4);
    log("chat:", JSON.stringify(interesting.join(" | ")).slice(0, 500));
  }
  try {
    const st = await page.getByRole("status").first().innerText({ timeout: 300 });
    if (st) { stable = Date.now(); log("status:", st.slice(0, 150)); }
  } catch {}
  // heartbeat: real app state every ~15s
  if (Date.now() - lastBeat > 15000) {
    lastBeat = Date.now();
    try {
      const st = await page.evaluate(async () => {
        const src = await (await fetch("/src/components/editor/chat/ChatPanel.tsx")).text();
        const chatUrl = [...src.matchAll(/from\s+"([^"]*chat-store[^"]*)"/g)][0][1];
        const cm = await import(chatUrl);
        const s = cm.useChatStore.getState();
        const last = s.messages?.at(-1);
        return {
          status: s.status,
          pending: s.pendingConfirm?.call?.name ?? null,
          notice: last?.notice ?? null,
          tools: (last?.toolCalls ?? []).map((t) => `${t.name}:${t.status}`),
          msgs: s.messages?.length,
        };
      });
      log("state:", JSON.stringify(st));
      if (st.pending) {
        const btn = page.getByRole("button", { name: /approve|allow|confirm|proceed|accept|yes|run|continue/i }).first();
        if (await btn.isVisible().catch(() => false)) { await btn.click().catch(() => {}); log("clicked approval:", st.pending); }
      }
    } catch (e) { log("heartbeat err:", e.message.slice(0, 150)); }
  }

  const empty = await page.getByText("Your timeline is empty").isVisible().catch(() => false);
  const busy = await page.getByRole("button", { name: "Stop" }).isVisible().catch(() => false);
  if (!empty && !busy && Date.now() - stable > 20000 && Date.now() - t0 > 120000) {
    done = true; log("DONE: timeline populated and agent idle");
  }
  await sleep(3000);
}
log("loop end done =", done);
await page.screenshot({ path: `${OUT}/timeline.png` });

// playback verification: seek -> play -> frame diff
const crypto = await import("node:crypto");
const biggestCanvas = async () => {
  let best = null, bestA = 0;
  for (const c of await page.locator("canvas").all()) {
    const bb = await c.boundingBox().catch(() => null);
    if (bb && bb.width * bb.height > bestA) { bestA = bb.width * bb.height; best = c; }
  }
  return best;
};
try {
  const zoom = page.locator('[aria-label="Timeline zoom"]').first();
  const box = await zoom.locator("xpath=ancestor::*[2]").boundingBox();
  if (box) {
    await page.mouse.click(box.x + box.width * 0.3, box.y + 4);
    await sleep(2500);
  }
  const c = await biggestCanvas();
  const hash = async (n) => {
    const buf = await c.screenshot({ path: `${OUT}/${n}.png` });
    return crypto.createHash("md5").update(buf).digest("hex");
  };
  const hA = await hash("play-a");
  const timeBefore = await page.locator("text=/^\\d{2}:\\d{2}:\\d{2} \\/").first().innerText().catch(() => "?");
  const playBtn = page.getByRole("button", { name: /^Play$/ }).first();
  await playBtn.click({ timeout: 5000 });
  log("Play clicked; time before:", JSON.stringify(timeBefore));
  await sleep(4000);
  const hB = await hash("play-b");
  const timeAfter = await page.locator("text=/^\\d{2}:\\d{2}:\\d{2} \\/").first().innerText().catch(() => "?");
  log("PLAYBACK:", hA !== hB ? "PASS (frames advancing)" : "FAIL (static frame)", "time:", JSON.stringify(timeBefore), "->", JSON.stringify(timeAfter));
  await playBtn.click({ timeout: 5000 }).catch(() => {}); // pause at a mid frame for the user
} catch (e) { log("playback check failed:", e.message); }

const banner = await page.locator("header, [role=banner]").first().innerText().catch(() => "");
const body2 = await page.locator("body").innerText().catch(() => "");
const idx2 = body2.lastIndexOf("AI Editor");
fs.writeFileSync(`${OUT}/transcript.txt`, idx2 >= 0 ? body2.slice(idx2) : body2);
log("BANNER:", JSON.stringify(banner.slice(0, 200)));
log("ARTIFACTS:", OUT);
log("Browser left OPEN for you — window is live.");

// keep browser + process alive
await new Promise(() => {});
