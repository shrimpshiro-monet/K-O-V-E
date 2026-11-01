import { TypedArrayBindings, fetchAudioWasm, arraysOverlap, inputArray, outputArray } from "../typed-array-bindings";

export type WasmBeatDetectionExports = {
  computeRMSEnergies(
    samples: Float32Array,
    windowSize: number,
    hopSize: number,
    energies: Float32Array,
  ): void;
  smoothArray(
    input: Float32Array,
    output: Float32Array,
    windowSize: number,
  ): void;
  calculateMedian(arr: Float32Array): number;
  findPeaks(
    energies: Float32Array,
    threshold: number,
    minDistance: number,
    peaks: Int32Array,
  ): number;
  calculateMean(arr: Float32Array): number;
  calculateStdDev(arr: Float32Array, mean: number): number;
  memory: WebAssembly.Memory;
};

const MAX_RMS_CHUNK_SAMPLES = 131_072;
const MAX_RMS_CHUNK_FRAMES = 512;
const MAX_I32 = 0x7fffffff;
const isPositiveI32 = (value: number): boolean => Number.isInteger(value) && value > 0 && value <= MAX_I32;
const isNonNegativeI32 = (value: number): boolean => Number.isInteger(value) && value >= 0 && value <= MAX_I32;

function bindBeatDetection(exports: WebAssembly.Exports): WasmBeatDetectionExports {
  const binding = new TypedArrayBindings(exports, [
    "allocateI32", "dataI32", "computeRMSEnergies", "smoothArray",
    "calculateMedian", "findPeaks", "calculateMean", "calculateStdDev",
  ]);
  return {
    memory: binding.memory,
    computeRMSEnergies: (samples, windowSize, hopSize, energies) => {
      if (!isPositiveI32(windowSize) || !isPositiveI32(hopSize)) {
        throw new RangeError("Invalid beat analysis window or hop size");
      }
      // Do not duplicate an entire multi-hour recording in WASM memory. Each
      // chunk includes the source samples needed for its own output windows.
      const byMemory = Math.max(1, Math.floor((MAX_RMS_CHUNK_SAMPLES - windowSize) / hopSize) + 1);
      const byI32 = Math.max(1, Math.floor((MAX_I32 - windowSize) / hopSize) + 1);
      const framesPerChunk = Math.min(MAX_RMS_CHUNK_FRAMES, byMemory, byI32);
      for (let first = 0; first < energies.length; first += framesPerChunk) {
        const count = Math.min(framesPerChunk, energies.length - first);
        const sourceStart = first * hopSize;
        const sourceEnd = Math.min(samples.length, sourceStart + (count - 1) * hopSize + windowSize);
        binding.call("computeRMSEnergies", [
          inputArray(samples.subarray(sourceStart, sourceEnd)), windowSize, hopSize,
          outputArray(energies.subarray(first, first + count)),
        ]);
      }
    },
    smoothArray: (input, output, windowSize) => {
      if (output.length < input.length || !isPositiveI32(windowSize)) {
        throw new RangeError("Invalid beat smoothing output or window size");
      }
      binding.call("smoothArray", [inputArray(input), outputArray(output.subarray(0, input.length)), windowSize]);
    },
    calculateMedian: (array) => binding.call("calculateMedian", [inputArray(array)]) ?? 0,
    findPeaks: (energies, threshold, minDistance, peaks) => {
      if (!isNonNegativeI32(minDistance)) {
        throw new RangeError("Invalid beat peak spacing");
      }
      return binding.call("findPeaks", [inputArray(energies), threshold, minDistance, outputArray(peaks)]) ?? 0;
    },
    calculateMean: (array) => binding.call("calculateMean", [inputArray(array)]) ?? 0,
    calculateStdDev: (array, mean) => binding.call("calculateStdDev", [inputArray(array), mean]) ?? 0,
  };
}

let wasmModule: WasmBeatDetectionExports | null = null;
let loadPromise: Promise<WasmBeatDetectionExports | null> | null = null;

async function loadWasmModule(): Promise<WasmBeatDetectionExports | null> {
  if (typeof WebAssembly === "undefined") {
    return null;
  }

  const wasmBytes = await fetchAudioWasm(new URL("./build/beat.wasm", import.meta.url));
  if (!wasmBytes) return null;

  try {
    const { instance } = await WebAssembly.instantiate(wasmBytes, {
      env: {
        abort: () => {
          throw new Error("WASM abort");
        },
      },
    });

    const bound = bindBeatDetection(instance.exports);
    const energies = new Float32Array(2);
    bound.computeRMSEnergies(Float32Array.of(1, 1, 1), 4, 2, energies);
    if (!Number.isFinite(energies[0]) || !Number.isFinite(energies[1]) ||
        Math.abs(energies[0] - Math.sqrt(3 / 4)) > 1e-5 || Math.abs(energies[1] - 0.5) > 1e-5) {
      throw new Error("Audio WASM beat binding failed its self-test");
    }
    return bound;
  } catch (error) {
    console.warn("[WASM beat analysis] Invalid module or failed self-test; using JavaScript:", error);
    return null;
  }
}

export async function initWasmBeatDetection(): Promise<boolean> {
  if (wasmModule) {
    return true;
  }

  if (!loadPromise) {
    loadPromise = loadWasmModule();
  }

  wasmModule = await loadPromise;
  return wasmModule !== null;
}

export function isWasmBeatDetectionAvailable(): boolean {
  return wasmModule !== null;
}

function jsComputeRMSEnergies(
  samples: Float32Array,
  windowSize: number,
  hopSize: number,
  energies: Float32Array,
): void {
  const numSamples = samples.length;
  const numFrames = energies.length;
  const invWindow = 1.0 / windowSize;

  for (let frame = 0; frame < numFrames; frame++) {
    const start = frame * hopSize;
    let sum = 0.0;

    for (let i = 0; i < windowSize && start + i < numSamples; i++) {
      const s = samples[start + i];
      sum += s * s;
    }

    energies[frame] = Math.sqrt(sum * invWindow);
  }
}

function jsSmoothArray(
  input: Float32Array,
  output: Float32Array,
  windowSize: number,
): void {
  const len = input.length;
  const halfWindow = windowSize >> 1;
  const invWindow = 1.0 / windowSize;

  for (let i = 0; i < len; i++) {
    let sum = 0.0;
    const start = i - halfWindow;
    const end = i + halfWindow + 1;

    for (let j = start; j < end; j++) {
      const idx = Math.max(0, Math.min(len - 1, j));
      sum += input[idx];
    }

    output[i] = sum * invWindow;
  }
}

function jsCalculateMedian(arr: Float32Array): number {
  if (arr.length === 0) return 0;

  const sorted = Float32Array.from(arr).sort((a, b) => a - b);
  const mid = arr.length >> 1;

  if ((arr.length & 1) === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) * 0.5;
}

function jsFindPeaks(
  energies: Float32Array,
  threshold: number,
  minDistance: number,
  peaks: Int32Array,
): number {
  const len = energies.length;
  let peakCount = 0;
  let lastPeak = -minDistance;

  for (let i = 1; i < len - 1; i++) {
    const curr = energies[i];
    const prev = energies[i - 1];
    const next = energies[i + 1];

    if (curr > prev && curr > next && curr > threshold) {
      if (i - lastPeak >= minDistance) {
        if (peakCount < peaks.length) {
          peaks[peakCount] = i;
          peakCount++;
          lastPeak = i;
        }
      }
    }
  }

  return peakCount;
}

function jsCalculateMean(arr: Float32Array): number {
  if (arr.length === 0) return 0;

  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
  }
  return sum / arr.length;
}

function jsCalculateStdDev(arr: Float32Array, mean: number): number {
  if (arr.length === 0) return 0;

  let sumSq = 0;
  for (let i = 0; i < arr.length; i++) {
    const diff = arr[i] - mean;
    sumSq += diff * diff;
  }
  return Math.sqrt(sumSq / arr.length);
}

export class BeatDetectionProcessor {
  private useWasm: boolean;

  constructor() {
    this.useWasm = wasmModule !== null;
  }

  async ensureWasm(): Promise<boolean> {
    if (this.useWasm) {
      return true;
    }

    const available = await initWasmBeatDetection();
    if (available) {
      this.useWasm = true;
    }
    return this.useWasm;
  }

  isUsingWasm(): boolean {
    return this.useWasm && wasmModule !== null;
  }

  private runWasm<T>(run: (module: WasmBeatDetectionExports) => T, fallback: () => T): T {
    if (this.useWasm && wasmModule) {
      try {
        return run(wasmModule);
      } catch (error) {
        console.warn("[WASM beat analysis] Processing failed; using JavaScript:", error);
        this.useWasm = false;
      }
    }
    return fallback();
  }

  computeRMSEnergies(
    samples: Float32Array,
    windowSize: number,
    hopSize: number,
    energies: Float32Array,
  ): void {
    if (arraysOverlap(samples, energies) || !isPositiveI32(windowSize) || !isPositiveI32(hopSize) ||
        (windowSize > MAX_RMS_CHUNK_SAMPLES && samples.length > MAX_RMS_CHUNK_SAMPLES)) {
      // A single very large window cannot fit the bounded transfer; process it
      // in place instead of duplicating the entire window in WASM memory.
      jsComputeRMSEnergies(samples, windowSize, hopSize, energies);
      return;
    }
    this.runWasm(
      (module) => module.computeRMSEnergies(samples, windowSize, hopSize, energies),
      () => jsComputeRMSEnergies(samples, windowSize, hopSize, energies),
    );
  }

  smoothArray(input: Float32Array, output: Float32Array, windowSize: number): void {
    if (arraysOverlap(input, output) || output.length < input.length || !isPositiveI32(windowSize)) {
      jsSmoothArray(input, output, windowSize);
      return;
    }
    this.runWasm(
      (module) => module.smoothArray(input, output, windowSize),
      () => jsSmoothArray(input, output, windowSize),
    );
  }

  calculateMedian(arr: Float32Array): number {
    // JS sort defines the behavior for NaNs and preserves the original order
    // of equal +0/-0 values. An in-place quick-select is not stable, so retain
    // that exact behavior on these unusual inputs without disabling WASM.
    if (arr.some((value) => Number.isNaN(value) || Object.is(value, -0))) return jsCalculateMedian(arr);
    return this.runWasm((module) => module.calculateMedian(arr), () => jsCalculateMedian(arr));
  }

  findPeaks(energies: Float32Array, threshold: number, minDistance: number, peaks: Int32Array): number {
    if (arraysOverlap(energies, peaks) || !isNonNegativeI32(minDistance)) {
      return jsFindPeaks(energies, threshold, minDistance, peaks);
    }
    return this.runWasm(
      (module) => module.findPeaks(energies, threshold, minDistance, peaks),
      () => jsFindPeaks(energies, threshold, minDistance, peaks),
    );
  }

  calculateMean(arr: Float32Array): number {
    return this.runWasm((module) => module.calculateMean(arr), () => jsCalculateMean(arr));
  }

  calculateStdDev(arr: Float32Array, mean: number): number {
    return this.runWasm((module) => module.calculateStdDev(arr, mean), () => jsCalculateStdDev(arr, mean));
  }

}

let cachedProcessor: BeatDetectionProcessor | null = null;

export function getBeatDetectionProcessor(): BeatDetectionProcessor {
  if (!cachedProcessor) {
    cachedProcessor = new BeatDetectionProcessor();
  }
  return cachedProcessor;
}

export async function preloadWasmBeatDetection(): Promise<BeatDetectionProcessor> {
  const processor = getBeatDetectionProcessor();
  await processor.ensureWasm();
  return processor;
}
