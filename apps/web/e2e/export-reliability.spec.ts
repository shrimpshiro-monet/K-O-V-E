import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { hasBrowser } from "../playwright.config";

/**
 * Real Chromium -> real timeline -> real MP4 download. The only deliberate
 * fault injection is in the separate cancellation/error tests. Fixtures are
 * generated per run; ffprobe and decoded pixel/audio checks reject empty or
 * corrupt "successful" downloads.
 */
const ffmpeg = process.env.KOVE_E2E_FFMPEG ?? "ffmpeg";
const ffprobe = process.env.KOVE_E2E_FFPROBE ?? "ffprobe";
const hasBinary = (name: string) => spawnSync(name, ["-version"], { stdio: "ignore" }).status === 0;
const backendUrl = `/@fs${resolve(process.cwd(), "../../packages/core/src/export/webcodecs-backend.ts")}`;

test.skip(!hasBrowser(), "Chromium is not installed; set KOVE_E2E_CHROMIUM");
test.setTimeout(240_000);

type ExportState = { isExporting: boolean; progress: number; phase: string; error: string | null; complete: boolean };

async function openEditor(page: Page) {
  await page.addInitScript(() => {
    // The editor loads hundreds of modules; preserve their actual Vite URLs
    // (including HMR query strings) so test imports share the app's stores.
    performance.setResourceTimingBufferSize(10_000);
    localStorage.setItem("kove-advanced-onboarding-complete", "true");
    localStorage.setItem("kove-advanced-mograph-tour-complete", "true");
    delete (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await page.goto("/#new", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Import Media" }).first().waitFor({ timeout: 90_000 });
  await page.evaluate(async () => {
    const path = "/src/stores/ui-store.ts";
    const url = performance.getEntriesByType("resource").find((entry) => new URL(entry.name).pathname === path)?.name ?? path;
    const { useUIStore } = await import(/* @vite-ignore */ url);
    const holder = window as unknown as { __exportStates: ExportState[] };
    holder.__exportStates = [];
    useUIStore.subscribe((state) => holder.__exportStates.push({ ...state.exportState }));
  });
}

async function makePicture(page: Page, testInfo: TestInfo): Promise<string> {
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#df563e";
    ctx.fillRect(0, 0, 160, 180);
    ctx.fillStyle = "#207ecb";
    ctx.fillRect(160, 0, 160, 180);
    ctx.fillStyle = "#ffe49a";
    ctx.beginPath(); ctx.arc(160, 62, 25, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#243a48";
    ctx.beginPath(); ctx.moveTo(0, 180); ctx.lineTo(95, 120); ctx.lineTo(155, 180); ctx.fill();
    ctx.fillStyle = "#12365a";
    ctx.beginPath(); ctx.moveTo(150, 180); ctx.lineTo(245, 125); ctx.lineTo(320, 180); ctx.fill();
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const path = testInfo.outputPath("generated-landscape.png");
  writeFileSync(path, Buffer.from(png, "base64"));
  return path;
}

type VideoSettings = { width: number; height: number; frameRate: number };
const LOW_RES: VideoSettings = { width: 320, height: 180, frameRate: 4 };

async function putOnTimeline(page: Page, path: string, duration = 1, settings = LOW_RES) {
  const filename = path.split(/[\\/]/).at(-1)!;
  await page.locator('input[aria-label="Import media"]').setInputFiles(path);
  const tile = page.locator(`img[alt$=${JSON.stringify(filename)}]`).first();
  await tile.waitFor({ timeout: 90_000 });
  await tile.hover();
  await page.getByRole("button", { name: "Add to timeline" }).first().click();
  const keep = page.getByRole("button", { name: "Keep Current" });
  if (await keep.isVisible().catch(() => false)) await keep.click();
  await expect.poll(() => page.evaluate(async () => {
    const path = "/src/stores/project-store.ts";
    const url = performance.getEntriesByType("resource").find((entry) => new URL(entry.name).pathname === path)?.name ?? path;
    const { useProjectStore } = await import(/* @vite-ignore */ url);
    return useProjectStore.getState().project.timeline.tracks.some((track) => track.clips.length > 0);
  }), { timeout: 30_000 }).toBe(true);
  await page.evaluate(async ({ targetDuration, exportSettings }) => {
    const path = "/src/stores/project-store.ts";
    const url = performance.getEntriesByType("resource").find((entry) => new URL(entry.name).pathname === path)?.name ?? path;
    const { useProjectStore } = await import(/* @vite-ignore */ url);
    const clips = useProjectStore.getState().project.timeline.tracks.flatMap((track) => track.clips);
    for (const clip of clips) {
      const result = await useProjectStore.getState().trimClip(clip.id, 0, targetDuration);
      if (!result.success) throw new Error(`Could not trim test clip: ${result.error?.message}`);
    }
    const result = await useProjectStore.getState().updateSettings(exportSettings);
    if (!result.success) throw new Error(`Could not set test dimensions: ${result.error?.message}`);
  }, { targetDuration: duration, exportSettings: settings });
}

async function states(page: Page): Promise<ExportState[]> {
  return page.evaluate(() => (window as unknown as { __exportStates: ExportState[] }).__exportStates);
}

async function exportAndCheck(page: Page, testInfo: TestInfo, expectAudio: boolean, duration = 1, settings = LOW_RES) {
  const event = page.waitForEvent("download", { timeout: 360_000 });
  await page.getByRole("button", { name: "Export", exact: true }).first().click();
  const download = await event;
  const output = testInfo.outputPath(expectAudio ? "video-with-audio.mp4" : "images.mp4");
  await download.saveAs(output);
  expect(readFileSync(output).length).toBeGreaterThan(1000);
  await expect.poll(async () => (await states(page)).some((s) => s.complete && !s.isExporting && s.progress === 100), { timeout: 15_000 }).toBe(true);

  const probe = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate:format=duration", "-of", "json", output], { encoding: "utf8" })) as {
    streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number; r_frame_rate?: string }>;
    format: { duration: string };
  };
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  expect(video).toMatchObject({ width: settings.width, height: settings.height, r_frame_rate: `${settings.frameRate}/1` });
  expect(Number(probe.format.duration)).toBeGreaterThanOrEqual(duration - 0.1);
  expect(Number(probe.format.duration)).toBeLessThan(duration + 0.3);
  expect(probe.streams.some((stream) => stream.codec_type === "audio")).toBe(expectAudio);
  if (expectAudio) {
    const analysis = spawnSync(ffmpeg, ["-hide_banner", "-i", output, "-af", "volumedetect", "-vn", "-f", "null", "-"], { encoding: "utf8" });
    expect(analysis.status).toBe(0);
    const mean = Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(analysis.stderr)?.[1]);
    expect(Number.isFinite(mean)).toBe(true);
    expect(mean).toBeGreaterThan(-50);
  }

  const framePath = testInfo.outputPath("decoded-frame.png");
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-ss", "0.5", "-i", output, "-frames:v", "1", framePath]);
  await page.evaluate(() => {
    const input = document.createElement("input"); input.type = "file"; input.id = "verify-export-frame"; input.hidden = true; document.body.appendChild(input);
  });
  await page.locator("#verify-export-frame").setInputFiles(framePath);
  const pixels = await page.evaluate(async () => {
    const file = (document.querySelector("#verify-export-frame") as HTMLInputElement).files![0];
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d")!; ctx.drawImage(bitmap, 0, 0); bitmap.close();
    const y = Math.floor(canvas.height * 40 / 180);
    return [Array.from(ctx.getImageData(Math.floor(canvas.width / 8), y, 1, 1).data), Array.from(ctx.getImageData(Math.floor(canvas.width * 7 / 8), y, 1, 1).data)];
  });
  expect(pixels[0][0]).toBeGreaterThan(pixels[0][2] + 60); // generated red half
  expect(pixels[1][2]).toBeGreaterThan(pixels[1][0] + 60); // generated blue half
  await testInfo.attach("decoded-frame", { path: framePath, contentType: "image/png" });
  await testInfo.attach("exported-video", { path: output, contentType: "video/mp4" });
  return output;
}

test("exports an actual image timeline MP4 with the expected pixels", async ({ page }, testInfo) => {
  test.skip(!hasBinary(ffmpeg) || !hasBinary(ffprobe), "ffmpeg and ffprobe are required to verify output");
  await openEditor(page);
  await putOnTimeline(page, await makePicture(page, testInfo));
  await page.screenshot({ path: testInfo.outputPath("image-timeline.png") });
  await exportAndCheck(page, testInfo, false);
});

test("exports generated video and audible audio without a CDN FFmpeg download", async ({ page }, testInfo) => {
  test.skip(!hasBinary(ffmpeg) || !hasBinary(ffprobe), "ffmpeg and ffprobe are required to create and verify output");
  await page.route("https://unpkg.com/**", (route) => route.abort());
  await openEditor(page);
  const picture = await makePicture(page, testInfo);
  const source = testInfo.outputPath("generated-source.mp4");
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", "4", "-i", picture, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1", "-c:v", "libx264", "-threads", "1", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source]);
  await putOnTimeline(page, source);
  await exportAndCheck(page, testInfo, true);
});

test("exports real audible 24-bit WAV audio from the toolbar", async ({ page }, testInfo) => {
  test.skip(!hasBinary(ffmpeg) || !hasBinary(ffprobe), "ffmpeg and ffprobe are required for media checks");
  await page.route("https://unpkg.com/**", (route) => route.abort());
  await openEditor(page);
  const picture = await makePicture(page, testInfo);
  const source = testInfo.outputPath("wav-source.mp4");
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", "4", "-i", picture, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1", "-c:v", "libx264", "-threads", "1", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source]);
  await putOnTimeline(page, source);
  await page.getByRole("button", { name: "Export options" }).click();
  const event = page.waitForEvent("download", { timeout: 120_000 });
  await page.getByText("Audio Only (WAV)").click();
  const download = await event;
  expect(download.suggestedFilename()).toMatch(/\.wav$/i);
  const output = testInfo.outputPath("audio-only.wav");
  await download.saveAs(output);
  const meta = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", output], { encoding: "utf8" }));
  expect(meta.streams[0]).toMatchObject({ codec_name: "pcm_s24le", sample_rate: "48000", channels: 2 });
  expect(Number(meta.format.duration)).toBeCloseTo(1, 1);
  const analysis = spawnSync(ffmpeg, ["-hide_banner", "-i", output, "-af", "volumedetect", "-vn", "-f", "null", "-"], { encoding: "utf8" });
  expect(analysis.status).toBe(0);
  const mean = Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(analysis.stderr)?.[1]);
  expect(Number.isFinite(mean)).toBe(true);
  expect(mean).toBeGreaterThan(-50);
  await expect.poll(async () => (await states(page)).some((s) => s.complete && !s.isExporting && s.progress === 100), { timeout: 15_000 }).toBe(true);
});

test("resamples a 44.1 kHz mono project to stereo 48 kHz WAV without changing pitch", async ({ page }, testInfo) => {
  test.skip(!hasBinary(ffmpeg) || !hasBinary(ffprobe), "ffmpeg and ffprobe are required for media checks");
  await page.route("https://unpkg.com/**", (route) => route.abort());
  await openEditor(page);
  const picture = await makePicture(page, testInfo);
  const source = testInfo.outputPath("mono-44100-source.mp4");
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", "4", "-i", picture,
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "1", "-c:v", "libx264",
    "-threads", "1", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "44100", "-ac", "1", "-shortest", source]);
  await putOnTimeline(page, source);
  await page.evaluate(async () => {
    const path = "/src/stores/project-store.ts";
    const url = performance.getEntriesByType("resource").find((entry) => new URL(entry.name).pathname === path)?.name ?? path;
    const { useProjectStore } = await import(/* @vite-ignore */ url);
    const result = await useProjectStore.getState().updateSettings({ sampleRate: 44100, channels: 1 });
    if (!result.success) throw new Error(`Could not set mono source clock: ${result.error?.message}`);
  });
  await page.getByRole("button", { name: "Export options" }).click();
  const pending = page.waitForEvent("download", { timeout: 120_000 });
  await page.getByText("Audio Only (WAV)").click();
  const output = testInfo.outputPath("resampled-stereo.wav");
  await (await pending).saveAs(output);
  const metadata = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", output], { encoding: "utf8" }));
  expect(metadata.streams[0]).toMatchObject({ codec_name: "pcm_s24le", sample_rate: "48000", channels: 2 });
  expect(Number(metadata.format.duration)).toBeCloseTo(1, 2);
  const pcm = execFileSync(ffmpeg, ["-v", "error", "-i", output, "-f", "f32le", "-acodec", "pcm_f32le", "-"]);
  let crossings = 0, sumLeft = 0, sumRight = 0, maxDifference = 0;
  let previous = pcm.readFloatLE(4800 * 8);
  for (let frame = 4801; frame < 43200; frame++) {
    const left = pcm.readFloatLE(frame * 8), right = pcm.readFloatLE(frame * 8 + 4);
    if (previous <= 0 && left > 0) crossings++;
    previous = left;
    sumLeft += left * left;
    sumRight += right * right;
    maxDifference = Math.max(maxDifference, Math.abs(left - right));
  }
  const frequency = crossings / ((43200 - 4801) / 48000);
  expect(frequency).toBeGreaterThan(437);
  expect(frequency).toBeLessThan(443);
  expect(sumLeft).toBeGreaterThan(10);
  expect(sumRight).toBeGreaterThan(10);
  expect(maxDifference).toBeLessThan(0.001);
});

test("agent jobs download real browser video and Ogg/Opus audio", async ({ page }, testInfo) => {
  test.skip(!hasBinary(ffmpeg) || !hasBinary(ffprobe), "ffmpeg and ffprobe are required for media checks");
  await page.route("https://unpkg.com/**", (route) => route.abort());
  await openEditor(page);
  const picture = await makePicture(page, testInfo);
  const source = testInfo.outputPath("agent-source.mp4");
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", "4", "-i", picture,
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1", "-c:v", "libx264",
    "-threads", "1", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source]);
  await putOnTimeline(page, source);
  async function runJob(kind: "exportVideo" | "exportAudio", format: string, filename: string) {
    const downloadPromise = page.waitForEvent("download", { timeout: 120_000 });
    const resultPromise = page.evaluate(async ({ kind, format }) => {
      const path = "/src/services/agent/export-job-runner.ts";
      const url = performance.getEntriesByType("resource").find((entry) => new URL(entry.name).pathname === path)?.name ?? path;
      const { createExportJobRunner } = await import(/* @vite-ignore */ url);
      return createExportJobRunner()(kind, { format });
    }, { kind, format });
    const [download, result] = await Promise.all([downloadPromise, resultPromise]);
    expect(result).toMatchObject({ ok: true, data: { format, storage: "browser-download" } });
    expect(result.data.bytes).toBeGreaterThan(1000);
    const output = testInfo.outputPath(filename);
    await download.saveAs(output);
    return JSON.parse(execFileSync(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,codec_name:format=duration", "-of", "json", output], { encoding: "utf8" }));
  }
  const video = await runJob("exportVideo", "mp4", "agent.mp4");
  expect(video.streams.some((stream: { codec_type: string; codec_name: string }) => stream.codec_type === "video" && stream.codec_name === "h264")).toBe(true);
  expect(video.streams.some((stream: { codec_type: string }) => stream.codec_type === "audio")).toBe(true);
  const audio = await runJob("exportAudio", "ogg", "agent.ogg");
  expect(audio.streams[0]).toMatchObject({ codec_type: "audio", codec_name: "opus" });
  expect(Number(audio.format.duration)).toBeGreaterThan(0.95);
  expect(Number(audio.format.duration)).toBeLessThan(1.1);

  // Browser encoder support differs by platform. A supported format must be
  // real encoded media; an unsupported one must fail clearly, never be WAV
  // bytes hidden behind a different extension.
  const optionalDownloads: import("@playwright/test").Download[] = [];
  page.on("download", (download) => optionalDownloads.push(download));
  for (const format of ["aac", "mp3", "flac"] as const) {
    const before = optionalDownloads.length;
    const result = await page.evaluate(async (format) => {
      const path = "/src/services/agent/export-job-runner.ts";
      const url = performance.getEntriesByType("resource").find((entry) => new URL(entry.name).pathname === path)?.name ?? path;
      const { createExportJobRunner } = await import(/* @vite-ignore */ url);
      return createExportJobRunner()("exportAudio", { format });
    }, format);
    if (!result.ok) {
      expect(result.error).toMatch(new RegExp(`cannot encode ${format}`, "i"));
      expect(optionalDownloads.length).toBe(before);
      continue;
    }
    await expect.poll(() => optionalDownloads.length).toBe(before + 1);
    const output = testInfo.outputPath(`agent.${format}`);
    await optionalDownloads[before].saveAs(output);
    const probe = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-show_entries", "stream=codec_name", "-of", "json", output], { encoding: "utf8" }));
    expect(probe.streams[0].codec_name).toBe(format);
  }
});

test("streams a transparent PNG sequence to a valid ZIP in the browser memory fallback", async ({ page }, testInfo) => {
  test.skip(!hasBinary(ffmpeg) || !hasBinary("unzip"), "ffmpeg and unzip are required for media checks");
  await page.addInitScript(() => {
    Object.defineProperty(navigator.storage, "getDirectory", { configurable: true, value: undefined });
  });
  await openEditor(page);
  const downloadPromise = page.waitForEvent("download", { timeout: 120_000 });
  const job = page.evaluate(async () => {
    const projectPath = "/src/stores/project-store.ts";
    const projectUrl = performance.getEntriesByType("resource").find((entry) => new URL(entry.name).pathname === projectPath)?.name ?? projectPath;
    const { useProjectStore } = await import(/* @vite-ignore */ projectUrl);
    const { exportMotionCompositionScene } = await import("/src/motion/export-motion-frame.ts");
    const composition = {
      id: "e2e-transparent-scene", name: "Transparent scene", width: 64, height: 64,
      frameRate: 2, duration: 1, backgroundColor: "transparent", assets: [], variables: [], markers: [], guides: [],
      createdAt: Date.now(), modifiedAt: Date.now(),
      layers: [{
        id: "e2e-shape", type: "shape", name: "Red square", startTime: 0, duration: 1, visible: true, locked: false,
        transform: { position: { x: 32, y: 32 }, scale: { x: 1, y: 1 }, rotation: 0, anchor: { x: 0.5, y: 0.5 }, opacity: 1 },
        keyframes: [], shapeType: "rectangle", width: 24, height: 24,
        style: { fill: { type: "solid", color: "#ff0000", opacity: 1 }, stroke: { color: "#ff0000", width: 0, opacity: 0 } },
      }],
    };
    return exportMotionCompositionScene({ project: useProjectStore.getState().project, composition, format: "png-sequence" });
  });
  const [download, result] = await Promise.all([downloadPromise, job]);
  expect(result.framesRendered).toBe(2);
  const zip = testInfo.outputPath("transparent-frames.zip");
  await download.saveAs(zip);
  expect(readFileSync(zip).length).toBeGreaterThan(100);
  const listing = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).trim().split("\n");
  expect(listing).toEqual(["frame-00001.png", "frame-00002.png"]);
  execFileSync("unzip", ["-t", zip]);
  const png = testInfo.outputPath("frame.png");
  writeFileSync(png, execFileSync("unzip", ["-p", zip, listing[0]]));
  const rgba = execFileSync(ffmpeg, ["-v", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
  expect(rgba[(2 * 64 + 2) * 4 + 3]).toBe(0);
  expect(rgba[(32 * 64 + 32) * 4]).toBeGreaterThan(200);
  expect(rgba[(32 * 64 + 32) * 4 + 3]).toBe(255);
});

test("exports a five-second 1080p timeline at 30 fps", async ({ page }, testInfo) => {
  test.skip(process.env.KOVE_E2E_HD_EXPORT !== "1", "Set KOVE_E2E_HD_EXPORT=1 for the full-HD export");
  test.skip(!hasBinary(ffmpeg) || !hasBinary(ffprobe), "ffmpeg and ffprobe are required to verify output");
  test.setTimeout(480_000);
  await openEditor(page);
  const settings = { width: 1920, height: 1080, frameRate: 30 };
  await putOnTimeline(page, await makePicture(page, testInfo), 5, settings);
  await exportAndCheck(page, testInfo, false, 5, settings);
});

test("preserves audio across the 15-second chunk boundary", async ({ page }, testInfo) => {
  test.skip(process.env.KOVE_E2E_LONG_EXPORT !== "1", "Set KOVE_E2E_LONG_EXPORT=1 for the longer export");
  test.skip(!hasBinary(ffmpeg) || !hasBinary(ffprobe), "ffmpeg and ffprobe are required to create and verify output");
  test.setTimeout(480_000);
  await page.route("https://unpkg.com/**", (route) => route.abort());
  await openEditor(page);
  const picture = await makePicture(page, testInfo);
  const source = testInfo.outputPath("generated-long-source.mp4");
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", "4", "-i", picture, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "16", "-c:v", "libx264", "-threads", "1", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source]);
  await putOnTimeline(page, source, 16);
  const output = await exportAndCheck(page, testInfo, true, 16);
  const tail = spawnSync(ffmpeg, ["-hide_banner", "-ss", "15.2", "-t", "0.6", "-i", output, "-af", "volumedetect", "-vn", "-f", "null", "-"], { encoding: "utf8" });
  expect(tail.status).toBe(0);
  const tailMean = Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(tail.stderr)?.[1]);
  expect(Number.isFinite(tailMean)).toBe(true);
  expect(tailMean).toBeGreaterThan(-50);
});

test("soaks a one-minute 1080p export with audio", async ({ page }, testInfo) => {
  test.skip(process.env.KOVE_E2E_SOAK_EXPORT !== "1", "Set KOVE_E2E_SOAK_EXPORT=1 for the one-minute export");
  test.skip(!hasBinary(ffmpeg) || !hasBinary(ffprobe), "ffmpeg and ffprobe are required to create and verify output");
  test.setTimeout(900_000);
  await page.route("https://unpkg.com/**", (route) => route.abort());
  await openEditor(page);
  const picture = await makePicture(page, testInfo);
  const source = testInfo.outputPath("generated-one-minute-source.mp4");
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", "4", "-i", picture, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "60", "-c:v", "libx264", "-threads", "1", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source]);
  const settings = { width: 1920, height: 1080, frameRate: 30 };
  await putOnTimeline(page, source, 60, settings);
  const output = await exportAndCheck(page, testInfo, true, 60, settings);
  const tail = spawnSync(ffmpeg, ["-hide_banner", "-ss", "59.1", "-t", "0.5", "-i", output, "-af", "volumedetect", "-vn", "-f", "null", "-"], { encoding: "utf8" });
  expect(tail.status).toBe(0);
  const mean = Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(tail.stderr)?.[1]);
  expect(Number.isFinite(mean)).toBe(true);
  expect(mean).toBeGreaterThan(-50);
});

test("cancels a genuinely stalled encoder without reporting success", async ({ page }, testInfo) => {
  await openEditor(page);
  await putOnTimeline(page, await makePicture(page, testInfo));
  await page.evaluate(async (url) => {
    const loaded = performance.getEntriesByType("resource").find((entry) => new URL(entry.name).pathname.endsWith("/packages/core/src/export/webcodecs-backend.ts"))?.name ?? url;
    const { WebCodecsBackend } = await import(/* @vite-ignore */ loaded);
    WebCodecsBackend.prototype.addVideoFrame = async () => {
      (window as unknown as { __encoderBlocked: boolean }).__encoderBlocked = true;
      return new Promise(() => {});
    };
  }, backendUrl);
  let downloaded = false;
  page.on("download", () => { downloaded = true; });
  await page.getByRole("button", { name: "Export", exact: true }).first().click();
  await page.waitForFunction(() => (window as unknown as { __encoderBlocked?: boolean }).__encoderBlocked, undefined, { timeout: 60_000 });
  await page.getByRole("button", { name: "Cancel export" }).click();
  await expect(page.getByRole("button", { name: "Export", exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(2500);
  expect(downloaded).toBe(false);
  expect((await states(page)).some((state) => state.complete)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("cancelled.png") });
});

test("shows an actionable encoder failure instead of a completed export", async ({ page }, testInfo) => {
  await openEditor(page);
  await putOnTimeline(page, await makePicture(page, testInfo));
  await page.evaluate(async (url) => {
    const loaded = performance.getEntriesByType("resource").find((entry) => new URL(entry.name).pathname.endsWith("/packages/core/src/export/webcodecs-backend.ts"))?.name ?? url;
    const { WebCodecsBackend } = await import(/* @vite-ignore */ loaded);
    WebCodecsBackend.prototype.start = async () => { throw new Error("Simulated encoder failure"); };
  }, backendUrl);
  await page.getByRole("button", { name: "Export", exact: true }).first().click();
  const error = page.getByRole("button", { name: /Dismiss export error: Simulated encoder failure/ });
  await expect(error).toBeVisible({ timeout: 30_000 });
  expect(await error.getAttribute("title")).toContain("Simulated encoder failure");
  expect((await states(page)).some((state) => state.error?.includes("Simulated encoder failure") && !state.complete)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("error.png") });
});
