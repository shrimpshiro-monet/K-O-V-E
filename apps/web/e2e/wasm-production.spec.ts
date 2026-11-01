import { expect, test } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { hasBrowser } from "../playwright.config";

const productionUrl = process.env.KOVE_E2E_PRODUCTION_URL;
const ffmpeg = process.env.KOVE_E2E_FFMPEG ?? "ffmpeg";
const ffprobe = process.env.KOVE_E2E_FFPROBE ?? "ffprobe";
const hasBinary = (binary: string) => spawnSync(binary, ["-version"], { stdio: "ignore" }).status === 0;

test("production bundle executes the real WASM encoder for a toolbar WAV", async ({ page }, testInfo) => {
  test.skip(!hasBrowser() || !productionUrl, "Set KOVE_E2E_PRODUCTION_URL to a built app and provide Chromium");
  test.skip(!hasBinary(ffmpeg) || !hasBinary(ffprobe), "ffmpeg and ffprobe are required for media checks");
  await page.addInitScript(() => {
    localStorage.setItem("kove-advanced-onboarding-complete", "true");
    localStorage.setItem("kove-advanced-mograph-tour-complete", "true");
    delete (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker;
    const tracker = window as Window & { __wav24WasmCalls?: number };
    tracker.__wav24WasmCalls = 0;
    const nativeInstantiate = WebAssembly.instantiate.bind(WebAssembly);
    WebAssembly.instantiate = (async (source: BufferSource | WebAssembly.Module, imports?: WebAssembly.Imports) => {
      if (source instanceof WebAssembly.Module) return nativeInstantiate(source, imports);
      const result = await nativeInstantiate(source, imports);
      const exports = { ...result.instance.exports };
      const encode = exports.encodeWav24Stereo;
      if (typeof encode !== "function") return result;
      // Wrap the real export, not its output. The load self-test only calls the
      // 16-bit mono routine, so this counter proves the toolbar called 24-bit
      // stereo WASM in the production bundle.
      exports.encodeWav24Stereo = (...args: number[]) => {
        tracker.__wav24WasmCalls = (tracker.__wav24WasmCalls ?? 0) + 1;
        return encode(...args);
      };
      return { module: result.module, instance: { exports } };
    }) as typeof WebAssembly.instantiate;
  });
  await page.route("https://unpkg.com/**", (route) => route.abort());
  await page.goto(`${productionUrl!.replace(/\/$/, "")}/#new`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Import Media" }).first().waitFor({ timeout: 90_000 });

  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#df563e"; ctx.fillRect(0, 0, 160, 180);
    ctx.fillStyle = "#207ecb"; ctx.fillRect(160, 0, 160, 180);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const picture = testInfo.outputPath("production-picture.png");
  const source = testInfo.outputPath("production-source.mp4");
  writeFileSync(picture, Buffer.from(image, "base64"));
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", "4", "-i", picture,
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1", "-c:v", "libx264", "-threads", "1",
    "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source]);

  await page.locator('input[aria-label="Import media"]').setInputFiles(source);
  const tile = page.locator('img[alt$="production-source.mp4"]').first();
  await tile.waitFor({ timeout: 90_000 });
  await tile.hover();
  await page.getByRole("button", { name: "Add to timeline" }).first().click();
  const keep = page.getByRole("button", { name: "Keep Current" });
  if (await keep.isVisible().catch(() => false)) await keep.click();
  await page.getByRole("button", { name: /Select clip/i }).first().waitFor({ timeout: 30_000 });

  await page.getByRole("button", { name: "Export options" }).click();
  const event = page.waitForEvent("download", { timeout: 120_000 });
  await page.getByText("Audio Only (WAV)").click();
  const output = testInfo.outputPath("production-wasm.wav");
  await (await event).saveAs(output);
  const metadata = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", output], { encoding: "utf8" }));
  expect(metadata.streams[0]).toMatchObject({ codec_name: "pcm_s24le", sample_rate: "48000", channels: 2 });
  expect(Number(metadata.format.duration)).toBeCloseTo(1, 1);
  const volume = spawnSync(ffmpeg, ["-hide_banner", "-i", output, "-af", "volumedetect", "-vn", "-f", "null", "-"], { encoding: "utf8" });
  expect(volume.status).toBe(0);
  expect(Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(volume.stderr)?.[1])).toBeGreaterThan(-50);
  expect(await page.evaluate(() => (window as Window & { __wav24WasmCalls?: number }).__wav24WasmCalls)).toBeGreaterThan(0);
});
