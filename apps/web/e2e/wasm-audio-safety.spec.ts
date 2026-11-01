import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { hasBrowser } from "../playwright.config";

const core = resolve(process.cwd(), "../../packages/core/src/wasm");
const paths = {
  fft: `${core}/fft`,
  beat: `${core}/beat-detection`,
  wav: `${core}/wav`,
};
const files = {
  fft: `${paths.fft}/build/fft.wasm`,
  beat: `${paths.beat}/build/beat.wasm`,
  wav: `${paths.wav}/build/wav.wasm`,
};
const url = (path: string) => `/@fs${path}`;

test("real compiled audio WASM exchanges typed arrays correctly in Chromium", async ({ page }) => {
  test.skip(!hasBrowser(), "Chromium is not installed; set KOVE_E2E_CHROMIUM");
  test.skip(!Object.values(files).every(existsSync), "Run pnpm build:wasm before this test");
  await page.goto("/");
  const result = await page.evaluate(async ({ modules, binaries }) => {
    // Confirm we actually loaded valid compiled modules, not a 404 fallback.
    const exports = await Promise.all(Object.values(binaries).map(async (path) => {
      const response = await fetch(path);
      if (!response.ok) throw new Error(`Missing compiled WASM: ${path}`);
      return WebAssembly.Module.exports(await WebAssembly.compile(await response.arrayBuffer())).map((entry) => entry.name);
    }));
    const [fftModule, beatModule, wavModule] = await Promise.all([
      import(/* @vite-ignore */ modules.fft),
      import(/* @vite-ignore */ modules.beat),
      import(/* @vite-ignore */ modules.wav),
    ]);
    const fft = new fftModule.WasmFFT(8);
    const beat = new beatModule.BeatDetectionProcessor();
    const wav = new wavModule.WavEncoder();
    const accelerated = await Promise.all([fft.ensureWasm(), beat.ensureWasm(), wav.ensureWasm()]);
    const spectrum = fft.forward(Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]));
    const energies = new Float32Array(2);
    beat.computeRMSEnergies(Float32Array.from([1, 1, 1, 1]), 2, 2, energies);
    const bytes: Uint8Array = wav.encodeFullWav([Float32Array.from([0.5, -0.5])], 48_000, 16);
    return {
      exports,
      accelerated,
      stillUsingWasm: [fft.isUsingWasm(), beat.isUsingWasm(), wav.isUsingWasm()],
      spectrum: Array.from(spectrum.real),
      energies: Array.from(energies),
      riff: new TextDecoder().decode(bytes.subarray(0, 4)),
      samples: [new DataView(bytes.buffer).getInt16(44, true), new DataView(bytes.buffer).getInt16(46, true)],
    };
  }, {
    modules: { fft: url(`${paths.fft}/index.ts`), beat: url(`${paths.beat}/index.ts`), wav: url(`${paths.wav}/index.ts`) },
    binaries: { fft: url(files.fft), beat: url(files.beat), wav: url(files.wav) },
  });
  expect(result.exports.every((entries) => entries.includes("allocateF32") && entries.includes("__pin") && entries.includes("__unpin"))).toBe(true);
  expect(result.accelerated).toEqual([true, true, true]);
  expect(result.stillUsingWasm).toEqual([true, true, true]);
  expect(result.spectrum).toEqual(Array(8).fill(1));
  expect(result.energies).toEqual([1, 1]);
  expect(result.riff).toBe("RIFF");
  expect(result.samples[0]).toBeGreaterThan(16_000);
  expect(result.samples[1]).toBeLessThan(-16_000);
});
