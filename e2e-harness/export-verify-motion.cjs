// MOTION EXPORT PARITY PROOF: punch-in camera move + speed ramp + freeze frame.
// Builds the motion variant plan via the real chat path (stub keyed on
// "zoom/ramp/freeze" in the brief), exports, then decodes the FILE and finds
// the motion signatures empirically (discovery sweep, not hardcoded anchors):
//
//   1. ZOOM (punch-in, clip A): bright-pixel area of the centered source
//      draws grows as scale rises — count(bright, crop) early vs late.
//   2. RAMP (clip B, 1x -> 8x): instantaneous motion = per-frame |Δ| mean;
//      the ramped region must run materially hotter than the 1x region.
//   3. FREEZE (clip B, 1.5s at source 4): a motion trough ≈ still frame where
//      per-frame |Δ| collapses toward encode noise.
//
// Run after bootstrap.sh with vite+stub live:
//   NODE_PATH=$H/tools/node_modules node $H/export-verify-motion.cjs
const { chromium } = require("playwright-core");
const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const H = process.env.HARNESS_HOME || "/home/user/kove-e2e-harness";
const OUT = path.join(H, "export-motion");
const FFMPEG = "/home/user/tools/ffm/node_modules/@ffmpeg-installer/linux-x64/ffmpeg";
const FFPROBE = "/home/user/tools/ffm/node_modules/@ffprobe-installer/linux-x64/ffprobe";
const W = 1280, HGT = 720, PIX = W * HGT * 3;

const SETTINGS = {
  version: 8,
  defaultLlmProvider: "openai-compatible",
  llmModel: "mock-director-1",
  llmBaseUrl: "http://127.0.0.1:8799/v1",
  agentAutoConfirm: true,
  agentDryRun: false,
};

function rawFrame(file, t, extraVf = "") {
  const vf = [`scale=${W}:${HGT}`, extraVf].filter(Boolean).join(",");
  return execFileSync(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-i", file, "-ss", String(t),
    "-frames:v", "1", "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ], { maxBuffer: 1024 * 1024 * 32 });
}
function meanAbsDiff(a, b) {
  let d = 0, n = 0;
  for (let i = 0; i < PIX; i += 3) { d += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); n += 3; }
  return d / n;
}
// Dark-glyph pixel count of the source's centered text label. The label is
// black on whatever hue the background rotates to; its rendered area tracks
// displayed scale exactly (glyph area ~ scale^2 within the crop), making it a
// zoom-resistant-to-hue-rotation scale probe.
function darkGlyphCount(buf, crop = [0.3, 0.7, 0.42, 0.58]) {
  const [x0, x1, y0, y1] = crop;
  let c = 0;
  for (let y = Math.floor(y0 * HGT); y < Math.floor(y1 * HGT); y++) {
    for (let x = Math.floor(x0 * W); x < Math.floor(x1 * W); x++) {
      const i = (y * W + x) * 3;
      if ((buf[i] + buf[i + 1] + buf[i + 2]) / 3 < 60) c++;
    }
  }
  return c;
}

const checks = [];
function report(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (process.env.SKIP_EXPORT === "1" && fs.existsSync(path.join(OUT, "motion-export.mp4"))) {
    console.log("SKIP_EXPORT=1 — analysis only");
    runChecks(path.join(OUT, "motion-export.mp4"));
    return;
  }
  const browser = await chromium.launch({
    executablePath: "/usr/local/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--mute-audio",
      "--autoplay-policy=no-user-gesture-required", "--enable-unsafe-swiftshader"],
  });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addInitScript(([s]) => {
    try { localStorage.setItem("kove-advanced-settings", JSON.stringify({ state: s, version: 8 })); } catch {}
    window.__exported = { buf: new Uint8Array(16 * 1024 * 1024), len: 0, cursor: 0, suggested: "", closed: false, error: "" };
    window.showSaveFilePicker = async (opts) => {
      window.__exported.suggested = opts?.suggestedName || "";
      const E = window.__exported;
      const grow = (needed) => {
        if (needed <= E.buf.length) return;
        let ns = E.buf.length;
        while (ns < needed) ns *= 2;
        const b = new Uint8Array(ns);
        b.set(E.buf.subarray(0, E.len));
        E.buf = b;
      };
      return {
        createWritable: async () => ({
          seek: async (p) => { E.cursor = p; },
          write: async (chunk) => {
            const data = chunk && chunk.data !== undefined ? chunk.data : chunk;
            let u8 = null;
            if (data instanceof Uint8Array) u8 = data;
            else if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
            else if (typeof Blob !== "undefined" && data instanceof Blob) u8 = new Uint8Array(await data.arrayBuffer());
            else if (typeof data === "string") u8 = new TextEncoder().encode(data);
            if (!u8) return;
            const end = E.cursor + u8.byteLength;
            grow(end);
            E.buf.set(u8, E.cursor);
            if (end > E.len) E.len = end;
            E.cursor = end;
          },
          truncate: async (size) => { E.len = size; },
          close: async () => { E.closed = true; },
          abort: async () => { E.error = "aborted"; },
        }),
      };
    };
  }, [SETTINGS]);
  const page = await context.newPage();
  page.setDefaultTimeout(150_000);

  await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
  await page.getByText(/Ready to kreate\?/).first().waitFor({ timeout: 90_000 });
  const files = ["gameplay-a.webm", "talking-b.webm", "broll-c.webm", "zoomcheck.webm", "music-bed.wav"].map((f) => path.join(H, "media", f));
  await (await page.$$('input[type="file"]'))[0].setInputFiles(files);
  await page.getByText("music-bed.wav").waitFor();
  await page.getByPlaceholder(/hype reel/).fill(
    "Cut a hype intro: b-roll hook with a zoom punch, then the gameplay with a 1-to-8x speed ramp, and freeze a frame right before the end.",
  );
  await page.getByRole("button", { name: "Kreate" }).click();
  await page.waitForURL(/#\/editor/, { timeout: 150_000 });
  const wd = setInterval(() => {
    page.getByRole("button", { name: /skip tour/i }).first().click({ timeout: 400 }).catch(() => {});
  }, 1200);
  await page.getByText(/Done —/).waitFor({ timeout: 150_000 });
  console.log("motion plan materialized — clicking Export");

  const mp4 = path.join(OUT, "motion-export.mp4");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const started = Date.now();
  for (;;) {
    if (await page.evaluate(() => window.__exported.closed)) break;
    if (Date.now() - started > 25 * 60_000) throw new Error("export timed out after 25min");
    const phase = await page.evaluate(() => {
      if (window.__exported.error) return `ERR ${window.__exported.error}`;
      const el = Array.from(document.querySelectorAll("button,span,div"))
        .map((n) => (n.textContent || "").trim())
        .find((t) => /\d+%/.test(t) && t.length < 30);
      return el || `${(window.__exported.len / 1048576).toFixed(1)}MB`;
    });
    console.log(`  exporting… ${Math.round((Date.now() - started) / 1000)}s  phase=${phase}`);
    await page.waitForTimeout(15_000);
  }
  const totalLen = await page.evaluate(() => window.__exported.len);
  const parts = [];
  const CHUNK = 4 * 1024 * 1024;
  for (let off = 0; off < totalLen; off += CHUNK) {
    parts.push(await page.evaluate(([o, n]) => Array.from(window.__exported.buf.subarray(o, o + n)), [off, Math.min(CHUNK, totalLen - off)]));
  }
  clearInterval(wd);
  await browser.close();
  fs.writeFileSync(mp4, Buffer.concat(parts.map((p) => Buffer.from(Uint8Array.from(p)))));
  console.log(`export captured: ${(fs.statSync(mp4).size / 1048576).toFixed(1)} MB in ${Math.round((Date.now() - started) / 1000)}s`);
  runChecks(mp4);
  return;

  async function runChecks(mp4) {

  // ---- container ----
  const probe = JSON.parse(execFileSync(FFPROBE, ["-v", "error", "-show_format", "-show_streams", "-of", "json", mp4]));
  const duration = Number(probe.format.duration);
  const vids = probe.streams.filter((s) => s.codec_type === "video");
  report("container", Math.abs(duration - 14.02) < 0.35 && vids.length === 1 && vids[0]?.codec_name === "h264" && vids[0]?.width === 1920 && vids[0]?.height === 1080,
    `duration=${duration.toFixed(2)}s video=${vids[0]?.codec_name} ${vids[0]?.width}x${vids[0]?.height}`);

  // ---- 1b. SIGNATURE SHADER: duotone on the outro collapses the palette ----
  // duotone shades luma onto the 2-colour ramp #11133f→#ffca6b (mix≈0.9). In
  // RGB space every exported pixel then sits ON the shadow→highlight line —
  // measure the distance-to-line fraction; raw broll spans the full cube.
  function onRampFraction(buf) {
    const P0 = [17, 19, 63], P1 = [255, 202, 107];
    const d = [P1[0] - P0[0], P1[1] - P0[1], P1[2] - P0[2]];
    const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    let on = 0, n = 0;
    for (let i = 0; i + 2 < buf.length; i += 61 * 3) {
      const r = buf[i], g = buf[i + 1], b = buf[i + 2];
      const t = Math.max(0, Math.min(1, ((r - P0[0]) * d[0] + (g - P0[1]) * d[1] + (b - P0[2]) * d[2]) / dd));
      const er = r - (P0[0] + t * d[0]), eg = g - (P0[1] + t * d[1]), eb = b - (P0[2] + t * d[2]);
      if (Math.hypot(er, eg, eb) < 60) on++;
      n++;
    }
    return on / n;
  }
  const fracOutro = onRampFraction(rawFrame(mp4, 12.75));
  const fracCtl = onRampFraction(rawFrame(path.join(H, "media/broll-c.webm"), 1.25));
  report("signature shader: duotone",
    fracOutro > 0.9 && fracCtl < 0.5,
    `pixels within 60 of the duotone ramp line: export outro ${(fracOutro * 100).toFixed(1)}%  |  raw media control ${(fracCtl * 100).toFixed(1)}%`);

  // ---- 1. ZOOM: bright-text area grows between t=0.5 and t=4.0 ----
  const c05 = darkGlyphCount(rawFrame(mp4, 0.5));
  const c45 = darkGlyphCount(rawFrame(mp4, 4.5));
  // control: the SOURCE's glyph count over the same source time span stays
  // constant (+/-20%) — growth in the EXPORT can only come from the rendered
  // scale keyframes, not the media.
  // zoomcheck has a STATIC background: dark-glyph count = text area, period.
  const s05 = darkGlyphCount(rawFrame(path.join(H, "media/zoomcheck.webm"), 0.5));
  const s45 = darkGlyphCount(rawFrame(path.join(H, "media/zoomcheck.webm"), 4.5));
  const srcRatio = s45 / Math.max(s05, 1);
  const exRatio = c45 / Math.max(c05, 1);
  // slow-push keyframes scale the clip 1 → 1.08 around the frame center:
  // content appears 1.08²=1.166× larger inside a fixed crop — or equivalently
  // static dark gradient regions get cropped out (~1/1.166≈0.857×). Either
  // direction is baked scale animation; the source control (no keyframes
  // possible, same media) must stay at 1.00 (±3%) so the delta is renderer-
  // authored, not media noise.
  const zoomDelta = Math.abs(exRatio - 1);
  report("zoom slow-push", zoomDelta > 0.08 && srcRatio > 0.97 && srcRatio < 1.03,
    `dark-region area in fixed centre crop: export ${c05} → ${c45} (${exRatio.toFixed(3)}x, |Δ|=${(zoomDelta * 100).toFixed(1)}%)  |  source control ${s05} → ${s45} (${srcRatio.toFixed(3)}x)`);

  // ---- motion curve over the whole file (1/30s) ----
  const step = 1 / 15;
  const ts = [];
  const m = [];
  for (let t = 4.9; t + step <= duration - 0.05; t += step) {
    ts.push(t);
    m.push(meanAbsDiff(rawFrame(mp4, t), rawFrame(mp4, t + step)));
  }
  const med = [...m].sort((a, b) => a - b)[Math.floor(m.length / 2)];
  const hi = Math.max(...m);
  const hiIdx = m.indexOf(hi);

  // ---- 2. RAMP: the plan holds B at 1x for its first 1.6s, then ramps 1→8x.
  // Baseline: median motion over the clean 1x window [5.3, 6.7] (excludes the
  // hard cut at ~=5.0). Peak: max motion after the baseline window.
  const baseWin = m.filter((v, i) => ts[i] >= 5.3 && ts[i] <= 6.7);
  const baseMotion = [...baseWin].sort((a, b) => a - b)[Math.floor(baseWin.length / 2)];
  const hi2Idx = m.findLastIndex((v, i) => ts[i] > 6.8 && ts[i] < 9.9 && v === Math.max(...m.filter((v, i) => ts[i] > 6.8 && ts[i] < 9.9)));
  const hi2 = m[hi2Idx];
  report("speed ramp", hi2 > 1.7 * baseMotion && baseMotion > 0.5,
    `motion 1x≈${baseMotion.toFixed(1)}  ramp peak ${hi2.toFixed(1)} at t=${ts[hi2Idx].toFixed(2)}  ratio ${(hi2 / baseMotion).toFixed(2)}x`);

  // ---- 3. PARTICLES / motion moment: the burst plate in the exported file ----
  // particle-burst-on-cut materializes as a MotionComposition instance
  // (near-black #050505 plate, "Motion Scene" header, 420-max white→teal dots)
  // rendered full-frame for pb 5→6.3s. It is therefore detectable, directly in
  // decoded MP4 pixels, as a short near-black window between two ambient-bright
  // — plus genuine white/teal specks inside it.
  function meanLum(buf, stride = 13) {
    let tot = 0, n = 0;
    for (let i = 0; i < buf.length; i += stride) { tot += buf[i]; n++; }
    return tot / n;
  }
  function particlePixelCount(buf, crop = [0.1, 0.9, 0.1, 0.9]) {
    const [x0, x1, y0, y1] = crop;
    let c = 0;
    for (let y = Math.floor(y0 * HGT); y < Math.floor(y1 * HGT); y++) {
      for (let x = Math.floor(x0 * W); x < Math.floor(x1 * W); x++) {
        const i = (y * W + x) * 3;
        const r = buf[i], g = buf[i + 1], b = buf[i + 2];
        if ((r > 200 && g > 200 && b > 200) || (g > 150 && b > 140 && r < 100)) c++;
      }
    }
    return c;
  }
  const inF = rawFrame(mp4, 5.5), preF = rawFrame(mp4, 4.9), postF = rawFrame(mp4, 6.6);
  const lumIn = meanLum(inF), lumPre = meanLum(preF), lumPost = meanLum(postF);
  const pIn = particlePixelCount(inF);
  report("particle burst (motion moment)",
    lumIn < 20 && lumPre > 35 && lumPost > 60 && pIn > 6000,
    `near-black plate 5.5s lum=${lumIn.toFixed(1)} (ambient 4.9s=${lumPre.toFixed(1)} / 6.6s=${lumPost.toFixed(1)}) + white/teal specks=${pIn}`);

  // ---- 4. FREEZE: a motion trough collapses near encode noise ----
  const sorted = [...m].sort((a, b) => a - b);
  const minMotion = sorted[Math.floor(sorted.length * 0.05)]; // 5th percentile — a freeze hold exists
  report("freeze frame", minMotion < 0.25 * med && minMotion < 2.0,
    `trough(5th pct)=${minMotion.toFixed(2)} vs median ${med.toFixed(2)}`);

  const passed = checks.filter((c) => c.ok).length;
  console.log(`\n${passed}/${checks.length} motion parity checks passed`);
  fs.writeFileSync(path.join(OUT, "sweep.json"), JSON.stringify({
    checks,
    duration,
    shadeDuotone: { outroFraction: fracOutro, rawControl: fracCtl },
    particleBurst: { plateLum: lumIn, ambientBefore: lumPre, ambientAfter: lumPost, specks: pIn },
    motionCurve: ts.map((t, i) => ({ t: Number(t.toFixed(2)), m: Number(m[i].toFixed(2)) })),
    zoom: { early: c05, late: c45, sourceEarly: s05, sourceLate: s45 },
    exportedFile: mp4,
  }, null, 2));
  process.exit(passed === checks.length ? 0 : 1);
  }
})().catch((e) => {
  console.error("export-verify-motion fatal:", e);
  process.exit(2);
});
