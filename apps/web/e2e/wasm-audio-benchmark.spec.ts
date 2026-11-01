import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { hasBrowser } from "../playwright.config";

const core = resolve(process.cwd(), "../../packages/core/src");
const wasm = `${core}/wasm`;
const url = (path: string) => `/@fs/${path.replace(/\\/g, "/").replace(/^\/+/, "")}`;

test("reports local JS and managed WASM audio timings", async ({ page }, testInfo) => {
  test.skip(process.env.KOVE_E2E_AUDIO_BENCHMARK !== "1", "Set KOVE_E2E_AUDIO_BENCHMARK=1 to run the optional benchmark");
  test.skip(!hasBrowser(), "Chromium is not installed; set KOVE_E2E_CHROMIUM");
  test.skip(!["fft/build/fft.wasm", "wav/build/wav.wasm", "beat-detection/build/beat.wasm"]
    .every((path) => existsSync(`${wasm}/${path}`)), "Run pnpm build:wasm before this test");
  await page.goto("/");
  const result = await page.evaluate(async (modules) => {
    // Query strings isolate the benchmark instances from any asynchronous app
    // initialization: the JS encoders are constructed before WASM is loaded.
    const [jsFftModule, fftModule, beatModule, wavModule] = await Promise.all([
      import(/* @vite-ignore */ modules.jsFft),
      import(/* @vite-ignore */ `${modules.fft}?benchmark`),
      import(/* @vite-ignore */ `${modules.beat}?benchmark`),
      import(/* @vite-ignore */ `${modules.wav}?benchmark`),
    ]);
    const jsFft = new jsFftModule.FFT(2048);
    const wasmFft = new fftModule.WasmFFT(2048);
    const jsWav = new wavModule.WavEncoder();
    const wasmWav = new wavModule.WavEncoder();
    const jsBeat = new beatModule.BeatDetectionProcessor();
    const wasmBeat = new beatModule.BeatDetectionProcessor();
    const jsUsingWasm = [jsWav.isUsingWasm(), jsBeat.isUsingWasm()];
    const loaded = await Promise.all([wasmFft.ensureWasm(), wasmWav.ensureWasm(), wasmBeat.ensureWasm()]);
    const samples = Float32Array.from({ length: 480_000 }, (_, i) => Math.sin(i * 0.07) * 0.6);
    const frame = samples.subarray(0, 2048);
    const energies = new Float32Array(934);
    const measure = (operation: () => unknown, count: number) => {
      const start = performance.now();
      for (let i = 0; i < count; i++) operation();
      return Math.round((performance.now() - start) * 10) / 10;
    };
    const compare = (js: () => unknown, accelerated: () => unknown, count: number) => {
      for (let i = 0; i < 20; i++) { js(); accelerated(); }
      const jsMs: number[] = [];
      const wasmMs: number[] = [];
      for (let i = 0; i < 3; i++) {
        if (i % 2 === 0) {
          jsMs.push(measure(js, count));
          wasmMs.push(measure(accelerated, count));
        } else {
          wasmMs.push(measure(accelerated, count));
          jsMs.push(measure(js, count));
        }
      }
      return { iterations: count, jsMs, wasmMs };
    };
    return {
      browser: navigator.userAgent,
      loaded,
      jsUsingWasm,
      fft2048: compare(() => jsFft.forward(frame), () => wasmFft.forward(frame), 300),
      wavStereo24Bit480kFrames: compare(
        () => jsWav.encodeFullWav([samples, samples], 48_000, 24),
        () => wasmWav.encodeFullWav([samples, samples], 48_000, 24), 12,
      ),
      rms2048Hop512: compare(
        () => jsBeat.computeRMSEnergies(samples, 2048, 512, energies),
        () => wasmBeat.computeRMSEnergies(samples, 2048, 512, energies), 12,
      ),
      stillUsingWasm: [wasmFft.isUsingWasm(), wasmWav.isUsingWasm(), wasmBeat.isUsingWasm()],
    };
  }, {
    jsFft: url(`${core}/audio/fft.ts`),
    fft: url(`${wasm}/fft/index.ts`),
    beat: url(`${wasm}/beat-detection/index.ts`),
    wav: url(`${wasm}/wav/index.ts`),
  });
  expect(result.jsUsingWasm).toEqual([false, false]);
  expect(result.loaded).toEqual([true, true, true]);
  expect(result.stillUsingWasm).toEqual([true, true, true]);
  process.stdout.write(`Audio benchmark (milliseconds; lower is better):\n${JSON.stringify(result, null, 2)}\n`);
  await testInfo.attach("audio-wasm-timings.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
});
