// Effect-rendering proof: plan applies hue(rotation=140) to gameplay.
// Compare the LIVE preview canvas at t=5.0 (mid-gameplay) against the RAW
// source frame at the equivalent source time (inPoint 3 + 2.0 = 5.0 into
// gameplay-a.webm), decoded independently in a hidden <video> element.
// If the preview's channel means differ by roughly the hue-rotation basis,
// the effect is demonstrably rendered (not merely stored).
const { chromium } = require("playwright-core");
const path = require("path");
const HARNESS = process.env.HARNESS_HOME || "/home/user/kove-e2e-harness";
const SETTINGS = { version: 8, defaultLlmProvider: "openai-compatible", llmModel: "mock-director-1", llmBaseUrl: "http://127.0.0.1:8799/v1", agentAutoConfirm: true, agentDryRun: false };

(async () => {
  const browser = await chromium.launch({ executablePath: "/usr/local/bin/google-chrome", headless: true,
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--mute-audio","--autoplay-policy=no-user-gesture-required","--enable-unsafe-swiftshader"] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addInitScript(([s]) => { try { localStorage.setItem("kove-advanced-settings", JSON.stringify({ state: s, version: 8 })); } catch {} }, [SETTINGS]);
  const page = await context.newPage();
  page.setDefaultTimeout(150000);
  await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
  await page.getByText(/Ready to kreate\?/).first().waitFor({ timeout: 90000 });
  const files = ["gameplay-a.webm","talking-b.webm","broll-c.webm","music-bed.wav"].map((f) => path.join(HARNESS,"media",f));
  await (await page.$$('input[type="file"]'))[0].setInputFiles(files);
  await page.getByText("music-bed.wav").waitFor();
  await page.getByPlaceholder(/hype reel/).fill("Cut a 14-second hype montage from my clips: b-roll hook, then gameplay, then me talking. Music bed under it, a bold title up top to open, a lower-third to close.");
  await page.getByRole("button", { name: "Kreate" }).click();
  await page.waitForURL(/#\/editor/, { timeout: 150000 });
  const wd = setInterval(() => { page.getByRole("button", { name: /skip tour/i }).first().click({ timeout: 400 }).catch(() => {}); }, 1200);
  await page.getByText(/Done — I cut your 14-second montage/).waitFor({ timeout: 150000 });

  // Pause exactly at t=5.0 on the preview.
  await page.keyboard.press("Home");
  await page.waitForTimeout(400);
  await page.keyboard.press("Space");
  await page.waitForFunction(
    ([tt]) => {
      const el = Array.from(document.querySelectorAll("div,span")).find((n) =>
        /^\d{2}:\d{2}:\d{2}\s*\/\s*\d{2}:\d{2}:\d{2}$/.test((n.textContent || "").trim()));
      if (!el) return false;
      const m = (el.textContent || "").trim().match(/(\d{2}):(\d{2}):(\d{2})/);
      return Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 100 >= tt - 0.05;
    },
    [5.0],
    { polling: 40, timeout: 30000 },
  );
  await page.keyboard.press("Space");
  await page.waitForTimeout(500);

  // aligned per-pixel capture for both frames (same crop, same grid)
  const grabGrid = (ctx, w, h) => {
    const img = ctx.getImageData(Math.floor(w * 0.08), Math.floor(h * 0.08), Math.floor(w * 0.84), Math.floor(h * 0.84));
    const out = [];
    for (let i = 0; i < img.data.length; i += 4 * 97) out.push(img.data[i], img.data[i + 1], img.data[i + 2]);
    return out;
  };
  const compareGrids = (a, b) => {
    let dr = 0, dg = 0, db = 0, n = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i += 3) { dr += Math.abs(a[i] - b[i]); dg += Math.abs(a[i + 1] - b[i + 1]); db += Math.abs(a[i + 2] - b[i + 2]); n++; }
    return { meanAbsDeltaR: +(dr / n).toFixed(1), meanAbsDeltaG: +(dg / n).toFixed(1), meanAbsDeltaB: +(db / n).toFixed(1), samples: n };
  };

  const out = await page.evaluate(async (fnsSrc) => {
    const fns = new Function("return " + fnsSrc)(); const { grabGrid, compareGrids } = fns;
    // 1) live preview canvas
    const preview = Array.from(document.querySelectorAll("canvas"))
      .filter((c) => { const r = c.getBoundingClientRect(); return r.width > 80 && r.height > 40; })[0];
    if (!preview) return { err: "no preview canvas" };
    const pctx = preview.getContext("2d", { willReadFrequently: true });
    if (!pctx) return { err: "no 2d ctx" };
    const clock = (() => {
      const el = Array.from(document.querySelectorAll("div,span")).find((n) =>
        /^\d{2}:\d{2}:\d{2}\s*\/\s*\d{2}:\d{2}:\d{2}$/.test((n.textContent || "").trim()));
      const m = el ? (el.textContent || "").trim().match(/(\d{2}):(\d{2}):(\d{2})/) : null;
      return m ? Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 100 : null;
    })();
    const previewGrid = grabGrid(pctx, preview.width, preview.height);

    // 2) raw source frame via the project's media blob
    const psUrl = performance.getEntriesByType("resource").map((r) => r.name).find((n) => n.includes("/src/stores/project-store.ts"));
    const storeMod = await import(psUrl);
    const project = storeMod.useProjectStore.getState().project;
    const item = project.mediaLibrary.items.find((i) => /gameplay-a/.test(i.name));
    if (!item) return { err: "no media item" };
    const blobSrc = item.blob ?? item.sourceFile ?? null;
    const blobUrl = blobSrc instanceof Blob ? URL.createObjectURL(blobSrc) : (item.url || item.blobUrl || item.src);
    if (!blobUrl) return { err: "no blob url", keys: Object.keys(item) };
    const vid = document.createElement("video");
    vid.muted = true; vid.preload = "auto"; vid.src = blobUrl;
    await new Promise((res, rej) => { vid.onloadedmetadata = res; vid.onerror = () => rej(new Error("video load failed")); });
    const target = Math.min((item.duration ?? 12) - 0.5, (clock ?? 5) + 3 - 3); // inPoint 3 => source == preview time
    vid.currentTime = Math.max(0, target);
    await new Promise((res) => { vid.onseeked = res; setTimeout(res, 3000); });
    const vc = document.createElement("canvas");
    vc.width = vid.videoWidth; vc.height = vid.videoHeight;
    const vctx = vc.getContext("2d", { willReadFrequently: true });
    vctx.drawImage(vid, 0, 0);
    const rawGrid = grabGrid(vctx, vc.width, vc.height);
    vid.remove();
    return { clock, rawSourceTime: target, channelDelta: compareGrids(previewGrid, rawGrid), verdict: "delta ~0 => effect NOT rendered; delta >> 20 => effect RENDERED" };
  }, ("({grabGrid:" + grabGrid.toString() + ",compareGrids:" + compareGrids.toString() + "})"));

  console.log(JSON.stringify(out, null, 1));
  clearInterval(wd);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
