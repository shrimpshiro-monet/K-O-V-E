import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { FFT } from "../audio/fft";
import { SpectralNoiseReducer } from "../audio/noise-reduction";
import { BeatDetectionEngine } from "../audio/beat-detection-engine";
import { WasmFFT, isWasmFFTAvailable } from "./fft";
import { BeatDetectionProcessor, isWasmBeatDetectionAvailable } from "./beat-detection";
import { WavEncoder, isWasmWavAvailable } from "./wav";
import { TypedArrayBindings, fetchAudioWasm, inputArray, outputArray } from "./typed-array-bindings";

const run = promisify(execFile);
const asc = fileURLToPath(new URL("../../node_modules/assemblyscript/bin/asc.js", import.meta.url));
const modules = {
  fft: new URL("./fft/assembly/index.ts", import.meta.url),
  beat: new URL("./beat-detection/assembly/index.ts", import.meta.url),
  wav: new URL("./wav/assembly/index.ts", import.meta.url),
};

function expectClose(actual: Float32Array, expected: Float32Array, tolerance = 1e-4): void {
  expect(actual.length).toBe(expected.length);
  let largestDifference = 0;
  for (let i = 0; i < actual.length; i++) {
    if (Number.isNaN(expected[i])) {
      expect(Number.isNaN(actual[i])).toBe(true);
    } else if (!Number.isFinite(expected[i])) {
      expect(actual[i]).toBe(expected[i]);
    } else {
      expect(Number.isFinite(actual[i])).toBe(true);
      largestDifference = Math.max(largestDifference, Math.abs(actual[i] - expected[i]));
    }
  }
  expect(largestDifference).toBeLessThanOrEqual(tolerance);
}

function expectBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.byteLength).toBe(expected.byteLength);
  expect(Buffer.compare(Buffer.from(actual), Buffer.from(expected))).toBe(0);
}

describe("real AssemblyScript audio bindings", () => {
  let dir: string;
  const binaries = new Map<string, Uint8Array>();
  let fft: WasmFFT;
  let beat: BeatDetectionProcessor;
  let beatJs: BeatDetectionProcessor;
  let wav: WavEncoder;
  let wavJs: WavEncoder;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "kove-wasm-abi-"));
    // Build the actual source code rather than mocks or ignored build outputs.
    await Promise.all(Object.entries(modules).map(async ([name, source]) => {
      const output = path.join(dir, `${name}.wasm`);
      await run(process.execPath, [asc, fileURLToPath(source), "-o", output, "--optimize", "--runtime", "incremental", "--exportRuntime"], { timeout: 30_000 });
      binaries.set(name, Uint8Array.from(await readFile(output)));
    }));
    const stubOutput = path.join(dir, "wav-stub.wasm");
    await run(process.execPath, [asc, fileURLToPath(modules.wav), "-o", stubOutput, "--optimize", "--runtime", "stub"], { timeout: 30_000 });
    binaries.set("wav-stub", Uint8Array.from(await readFile(stubOutput)));

    vi.stubGlobal("fetch", vi.fn(async (input: URL | string) => {
      const name = String(input).match(/\/(fft|beat|wav)\.wasm$/)?.[1];
      const bytes = name ? binaries.get(name) : undefined;
      return { ok: Boolean(bytes), arrayBuffer: async () => bytes!.slice().buffer };
    }));

    // Capture baseline JS instances before their corresponding modules load.
    beatJs = new BeatDetectionProcessor();
    wavJs = new WavEncoder();
    fft = new WasmFFT(1024);
    beat = new BeatDetectionProcessor();
    wav = new WavEncoder();
    expect(await Promise.all([fft.ensureWasm(), beat.ensureWasm(), wav.ensureWasm()])).toEqual([true, true, true]);
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("loads all three managed modules and actually enables their WASM paths", () => {
    expect([isWasmFFTAvailable(), isWasmBeatDetectionAvailable(), isWasmWavAvailable()]).toEqual([true, true, true]);
    expect([fft.isUsingWasm(), beat.isUsingWasm(), wav.isUsingWasm()]).toEqual([true, true, true]);
    expect([beatJs.isUsingWasm(), wavJs.isUsingWasm()]).toEqual([false, false]);
  });

  it("matches JS FFT, inverse, magnitude, phase, windows, and input subarrays", () => {
    const source = new Float32Array(1100);
    for (let i = 0; i < source.length; i++) source[i] = Math.sin(i * 0.07) + 0.2 * Math.cos(i * 0.29);
    const input = source.subarray(7, 1031);
    const js = new FFT(1024);
    const expected = js.forward(input);
    const actual = fft.forward(input);
    expectClose(actual.real, expected.real, 0.0005);
    expectClose(actual.imag, expected.imag, 0.0005);
    expectClose(fft.inverse(actual.real, actual.imag), js.inverse(actual.real, actual.imag), 0.0001);
    expectClose(fft.getMagnitude(actual.real, actual.imag), js.getMagnitude(actual.real, actual.imag), 0.0005);
    const polar = fft.getMagnitudeAndPhase(actual.real, actual.imag);
    const expectedPolar = js.getMagnitudeAndPhase(actual.real, actual.imag);
    expectClose(polar.magnitudes, expectedPolar.magnitudes, 0.0005);
    expectClose(polar.phases, expectedPolar.phases, 0.0001);
    const restored = fft.fromMagnitudeAndPhase(polar.magnitudes, polar.phases);
    const expectedRestored = js.fromMagnitudeAndPhase(polar.magnitudes, polar.phases);
    expectClose(restored.real, expectedRestored.real, 0.0005);
    expectClose(restored.imag, expectedRestored.imag, 0.0005);
    expectClose(fft.applyHannWindow(input), js.applyHannWindow(input), 0.0001);
    const hugeReal = new Float32Array(512).fill(1e30);
    const hugeImag = new Float32Array(512).fill(1e30);
    expect(Array.from(fft.getMagnitude(hugeReal, hugeImag))).toEqual(Array.from(js.getMagnitude(hugeReal, hugeImag)));
    expect(Number.isFinite(fft.getMagnitudeAndPhase(hugeReal, hugeImag).magnitudes[0])).toBe(true);
    expect(fft.isUsingWasm()).toBe(true);
  });

  it("safely handles short frames and interleaved FFT sizes", () => {
    for (const invalid of [NaN, Infinity, 1.5, 0, 3, 0x40000000]) {
      expect(() => new WasmFFT(invalid)).toThrow(/power of 2/);
    }
    const small = new WasmFFT(8);
    const large = new WasmFFT(32);
    expect(small.isUsingWasm()).toBe(true);
    expect(large.isUsingWasm()).toBe(true);
    const short = Float32Array.of(1, Number.NaN, 0.5);
    expectClose(small.forward(short).real, new FFT(8).forward(short).real);
    expectClose(large.forward(Float32Array.of(1, 2)).real, new FFT(32).forward(Float32Array.of(1, 2)).real);
    expectClose(small.forward(short).real, new FFT(8).forward(short).real);
    // The WASM routines use unchecked indexes; oversized polar input must use
    // the JS path rather than write beyond a WASM array.
    const mags = new Float32Array(10).fill(1);
    expectClose(small.fromMagnitudeAndPhase(mags, mags).real, new FFT(8).fromMagnitudeAndPhase(mags, mags).real);
    expect(small.isUsingWasm()).toBe(true);
  });

  it("matches JS WAV headers and PCM for mono/stereo 16/24-bit over chunk boundaries", () => {
    const leftBacking = new Float32Array(131_100);
    const rightBacking = new Float32Array(131_100);
    for (let i = 0; i < leftBacking.length; i++) {
      leftBacking[i] = Math.sin(i * 0.011) * 1.2;
      rightBacking[i] = Math.cos(i * 0.013) * 0.8;
    }
    leftBacking.set([0, 0.5, -0.5, 1, -1, Number.NaN, Infinity, -Infinity], 5);
    const left = leftBacking.subarray(5, 131_085);
    const right = rightBacking.subarray(5, 131_085);
    for (const depth of [16, 24] as const) {
      for (const channels of [[left], [left, right]]) {
        expectBytes(wav.encodeFullWav(channels, 48_000, depth), wavJs.encodeFullWav(channels, 48_000, depth));
        expect(wav.isUsingWasm()).toBe(true);
      }
    }
    expect(() => wav.encodeFullWav([], 48_000)).toThrow(/one or two channels/i);
    expect(() => wav.encodeFullWav([left, right.subarray(1)], 48_000)).toThrow(/equal sample/i);
    const tooLong = { length: 0x80000000 } as unknown as Float32Array;
    expect(() => wav.encodeFullWav([tooLong], 48_000, 16)).toThrow(/4 GiB RIFF/);
  }, 30_000);

  it("preserves untouched WAV bytes and safely falls back for undersized output", async () => {
    const output = new Uint8Array(60).fill(0xa5);
    wav.writeWavHeader(output, 1, 44_100, 16, 2);
    expect(Array.from(output.subarray(44))).toEqual(Array(16).fill(0xa5));
    const tiny = new Uint8Array(3).fill(0);
    const expected = tiny.slice();
    wavJs.encodeWav16Mono(Float32Array.of(1, -1), expected, 0);
    wav.encodeWav16Mono(Float32Array.of(1, -1), tiny, 0);
    expectBytes(tiny, expected);
    // An unsupported shape should not disable acceleration for later calls.
    expect(wav.isUsingWasm()).toBe(true);
    expect(await wav.ensureWasm()).toBe(true);
  });

  it("preserves order-dependent PCM results for overlapping typed-array views", () => {
    for (const kind of ["mono16", "stereo16", "stereo24"] as const) {
      const actualBuffer = new ArrayBuffer(48);
      const left = new Float32Array(actualBuffer, 0, 4);
      const right = new Float32Array(actualBuffer, 16, 4);
      left.set([0.25, -0.5, 0.75, -1]);
      right.set([0.5, -0.25, 0.1, 1]);
      const expectedBuffer = actualBuffer.slice(0);
      const actualOutput = new Uint8Array(actualBuffer);
      const expectedOutput = new Uint8Array(expectedBuffer);
      const expectedLeft = new Float32Array(expectedBuffer, 0, 4);
      const expectedRight = new Float32Array(expectedBuffer, 16, 4);
      if (kind === "mono16") {
        wav.encodeWav16Mono(left, actualOutput, 0);
        wavJs.encodeWav16Mono(expectedLeft, expectedOutput, 0);
      } else if (kind === "stereo16") {
        wav.encodeWav16Stereo(left, right, actualOutput, 0);
        wavJs.encodeWav16Stereo(expectedLeft, expectedRight, expectedOutput, 0);
      } else {
        wav.encodeWav24Stereo(left, right, actualOutput, 0);
        wavJs.encodeWav24Stereo(expectedLeft, expectedRight, expectedOutput, 0);
      }
      expectBytes(actualOutput, expectedOutput);
      expect(wav.isUsingWasm()).toBe(true);
    }
  });

  it("matches JS beat energies, including partial and long chunked windows", () => {
    const samples = new Float32Array(410_000);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i * 0.043) * 0.7;
    const actual = new Float32Array(2_000);
    const expected = new Float32Array(actual.length);
    beat.computeRMSEnergies(samples, 1024, 256, actual);
    beatJs.computeRMSEnergies(samples, 1024, 256, expected);
    expectClose(actual, expected, 1e-6);
    const partial = new Float32Array(3);
    const expectedPartial = new Float32Array(3);
    beat.computeRMSEnergies(Float32Array.of(1, 1, 1, 1, 1), 8, 2, partial);
    beatJs.computeRMSEnergies(Float32Array.of(1, 1, 1, 1, 1), 8, 2, expectedPartial);
    expectClose(partial, expectedPartial, 1e-6);
    expect(beat.isUsingWasm()).toBe(true);
  });

  it("keeps exceptionally large RMS windows out of the WASM heap", () => {
    const samples = new Float32Array(180_000).fill(0.5);
    const actual = new Float32Array(3);
    const expected = new Float32Array(3);
    const call = vi.spyOn(TypedArrayBindings.prototype, "call");
    try {
      beat.computeRMSEnergies(samples, 140_000, 1000, actual);
      beatJs.computeRMSEnergies(samples, 140_000, 1000, expected);
      expectClose(actual, expected, 1e-6);
      expect(call).not.toHaveBeenCalled();
      expect(beat.isUsingWasm()).toBe(true);
    } finally {
      call.mockRestore();
    }
  });

  it("matches smoothing, median, peaks, mean and standard deviation", () => {
    const input = Float32Array.from([0, 0.2, 0.9, 0.1, 0.8, 0.2, 0.01, 0.95, 0.1]);
    for (const window of [3, 4, 5]) {
      const actual = new Float32Array(input.length);
      const expected = new Float32Array(input.length);
      beat.smoothArray(input, actual, window);
      beatJs.smoothArray(input, expected, window);
      expectClose(actual, expected, 1e-6);
    }
    for (const values of [Float32Array.of(8, 1, 5), Float32Array.of(5, 1, 8, 3), new Float32Array(100_000)]) {
      expect(beat.calculateMedian(values)).toBeCloseTo(beatJs.calculateMedian(values), 6);
    }
    const actualPeaks = new Int32Array(6).fill(-1);
    const expectedPeaks = new Int32Array(6).fill(-1);
    expect(beat.findPeaks(input, 0.5, 2, actualPeaks)).toBe(beatJs.findPeaks(input, 0.5, 2, expectedPeaks));
    expect(Array.from(actualPeaks)).toEqual(Array.from(expectedPeaks));
    const mean = beatJs.calculateMean(input);
    expect(beat.calculateMean(input)).toBeCloseTo(mean, 6);
    expect(beat.calculateStdDev(input, mean)).toBeCloseTo(beatJs.calculateStdDev(input, mean), 6);
    const huge = Float32Array.of(3e38, 3e38);
    expect(beat.calculateMedian(huge)).toBe(beatJs.calculateMedian(huge));
    const precise = Float32Array.of(1, 2, 2);
    expect(beat.calculateMean(precise)).toBe(beatJs.calculateMean(precise));
    expect(beat.calculateStdDev(precise, 5 / 3)).toBe(beatJs.calculateStdDev(precise, 5 / 3));
    const veryDistant = new Int32Array(1);
    expect(beat.findPeaks(Float32Array.of(0, 1, 0), 0.5, 0x7fffffff, veryDistant)).toBe(1);
    expect(veryDistant[0]).toBe(1);
    expect(beat.isUsingWasm()).toBe(true);
  });

  it("preserves order-dependent behavior when input and output overlap", () => {
    const actual = Float32Array.of(1, 2, 3, 4, 5);
    const expected = actual.slice();
    beat.smoothArray(actual, actual, 3);
    beatJs.smoothArray(expected, expected, 3);
    expectClose(actual, expected, 1e-6);
    const actualEnergies = Float32Array.of(1, 2, 3, 4, 5);
    const expectedEnergies = actualEnergies.slice();
    beat.computeRMSEnergies(actualEnergies, 3, 1, actualEnergies);
    beatJs.computeRMSEnergies(expectedEnergies, 3, 1, expectedEnergies);
    expectClose(actualEnergies, expectedEnergies, 1e-6);
    const actualPeaksBuffer = new ArrayBuffer(5 * 4);
    const expectedPeaksBuffer = new ArrayBuffer(5 * 4);
    new Float32Array(actualPeaksBuffer).set([0, 1, 0, 0.8, 0]);
    new Float32Array(expectedPeaksBuffer).set([0, 1, 0, 0.8, 0]);
    expect(beat.findPeaks(new Float32Array(actualPeaksBuffer), 0.5, 1, new Int32Array(actualPeaksBuffer)))
      .toBe(beatJs.findPeaks(new Float32Array(expectedPeaksBuffer), 0.5, 1, new Int32Array(expectedPeaksBuffer)));
    expectBytes(new Uint8Array(actualPeaksBuffer), new Uint8Array(expectedPeaksBuffer));
    expect(beat.isUsingWasm()).toBe(true);
  });

  it("runs the real noise-profile and beat-analysis consumers with WASM enabled", async () => {
    const rate = 48_000;
    const makeBuffer = (samples: Float32Array) => ({
      length: samples.length,
      duration: samples.length / rate,
      sampleRate: rate,
      numberOfChannels: 1,
      getChannelData: () => samples,
    }) as unknown as AudioBuffer;
    const tone = Float32Array.from({ length: 8192 }, (_, i) => 0.18 * Math.sin(2 * Math.PI * 6000 * i / rate));
    const mixed = Float32Array.from(tone, (sample, i) => sample + 0.38 * Math.sin(2 * Math.PI * 440 * i / rate));
    const reducer = new SpectralNoiseReducer({ reduction: 0.92, smoothing: 0.06, threshold: -55 });
    const profile = reducer.learnNoiseProfile(makeBuffer(tone));
    const peakBin = profile.magnitudes.indexOf(Math.max(...profile.magnitudes));
    expect(profile.frequencyBins[peakBin]).toBeCloseTo(6000, 0);
    expect(profile.magnitudes[peakBin]).toBeGreaterThan(1);
    reducer.setNoiseProfile(profile);
    const context = { createBuffer: (_channels: number, length: number) => makeBuffer(new Float32Array(length)) } as unknown as BaseAudioContext;
    const filtered = (await reducer.processBuffer(makeBuffer(mixed), context)).getChannelData(0);
    const amplitude = (data: Float32Array, frequency: number) => {
      let sin = 0;
      let cos = 0;
      for (let i = 0; i < data.length; i++) {
        sin += data[i] * Math.sin(2 * Math.PI * frequency * i / rate);
        cos += data[i] * Math.cos(2 * Math.PI * frequency * i / rate);
      }
      return 2 * Math.hypot(sin, cos) / data.length;
    };
    expect(amplitude(filtered, 6000) / amplitude(mixed, 6000)).toBeLessThan(0.65);
    expect(amplitude(filtered, 440) / amplitude(mixed, 440)).toBeGreaterThan(0.7);
    expect((reducer as unknown as { fft: WasmFFT }).fft.isUsingWasm()).toBe(true);

    const pulses = new Float32Array(rate * 8);
    for (let start = rate / 2; start < pulses.length; start += rate / 2) {
      for (let i = 0; i < 2400; i++) pulses[start + i] = 0.8 * Math.sin(2 * Math.PI * 440 * i / rate) * (1 - i / 2400);
    }
    const engine = new BeatDetectionEngine();
    const internal = engine as unknown as { wasmProcessor: BeatDetectionProcessor | null };
    await vi.waitFor(() => expect(internal.wasmProcessor?.isUsingWasm()).toBe(true));
    const result = await engine.analyzeAudioBuffer(makeBuffer(pulses));
    expect(result.beats.length).toBeGreaterThan(5);
    expect(result.bpm).toBeGreaterThan(115);
    expect(result.bpm).toBeLessThan(125);
    expect(result.confidence).toBeGreaterThan(0);
    expect(internal.wasmProcessor?.isUsingWasm()).toBe(true);
  });

  it("reuses managed WASM memory across thousands of inverse FFT calls", async () => {
    const bytes = binaries.get("fft")!;
    const { instance } = await WebAssembly.instantiate(bytes.slice().buffer, { env: { abort: () => { throw new Error("WASM abort"); } } });
    const binding = new TypedArrayBindings(instance.exports, ["init", "inverse"]);
    binding.call("init", [2048]);
    const real = new Float32Array(2048).fill(0.25);
    const imag = new Float32Array(2048);
    const output = new Float32Array(2048);
    const execute = () => binding.call("inverse", [inputArray(real), inputArray(imag), outputArray(output)]);
    for (let i = 0; i < 300; i++) execute();
    const warmBytes = binding.memory.buffer.byteLength;
    for (let i = 0; i < 2_000; i++) execute();
    expect(binding.memory.buffer.byteLength).toBeLessThanOrEqual(Math.max(32 * 1024 * 1024, warmBytes * 2));
    expect(output[0]).toBeCloseTo(0.25, 5);
  }, 30_000);

  it("also reuses managed memory in repeated WAV and beat workloads", async () => {
    const instantiate = async (name: string) => (await WebAssembly.instantiate(binaries.get(name)!.slice().buffer, {
      env: { abort: () => { throw new Error("WASM abort"); } },
    })).instance;
    const wavBinding = new TypedArrayBindings((await instantiate("wav")).exports, ["allocateU8", "dataU8", "encodeWav16Stereo"]);
    const left = new Float32Array(8192).fill(0.5);
    const right = new Float32Array(8192).fill(-0.5);
    const bytes = new Uint8Array(8192 * 4);
    const encode = () => wavBinding.call("encodeWav16Stereo", [inputArray(left), inputArray(right), outputArray(bytes), 0]);
    for (let i = 0; i < 300; i++) encode();
    const wavWarm = wavBinding.memory.buffer.byteLength;
    for (let i = 0; i < 1200; i++) encode();
    expect(wavBinding.memory.buffer.byteLength).toBeLessThanOrEqual(Math.max(32 * 1024 * 1024, wavWarm * 2));
    expect(new DataView(bytes.buffer).getInt16(0, true)).toBe(16384);
    expect(new DataView(bytes.buffer).getInt16(2, true)).toBe(-16383);

    const beatBinding = new TypedArrayBindings((await instantiate("beat")).exports, ["calculateMedian"]);
    const silent = new Float32Array(16_384);
    const median = () => beatBinding.call("calculateMedian", [inputArray(silent)]);
    for (let i = 0; i < 300; i++) median();
    const beatWarm = beatBinding.memory.buffer.byteLength;
    for (let i = 0; i < 1200; i++) median();
    expect(beatBinding.memory.buffer.byteLength).toBeLessThanOrEqual(Math.max(32 * 1024 * 1024, beatWarm * 2));
    expect(median()).toBe(0);
  }, 30_000);

  it("falls back correctly after an actual binding failure and can re-enable WASM", async () => {
    const failure = () => { throw new WebAssembly.RuntimeError("simulated WASM trap"); };
    const acceleratedFFT = new WasmFFT(8);
    const acceleratedBeat = new BeatDetectionProcessor();
    const acceleratedWav = new WavEncoder();
    const spy = vi.spyOn(TypedArrayBindings.prototype, "call");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      spy.mockImplementationOnce(failure);
      expectClose(acceleratedFFT.forward(Float32Array.of(1, 2)).real, new FFT(8).forward(Float32Array.of(1, 2)).real);
      expect(acceleratedFFT.isUsingWasm()).toBe(false);
      spy.mockImplementationOnce(failure);
      expect(acceleratedBeat.calculateMean(Float32Array.of(1, 2, 3))).toBe(2);
      expect(acceleratedBeat.isUsingWasm()).toBe(false);
      spy.mockImplementationOnce(failure);
      expectBytes(acceleratedWav.encodeFullWav([Float32Array.of(0.5)], 48_000), wavJs.encodeFullWav([Float32Array.of(0.5)], 48_000));
      expect(acceleratedWav.isUsingWasm()).toBe(false);
      expect(warning).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
      warning.mockRestore();
    }
    expect(await Promise.all([acceleratedFFT.ensureWasm(), acceleratedBeat.ensureWasm(), acceleratedWav.ensureWasm()])).toEqual([true, true, true]);
  });

  it("reinitializes FFT tables for other instances after a partially failed size switch", () => {
    const small = new WasmFFT(8);
    const large = new WasmFFT(32); // module currently uses size 32
    const original = TypedArrayBindings.prototype.call;
    const spy = vi.spyOn(TypedArrayBindings.prototype, "call");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      spy.mockImplementationOnce(function (this: TypedArrayBindings) {
        original.call(this, "init", [16]); // simulate a mutation before init traps
        throw new WebAssembly.RuntimeError("partial initialization");
      });
      const frame = Float32Array.of(1, 2, 3);
      expectClose(small.forward(frame).real, new FFT(8).forward(frame).real);
      expect(small.isUsingWasm()).toBe(false);
      expectClose(large.forward(frame).real, new FFT(32).forward(frame).real);
      expect(large.isUsingWasm()).toBe(true);
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
      warning.mockRestore();
    }
  });

  it("rejects stale stub-runtime modules and safely falls back", async () => {
    const bytes = binaries.get("wav-stub")!;
    const { instance } = await WebAssembly.instantiate(bytes.slice().buffer, { env: { abort: () => { throw new Error("WASM abort"); } } });
    expect(() => new TypedArrayBindings(instance.exports, ["allocateU8", "dataU8"])).toThrow(/__pin/);
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => bytes.slice().buffer })));
    const { WavEncoder: StaleWavEncoder, isWasmWavAvailable: available } = await import("./wav");
    const fallback = new StaleWavEncoder();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await fallback.ensureWasm()).toBe(false);
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
    }
    expect(available()).toBe(false);
    const result = fallback.encodeFullWav([Float32Array.of(0.5, -0.5)], 48_000, 16);
    expect(new TextDecoder().decode(result.subarray(0, 4))).toBe("RIFF");
    expect(new DataView(result.buffer).getInt16(44, true)).toBe(16_384);
  });

  it("bounds and aborts a stalled optional WASM download", async () => {
    const previousFetch = globalThis.fetch;
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: URL, options: RequestInit) => {
      signal = options.signal ?? undefined;
      return new Promise(() => {}); // even an implementation that ignores abort
    }));
    try {
      expect(await fetchAudioWasm(new URL("https://example.invalid/slow.wasm"), 10)).toBeNull();
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.stubGlobal("fetch", previousFetch);
    }
  });

  it("uses JavaScript when the compiled binary is unavailable", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));
    const { WasmFFT: MissingFFT } = await import("./fft");
    const missing = new MissingFFT(8);
    expect(await missing.ensureWasm()).toBe(false);
    expectClose(missing.forward(Float32Array.of(1)).real, new Float32Array(8).fill(1));
    expect(missing.isUsingWasm()).toBe(false);
  });
});
