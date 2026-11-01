import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WasmFFT, isWasmFFTAvailable } from "./fft";
import { BeatDetectionProcessor, isWasmBeatDetectionAvailable } from "./beat-detection";
import { WavEncoder, isWasmWavAvailable } from "./wav";

const run = promisify(execFile);
const asc = fileURLToPath(new URL("../../node_modules/assemblyscript/bin/asc.js", import.meta.url));
const modules = {
  fft: new URL("./fft/assembly/index.ts", import.meta.url),
  beat: new URL("./beat-detection/assembly/index.ts", import.meta.url),
  wav: new URL("./wav/assembly/index.ts", import.meta.url),
};

describe("raw AssemblyScript modules use the safe audio fallback", () => {
  let dir: string;
  const binaries = new Map<string, Uint8Array>();

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "kove-wasm-abi-"));
    // Compile the actual sources, rather than relying on ignored build artifacts
    // or a mock whose ABI might accidentally conceal a pointer mismatch.
    await Promise.all(Object.entries(modules).map(async ([name, source]) => {
      const output = path.join(dir, `${name}.wasm`);
      await run(process.execPath, [asc, fileURLToPath(source), "-o", output, "--optimize", "--runtime", "stub"], { timeout: 30_000 });
      binaries.set(name, Uint8Array.from(await readFile(output)));
    }));
    vi.stubGlobal("fetch", vi.fn(async (input: URL | string) => {
      const name = String(input).match(/\/(fft|beat|wav)\.wasm$/)?.[1];
      const bytes = name ? binaries.get(name) : undefined;
      return { ok: Boolean(bytes), arrayBuffer: async () => bytes!.slice().buffer };
    }));
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("keeps FFT analysis nonzero when raw exports only accept pointers", async () => {
    const fft = new WasmFFT(8);
    expect(await fft.ensureWasm()).toBe(false);
    expect(isWasmFFTAvailable()).toBe(false);
    const result = fft.forward(Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]));
    expect(Array.from(result.real)).toEqual(Array(8).fill(1));
    expect(Array.from(result.imag)).toEqual(Array(8).fill(0));
  });

  it("keeps beat energies and statistics meaningful", async () => {
    const processor = new BeatDetectionProcessor();
    expect(await processor.ensureWasm()).toBe(false);
    expect(isWasmBeatDetectionAvailable()).toBe(false);
    const energies = new Float32Array(2);
    processor.computeRMSEnergies(Float32Array.from([1, 1, 1, 1]), 2, 2, energies);
    expect(Array.from(energies)).toEqual([1, 1]);
    expect(processor.calculateMedian(Float32Array.from([1, 3, 2]))).toBe(2);
  });

  it("writes a valid WAV header and real PCM samples", async () => {
    const encoder = new WavEncoder();
    expect(await encoder.ensureWasm()).toBe(false);
    expect(isWasmWavAvailable()).toBe(false);
    const wav = encoder.encodeFullWav([Float32Array.from([0.5, -0.5])], 48_000, 16);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(48_000);
    expect(new DataView(wav.buffer).getInt16(44, true)).toBeGreaterThan(16_000);
    expect(new DataView(wav.buffer).getInt16(46, true)).toBeLessThan(-16_000);
  });
});
