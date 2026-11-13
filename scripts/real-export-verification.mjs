#!/usr/bin/env node
// Real end-to-end export verification. No mocks: spawns the real Vite dev
// server, drives the real ExportEngine in a real Chromium tab, produces a real
// mp4 from the real Captain Price source, then measures the rendered file with
// real FFmpeg (luma at the flash boundary, edge black fraction, duration,
// audio track) and asserts the declared-vs-rendered export log line.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(repoRoot, "apps/web/package.json"));
const { chromium } = require("@playwright/test");

const sourcePath = resolve(repoRoot, "captain price (2nd priority).MP4");
const outputDir = resolve(
  repoRoot,
  "run-outputs",
  `real-export-verification-${new Date().toISOString().replaceAll(":", "-")}`,
);
mkdirSync(join(outputDir, "screens"), { recursive: true });

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}: ${detail}`);
};

function getFreePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createNetServer();
    server.unref();
    server.on("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePromise(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

// --- 1. dev server ----------------------------------------------------------
const appPort = await getFreePort();
const baseUrl = `http://127.0.0.1:${appPort}`;
const viteCli = join(repoRoot, "apps/web/node_modules/.bin/vite");
const vite = spawn(viteCli, ["--host", "127.0.0.1", "--port", String(appPort), "--strictPort"], {
  cwd: join(repoRoot, "apps/web"),
  detached: process.platform !== "win32",
  stdio: ["ignore", "pipe", "pipe"],
});
const forward = (stream) => createInterface({ input: stream }).on("line", (line) => console.log(`[vite] ${line}`));
forward(vite.stdout);
forward(vite.stderr);

async function main() {
  try {
    await waitFor("dev server", async () => {
      const response = await fetch(baseUrl, { signal: AbortSignal.timeout(1500) });
      return response.ok;
    }, 120_000);
    console.log(`Vite ready at ${baseUrl}`);

    // --- 2. browser -----------------------------------------------------------
    const chromePath =
      process.env.KOVE_E2E_CHROMIUM ??
      (process.platform === "darwin" && await import("node:fs").then((fs) => fs.existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"))
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : undefined);
    const browser = await chromium.launch({
      headless: process.env.KOVE_E2E_HEADED !== "1",
      ...(chromePath ? { executablePath: chromePath } : {}),
      args: ["--autoplay-policy=no-user-gesture-required"],
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();

    const exportLogs = [];
    page.on("console", (message) => {
      const text = message.text();
      if (text.includes("[export]") || text.includes("[KOVE Export]")) {
        exportLogs.push(`${message.type()}: ${text}`);
        console.log(`[page] ${text}`);
      }
    });
    page.on("pageerror", (error) => console.log(`[pageerror] ${error.message}`));

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);

    const sourceUrl = `/@fs${sourcePath.split("/").map(encodeURIComponent).join("/")}`;
    console.log(`Source module URL: ${sourceUrl}`);

    // --- 3. real export in the page -------------------------------------------
    const exportOutcome = await page.evaluate(async (videoUrl) => {
      const coreRoot = "/@fs/Users/hamza/Desktop/k.o.v.e/packages/core/src";
      const { getExportEngine } = await import(`${coreRoot}/export/export-engine.ts`);
      const { WebCodecsBackend } = await import(`${coreRoot}/export/webcodecs-backend.ts`);

      const response = await fetch(videoUrl);
      if (!response.ok) throw new Error(`source fetch failed: ${response.status}`);
      const sourceBytes = await response.arrayBuffer();
      const sourceFile = new File([sourceBytes], "price.mp4", { type: "video/mp4" });

    const mediaItem = {
      id: "media-price",
      name: "price.mp4",
      type: "video",
      fileHandle: null,
      blob: sourceFile,
      metadata: {
        duration: 20.73,
        width: 576,
        height: 640,
        frameRate: 30,
        codec: "h264",
        sampleRate: 44100,
        channels: 2,
      },
      thumbnailUrl: null,
      waveformData: null,
      createdAt: Date.now(),
    };

      const baseTransform = {
        position: { x: 0, y: 0 },
        scale: { x: 1, y: 1 },
        rotation: 0,
        anchor: { x: 0.5, y: 0.5 },
        opacity: 1,
        fitMode: "cover",
      };
      const clipA = {
        id: "clip-a",
        mediaId: mediaItem.id,
        trackId: "track-1",
        startTime: 0,
        duration: 3,
        inPoint: 1.0,
        outPoint: 4.0,
        effects: [{ id: "fx-vignette", type: "vignette", params: { value: 0.3 }, enabled: true }],
        audioEffects: [],
        transform: baseTransform,
        volume: 1,
        keyframes: [],
        speed: 1,
      };
      const clipB = {
        ...clipA,
        id: "clip-b",
        startTime: 3,
        inPoint: 5.0,
        outPoint: 8.0,
        // Time-gated hit: only active for clip-local seconds [1.0, 1.2).
        effects: [{ id: "fx-brightness-hit", type: "brightness", params: { value: 60, startOffset: 1.0, duration: 0.2 }, enabled: true }],
      };
      const track = {
        id: "track-1",
        name: "V1",
        type: "video",
        role: "general",
        clips: [clipA, clipB],
        transitions: [{
          id: "flash-1",
          clipAId: "clip-a",
          clipBId: "clip-b",
          type: "flash",
          duration: 0.5,
          params: { intensity: 1 },
        }],
        locked: false,
        hidden: false,
        muted: false,
        solo: false,
      };
      const project = {
        id: "verify-project",
        name: "real-export-verification",
        settings: { width: 1080, height: 1920, frameRate: 30, sampleRate: 48000, channels: 2 },
        timeline: { id: "timeline", name: "verify", tracks: [track], duration: 6 },
        mediaLibrary: { items: [mediaItem] },
        textClips: [],
        shapeClips: [],
        svgClips: [],
        stickerClips: [],
        adjustmentLayers: [],
        motionInstances: [],
        compoundClips: [],
      };

      const engine = getExportEngine();
      await engine.initialize();

      const dir = await navigator.storage.getDirectory();

      const settings = {
        format: "mp4",
        codec: "h264",
        width: 1080,
        height: 1920,
        frameRate: 30,
        bitrate: 12000,
        bitrateMode: "vbr",
        quality: 85,
        keyframeInterval: 2,
        audioSettings: { format: "aac", sampleRate: 48000, bitDepth: 16, bitrate: 192, channels: 2 },
      };

      // Same attempt chain the web job runner uses: hardware WebCodecs →
      // software WebCodecs. (Native FFmpeg is desktop-only; no bridge here.)
      const attempts = [
        { label: "hardware WebCodecs", factory: null },
        { label: "software WebCodecs", factory: (mb) => new WebCodecsBackend(mb, { hardwareAcceleration: "prefer-software" }) },
      ];
      const retryable = new Set(["TIMEOUT", "FRAME_ENCODE_FAILED", "ENCODER_INIT_FAILED"]);

      let result = null;
      let progress = [];
      const attemptLog = [];
      for (const attempt of attempts) {
        const handle = await dir.getFileHandle("real-export-verification.mp4", { create: true });
        const writable = await handle.createWritable();
        const generator = engine.exportVideo(project, settings, writable, attempt.factory);
        progress = [];
        let step = await generator.next();
        while (!step.done) {
          progress.push({ phase: step.value.phase, progress: step.value.progress, bytes: step.value.bytesWritten });
          step = await generator.next();
        }
        result = step.value;
        attemptLog.push(`${attempt.label}: ${result.success ? "ok" : (result.error?.code ?? "failed")}`);
        if (result.success) break;
        if (!retryable.has(result.error?.code)) break;
      }

    let mp4Base64 = null;
    if (result.success) {
      const handle = await dir.getFileHandle("real-export-verification.mp4");
      const file = await handle.getFile();
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Playwright cannot structured-clone a raw ArrayBuffer out of evaluate;
      // ship it as chunked base64 instead.
      const chunk = 0x8000;
      let binary = "";
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      mp4Base64 = btoa(binary);
    }
    return {
      success: result.success,
      error: result.error ?? null,
      stats: result.stats ?? null,
      attempts: attemptLog,
      progressCount: progress.length,
      lastProgress: progress[progress.length - 1] ?? null,
      mp4Base64,
    };
    }, sourceUrl);

    await page.screenshot({ path: join(outputDir, "screens", "after-export.png") });
    await browser.close();

    if (!exportOutcome.success) {
      console.error("EXPORT FAILED:", JSON.stringify(exportOutcome.error), "attempts:", JSON.stringify(exportOutcome.attempts));
      record("export succeeds", false, JSON.stringify({ error: exportOutcome.error, attempts: exportOutcome.attempts }));
      await saveResults(outputDir, vite);
      process.exitCode = 1;
      return;
    }

  const mp4Path = join(outputDir, "render.mp4");
  writeFileSync(mp4Path, Buffer.from(exportOutcome.mp4Base64, "base64"));
    record(
      "export succeeds",
      true,
      `file=${mp4Path} bytes=${exportOutcome.stats.fileSize} frames=${exportOutcome.stats.framesRendered} ` +
        `(${(exportOutcome.stats.averageSpeed ?? 0).toFixed(2)}x realtime)`,
    );

    const declaredLine = exportLogs.find((line) => line.includes("declared") && line.includes("rendered"));
    record(
      "declared-vs-rendered logged and matching",
      Boolean(declaredLine && declaredLine.includes("declared 2 effects / 1 transitions, rendered 2 / 1")),
      declaredLine ?? "no [export] declared/rendered line captured",
    );

    // --- 4. real ffmpeg measurements ------------------------------------------
    const probe = JSON.parse(execFileSync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration",
      "-show_entries", "stream=index,codec_type,codec_name",
      "-of", "json", mp4Path,
    ], { encoding: "utf8" }));
    const duration = parseFloat(probe.format.duration);
    const audioStream = probe.streams.find((stream) => stream.codec_type === "audio");
    record("duration matches timeline", Math.abs(duration - 6) <= 0.35, `ffprobe duration=${duration.toFixed(2)}s (expected ~6s)`);
    record("output has an audio track", Boolean(audioStream), audioStream ? `stream #${audioStream.index} ${audioStream.codec_name}` : "no audio stream");

    // Per-frame luma (0-255) via signalstats.
    const signalOutput = execFileSync("ffmpeg", [
      "-hide_banner", "-i", mp4Path,
      "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-",
      "-f", "null", "-",
    ], { encoding: "utf8", maxBuffer: 1024 * 1024 * 64 });
    const yavgByFrame = [];
    let currentFrame = -1;
    for (const line of signalOutput.split("\n")) {
      const frameMatch = /^frame:(\d+)\s+pts/.exec(line);
      if (frameMatch) currentFrame = parseInt(frameMatch[1], 10);
      const yavgMatch = /lavfi\.signalstats\.YAVG=([0-9.]+)/.exec(line);
      if (yavgMatch && currentFrame >= 0) {
        yavgByFrame[currentFrame] = parseFloat(yavgMatch[1]);
        currentFrame = -1;
      }
    }

    const flashWindow = yavgByFrame.slice(83, 97).filter(Number.isFinite); // t = 2.75-3.25s window
    const beforeBaseline = yavgByFrame.slice(30, 75).filter(Number.isFinite); // t = 1.0-2.5s
    const afterBaseline = yavgByFrame.slice(150, 180).filter(Number.isFinite); // t = 5.0-6.0s
    const peakFlash = Math.max(...flashWindow);
    const baselineMean = (beforeBaseline.reduce((a, b) => a + b, 0) / beforeBaseline.length +
      afterBaseline.reduce((a, b) => a + b, 0) / afterBaseline.length) / 2;
    record(
      "flash transition renders brighter than surrounding frames",
      peakFlash > baselineMean + 40,
      `peak luma in flash window=${peakFlash.toFixed(1)}, surrounding baseline=${baselineMean.toFixed(1)} (+${(peakFlash - baselineMean).toFixed(1)})`,
    );

    // Edge black fraction: cover-fit must leave no pure-black letterbox band.
    const edgeBandPx = 6;
    for (const timeSec of [1.5, 3.0, 5.0]) {
      const raw = execFileSync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-ss", String(timeSec), "-i", mp4Path,
        "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
      ], { encoding: "buffer", maxBuffer: 1024 * 1024 * 32 });
      const { width, height } = exportOutcome.stats ? { width: 1080, height: 1920 } : { width: 1080, height: 1920 };
      let edgePixels = 0;
      let edgeBlack = 0;
      const isBlack = (offset) => raw[offset] < 8 && raw[offset + 1] < 8 && raw[offset + 2] < 8;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (x < edgeBandPx || x >= width - edgeBandPx || y < edgeBandPx || y >= height - edgeBandPx) {
            edgePixels++;
            if (isBlack((y * width + x) * 3)) edgeBlack++;
          }
        }
      }
      const fraction = edgeBlack / edgePixels;
      record(
        `no black letterbox edges at t=${timeSec}s`,
        fraction < 0.01,
        `edge black fraction=${(fraction * 100).toFixed(3)}% (${edgeBlack}/${edgePixels} edge pixels)`,
      );
    }

    await saveResults(outputDir, vite);
  } catch (error) {
    console.error("VERIFICATION RUN FAILED:", error);
    await saveResults(outputDir, vite).catch(() => {});
    process.exitCode = 1;
  } finally {
    try {
      if (process.platform !== "win32" && vite.pid) process.kill(-vite.pid, "SIGTERM");
      else vite.kill("SIGTERM");
    } catch {
      // already gone
    }
  }

}

void main();
async function saveResults(outputDir, vite) {
  const passed = results.filter((r) => r.pass).length;
  const report = { results, passed, total: results.length };
  writeFileSync(join(outputDir, "verification.json"), JSON.stringify(report, null, 2));
  console.log(`\n${passed}/${results.length} checks passed. Report: ${join(outputDir, "verification.json")}`);
  if (results.some((r) => !r.pass)) process.exitCode = 1;
}
