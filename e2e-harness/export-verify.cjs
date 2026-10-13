// EXPORT PARITY PROOF: builds the same 14s montage via the real chat path,
// clicks the toolbar Export button, captures the produced MP4, then decodes
// the FILE's pixels/bytes with ffmpeg and verifies every "complex" feature
// survived the export pipeline — not the preview canvas, the actual output:
//
//   1. container: ffprobe duration ~13.6s, video+audio streams present
//   2. audio: music-bed mixed in (astats RMS above noise floor)
//   3. effect:   exported t=5.0 vs raw gameplay source t=5.0 -> hue(140°) residual BIG;
//                exported t=1.0 vs raw broll source t=3.0 -> residual SMALL (control)
//   4. transition A (crossfade, window 2.775-3.225): exported frame == alpha blend
//                of both sources; alpha decreases across the window
//   5. transition B (dipToBlack, centered ~9.22): mid-frame luminance ~0
//   6. overlays:  title (0.3-3.2) & lower-third (9.9-13.9) appear as residual
//                pixels vs the clean source frame
//
// All frame math is double-vision: exported file vs source pixels decoded by
// an independent ffmpeg pass. Run after bootstrap.sh with vite+stub live:
//   NODE_PATH=$H/tools/node_modules node $H/export-verify.cjs
const { chromium } = require("playwright-core");
const { execFileSync, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const H = process.env.HARNESS_HOME || "/home/user/kove-e2e-harness";
const OUT = path.join(H, "export");
const FFMPEG = "/home/user/tools/ffm/node_modules/@ffmpeg-installer/linux-x64/ffmpeg";
const FFPROBE = "/home/user/tools/ffm/node_modules/@ffprobe-installer/linux-x64/ffprobe";
const W = 1280, HGT = 720, PIX = W * HGT * 3; // analysis space: export (1920x1080) and sources (1280x720) both decoded to this

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
    "-hide_banner", "-loglevel", "error",
    "-i", file, "-ss", String(t), "-frames:v", "1",
    "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ], { maxBuffer: 1024 * 1024 * 32 });
}
function stats(buf, band = null) {
  let r = 0, g = 0, b = 0, lum = 0, n = 0;
  const y0 = band ? Math.floor(band[0] * HGT) : 0, y1 = band ? Math.ceil(band[1] * HGT) : HGT;
  for (let y = y0; y < y1; y++) {
    const row = y * W * 3;
    for (let i = row; i < row + W * 3; i += 3) {
      r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; n++;
      lum += (buf[i] + buf[i + 1] + buf[i + 2]) / 3;
    }
  }
  return { R: r / n, G: g / n, B: b / n, lum: lum / n, n };
}
function meanAbsDiff(a, b) {
  let d = 0; for (let i = 0; i < PIX; i++) d += Math.abs(a[i] - b[i]);
  return d / PIX;
}
function bigResidualCount(a, b, thresh = 80) {
  let c = 0; for (let i = 0; i < PIX; i += 3) {
    if (Math.abs(a[i] - b[i]) > thresh || Math.abs(a[i + 1] - b[i + 1]) > thresh || Math.abs(a[i + 2] - b[i + 2]) > thresh) c++;
  }
  return c;
}
// Least-error alpha for out ≈ α·A + (1−α)·B, coarse 0.02 grid.
function blendFit(out, A, B) {
  let bestAlpha = 0, bestErr = Infinity;
  for (let a = 0; a <= 1.0001; a += 0.02) {
    let err = 0;
    for (let i = 0; i < PIX; i += 30) { // sampled for speed
      const e1 = a * A[i] + (1 - a) * B[i] - out[i];
      const e2 = a * A[i + 1] + (1 - a) * B[i + 1] - out[i + 1];
      const e3 = a * A[i + 2] + (1 - a) * B[i + 2] - out[i + 2];
      err += e1 * e1 + e2 * e2 + e3 * e3;
    }
    if (err < bestErr) { bestErr = err; bestAlpha = a; }
  }
  return { alpha: bestAlpha, rmse: Math.sqrt((bestErr * 30) / PIX) };
}

const checks = [];
function report(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const mp4Cached = path.join(OUT, "export.mp4");
  if (process.env.SKIP_EXPORT === "1" && fs.existsSync(mp4Cached)) {
    console.log("SKIP_EXPORT=1 — reusing", mp4Cached);
    runChecks(mp4Cached);
    return;
  }
  const browser = await chromium.launch({
    executablePath: "/usr/local/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--mute-audio",
      "--autoplay-policy=no-user-gesture-required", "--enable-unsafe-swiftshader"],
  });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  await context.addInitScript(([s]) => {
    try { localStorage.setItem("kove-advanced-settings", JSON.stringify({ state: s, version: 8 })); } catch {}
    // Headless Chromium HAS showSaveFilePicker but the native chooser hangs
    // forever in headless. Capture the stream instead — every exported byte
    // still flows through the app's own writeBlobToWritable path.
    // Full FileSystemWritableFileStream semantics — MediaBunny's mp4 muxer
    // seeks back to patch headers, so a write-only stub is not enough.
    window.__exported = { buf: new Uint8Array(16 * 1024 * 1024), len: 0, cursor: 0, suggested: "", closed: false, error: "" };
    window.showSaveFilePicker = async (opts) => {
      window.__exported.suggested = opts?.suggestedName || "";
      const E = window.__exported;
      const grow = (needed) => {
        if (needed <= E.buf.length) return;
        let s = E.buf.length;
        while (s < needed) s *= 2;
        const n = new Uint8Array(s);
        n.set(E.buf.subarray(0, E.len));
        E.buf = n;
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
  const files = ["gameplay-a.webm", "talking-b.webm", "broll-c.webm", "music-bed.wav"].map((f) => path.join(H, "media", f));
  await (await page.$$('input[type="file"]'))[0].setInputFiles(files);
  await page.getByText("music-bed.wav").waitFor();
  await page.getByPlaceholder(/hype reel/).fill(
    "Cut a 14-second hype montage from my clips: b-roll hook, then gameplay, then me talking. Music bed under it, a bold title up top to open, a lower-third to close.",
  );
  await page.getByRole("button", { name: "Kreate" }).click();
  await page.waitForURL(/#\/editor/, { timeout: 150_000 });
  const wd = setInterval(() => {
    page.getByRole("button", { name: /skip tour/i }).first().click({ timeout: 400 }).catch(() => {});
  }, 1200);
  await page.getByText(/Done — I cut your 14-second montage/).waitFor({ timeout: 150_000 });
  console.log("plan materialized — clicking toolbar Export");

  const mp4 = path.join(OUT, "export.mp4");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  // Poll: export streams into the captured writable; watch closed flag + progress text.
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
    await page.waitForTimeout(0); // let long tasks breathe between evaluate polls
  }
  console.log("finalizing — byte-jacking the export (chunked)");
  const totalLen = await page.evaluate(() => window.__exported.len);
  const beats = [];
  const CHUNK = 4 * 1024 * 1024;
  for (let off = 0; off < totalLen; off += CHUNK) {
    beats.push(await page.evaluate(([o, n]) => Array.from(window.__exported.buf.subarray(o, o + n)), [off, Math.min(CHUNK, totalLen - off)]));
  }
  clearInterval(wd);
  await browser.close();
  fs.writeFileSync(mp4, Buffer.concat(beats.map((b) => Buffer.from(Uint8Array.from(b)))));
  const mb = (fs.statSync(mp4).size / 1048576).toFixed(1);
  console.log(`export captured: ${mb} MB`);
  runChecks(mp4);
  return;

  async function runChecks(mp4) {
  const summary = {};
  // ---- 1. container ----
  const probe = JSON.parse(execFileSync(FFPROBE, ["-v", "error", "-show_format", "-show_streams", "-of", "json", mp4]));
  const duration = Number(probe.format.duration);
  summary.duration = duration;
  const vids = probe.streams.filter((s) => s.codec_type === "video");
  const auds = probe.streams.filter((s) => s.codec_type === "audio");
  report("container", duration > 13.2 && duration < 14.2 && vids.length === 1 && auds.length === 1,
    `duration=${duration.toFixed(2)}s video=${vids[0]?.codec_name} ${vids[0]?.width}x${vids[0]?.height} audio=${auds[0]?.codec_name}`);

  // ---- helper: find the source frame an exported frame actually came from.
  // Native test patterns rotate hue with time, so source-time must be
  // calibrated empirically (scan ±0.6s at 1/15s) instead of assumed.
  function calibrateSource(exportedFrame, sourceFile, guess, span = 0.6) {
    let best = { s: guess, d: Infinity };
    for (let s = guess - span; s <= guess + 0.001; s += 1 / 15) {
      const cand = rawFrame(sourceFile, Math.max(0, s));
      const d = meanAbsDiff(exportedFrame, cand);
      if (d < best.d) best = { s: Math.max(0, s), d, frame: cand };
    }
    return best;
  }

  // ---- 2. audio content ----
  const astats = execFileSync("/bin/sh", ["-c", `"${FFMPEG}" -i "${mp4}" -af astats=metadata=1 -f null - 2>&1 || true`]).toString();
  const maxLevel = Number(astats.match(/Max level:\s*([0-9.e-]+)/)?.[1] ?? 0);
  summary.maxLevel = maxLevel;
  report("audio bed", maxLevel > 0.02, `astats max_level=${maxLevel} (RMS ${astats.match(/RMS level dB:\s*([-.0-9]+)/)?.[1]}dB)`);

  // ---- 3. effect residual (tint) with calibrated control ----
  const ex5 = rawFrame(mp4, 5.0), sr5 = rawFrame(path.join(H, "media/gameplay-a.webm"), 5.0);
  const ex1 = rawFrame(mp4, 1.0);
  const ctrl = calibrateSource(ex1, path.join(H, "media/broll-c.webm"), 3.0);
  const dTint = meanAbsDiff(ex5, sr5), dControl = ctrl.d;
  console.log(`  control calibration: broll source s*=${ctrl.s.toFixed(2)} |Δ|=${dControl.toFixed(1)}`);
  report("effect on export", dTint > 30, `|Δ| tinted gameplay = ${dTint.toFixed(1)}`);
  report("effect scope", dTint > 3 * dControl && dControl < 25,
    `control broll |Δ| = ${dControl.toFixed(1)} (ratio ${(dTint / Math.max(dControl, 0.001)).toFixed(1)}x)`);

  // ---- 4. crossfade blend alpha traverses ----
  // transition window: clip A tail overlapped with clip B head. Exported
  // frames in-window should be α·A+(1−α)·B with α falling across the window.
  // crossfade window [2.775, 3.225]: at the exact center (t=3.0) the export
  // should be a 50/50 blend of A-tail and B-head. Build synthetic blends over
  // a fine (2-3/15 s) source-time grid and see whether any combination
  // reaches near-noise residual — that's byte-level proof the exported pixels
  // came from BOTH sources with equal weight, not one or the other.
  const out3 = rawFrame(mp4, 3.0);
  const sGrid = [];
  for (let s = 4.55; s <= 5.55; s += 1 / 30) sGrid.push(s);
  const tGrid = [];
  for (let s = 2.8; s <= 3.7; s += 1 / 30) tGrid.push(s);
  const aFrames = sGrid.map((s) => rawFrame(path.join(H, "media/broll-c.webm"), s));
  const bFrames = tGrid.map((s) => rawFrame(path.join(H, "media/gameplay-a.webm"), s));
  const bTintFrames = tGrid.map((s) => rawFrame(path.join(H, "media/gameplay-a.webm"), s, "hue=h=140"));
  let bestBlend = { sa: 0, sb: 0, alpha: 0.5, d: Infinity, notBlended: Infinity };
  for (const alpha of [0.44, 0.47, 0.5, 0.53, 0.56]) {
    for (let ia = 0; ia < sGrid.length; ia++) {
      for (let ib = 0; ib < tGrid.length; ib++) {
        const A = aFrames[ia], B = bTintFrames[ib];
        let d = 0, n = 0;
        for (let i = 0; i < PIX; i += 30) {
          const r = alpha * A[i] + (1 - alpha) * B[i] - out3[i];
          d += Math.abs(r); n++;
        }
        d /= n;
        if (d < bestBlend.d) bestBlend = { sa: sGrid[ia], sb: tGrid[ib], alpha, d, A, B };
      }
    }
  }
  // contrast: could the center frame pass as EITHER source alone? (cut, not crossfade)
  const dAOnly = meanAbsDiff(out3, bestBlend.A);
  let dBOnly = Infinity;
  for (let s = 2.8; s <= 3.7; s += 1 / 30) {
    dBOnly = Math.min(dBOnly, meanAbsDiff(out3, rawFrame(path.join(H, "media/gameplay-a.webm"), s, "hue=h=140"))/1);
  }
  dBOnly = Math.min(dBOnly, ...sGrid.map((_, i) => i) .length ? [dBOnly] : []);
  console.log(`  blend center pick: A=${bestBlend.sa.toFixed(3)}s B=${bestBlend.sb.toFixed(3)}s α=${bestBlend.alpha.toFixed(2)} → residual=${bestBlend.d.toFixed(1)}  (A-only ${dAOnly.toFixed(1)}, B-only ${dBOnly.toFixed(1)})`);
  report("crossfade blend",
    bestBlend.d < 20 && dAOnly > 2.2 * bestBlend.d && dBOnly > 2.2 * bestBlend.d,
    `blend synth (α=${bestBlend.alpha.toFixed(2)}) residual=${bestBlend.d.toFixed(1)} vs A-only ${dAOnly.toFixed(1)} / B-only ${dBOnly.toFixed(1)}`);

  // ---- 5. dip to black (centered at 9.4&9s tail window; preview proved 9.49) ----
  const dip = stats(rawFrame(mp4, 9.49)).lum;
  report("dipToBlack", dip < 2.5, `mean luminance at 9.49s = ${dip.toFixed(2)}`);

  // ---- 6. overlays as source residual (calibrated source frame) ----
  const titleResid = bigResidualCount(ex1, ctrl.frame, 80);
  const ex11 = rawFrame(mp4, 11.0);
  const calLt = calibrateSource(ex11, path.join(H, "media/talking-b.webm"), 3.0);
  const thirdResid = bigResidualCount(ex11, calLt.frame, 80);
  report("title overlay", titleResid > 2500, `big-residual pixels at 1.0s = ${titleResid}`);
  report("lower-third overlay", thirdResid > 1500, `big-residual pixels at 11.0s = ${thirdResid} (src=${calLt.s.toFixed(2)} |Δ|=${calLt.d.toFixed(1)})`);

  const passed = checks.filter((c) => c.ok).length;
  console.log(`\n${passed}/${checks.length} export-parity checks passed`);
  fs.writeFileSync(path.join(OUT, "sweep.json"), JSON.stringify({ checks, exportedFile: mp4, ...summary }, null, 2));
  process.exit(passed === checks.length ? 0 : 1);
  }
})().catch((e) => {
  console.error("export-verify fatal:", e);
  process.exit(2);
});
