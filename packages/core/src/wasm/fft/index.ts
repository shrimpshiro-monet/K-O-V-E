import { FFT as JsFFT } from "../../audio/fft";
import { TypedArrayBindings, fetchAudioWasm, inputArray, outputArray } from "../typed-array-bindings";

export type WasmFFTExports = {
  init(size: number): void;
  getSize(): number;
  forward(input: Float32Array, real: Float32Array, imag: Float32Array): void;
  inverse(real: Float32Array, imag: Float32Array, output: Float32Array): void;
  getMagnitude(
    real: Float32Array,
    imag: Float32Array,
    magnitude: Float32Array,
  ): void;
  getMagnitudeAndPhase(
    real: Float32Array,
    imag: Float32Array,
    magnitudes: Float32Array,
    phases: Float32Array,
  ): void;
  fromMagnitudeAndPhase(
    magnitudes: Float32Array,
    phases: Float32Array,
    real: Float32Array,
    imag: Float32Array,
  ): void;
  applyHannWindow(input: Float32Array, output: Float32Array): void;
  memory: WebAssembly.Memory;
};

function bindFFT(exports: WebAssembly.Exports): WasmFFTExports {
  const binding = new TypedArrayBindings(exports, [
    "init", "getSize", "forward", "inverse", "getMagnitude",
    "getMagnitudeAndPhase", "fromMagnitudeAndPhase", "applyHannWindow",
  ]);
  return {
    memory: binding.memory,
    init: (size) => { binding.call("init", [size]); },
    getSize: () => binding.call("getSize") ?? 0,
    forward: (input, real, imag) => { binding.call("forward", [inputArray(input), outputArray(real), outputArray(imag)]); },
    inverse: (real, imag, output) => { binding.call("inverse", [inputArray(real), inputArray(imag), outputArray(output)]); },
    getMagnitude: (real, imag, magnitude) => { binding.call("getMagnitude", [inputArray(real), inputArray(imag), outputArray(magnitude)]); },
    getMagnitudeAndPhase: (real, imag, magnitudes, phases) => {
      binding.call("getMagnitudeAndPhase", [inputArray(real), inputArray(imag), outputArray(magnitudes), outputArray(phases)]);
    },
    fromMagnitudeAndPhase: (magnitudes, phases, real, imag) => {
      binding.call("fromMagnitudeAndPhase", [inputArray(magnitudes), inputArray(phases), outputArray(real), outputArray(imag)]);
    },
    applyHannWindow: (input, output) => { binding.call("applyHannWindow", [inputArray(input), outputArray(output)]); },
  };
}

let wasmModule: WasmFFTExports | null = null;
let loadPromise: Promise<WasmFFTExports | null> | null = null;
let currentWasmSize = 0;

function selectWasmSize(module: WasmFFTExports, size: number): void {
  if (currentWasmSize === size) return;
  // A failed allocation in init may have changed the module's size already.
  // Invalidate the cache first so another instance cannot use stale tables.
  currentWasmSize = 0;
  module.init(size);
  if (module.getSize() !== size) throw new Error("Audio WASM FFT rejected its size");
  currentWasmSize = size;
}

async function loadWasmModule(): Promise<WasmFFTExports | null> {
  if (typeof WebAssembly === "undefined") {
    return null;
  }

  const wasmBytes = await fetchAudioWasm(new URL("./build/fft.wasm", import.meta.url));
  if (!wasmBytes) return null;

  try {
    const { instance } = await WebAssembly.instantiate(wasmBytes, {
      env: {
        abort: () => {
          throw new Error("WASM abort");
        },
      },
    });

    const bound = bindFFT(instance.exports);
    // Exercise the actual round trip before enabling it, so stale or mismatched
    // binaries cannot silently replace a working JavaScript implementation.
    bound.init(8);
    const real = new Float32Array(8);
    const imag = new Float32Array(8);
    bound.forward(Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]), real, imag);
    if (real.some((value) => !Number.isFinite(value) || Math.abs(value - 1) > 1e-5) ||
        imag.some((value) => !Number.isFinite(value) || Math.abs(value) > 1e-5)) {
      throw new Error("Audio WASM FFT binding failed its self-test");
    }
    return bound;
  } catch (error) {
    console.warn("[WASM FFT] Invalid module or failed self-test; using JavaScript:", error);
    return null;
  }
}

export async function initWasmFFT(): Promise<boolean> {
  if (wasmModule) {
    return true;
  }

  if (!loadPromise) {
    loadPromise = loadWasmModule();
  }

  wasmModule = await loadPromise;
  return wasmModule !== null;
}

export function isWasmFFTAvailable(): boolean {
  return wasmModule !== null;
}

export class WasmFFT {
  private readonly size: number;
  private readonly jsFFT: JsFFT;
  private useWasm: boolean;

  private real: Float32Array;
  private imag: Float32Array;

  constructor(size: number) {
    // The AssemblyScript loops and array lengths use signed i32 arithmetic.
    // Reject fractional/non-finite sizes and values that could overflow the
    // FFT loop when it doubles the final stage length.
    if (!Number.isSafeInteger(size) || size <= 0 || size > 0x20000000 || (size & (size - 1)) !== 0) {
      throw new Error("FFT size must be a supported power of 2");
    }

    this.size = size;
    this.jsFFT = new JsFFT(size);
    this.useWasm = false;
    this.real = new Float32Array(size);
    this.imag = new Float32Array(size);

    if (wasmModule) {
      try {
        selectWasmSize(wasmModule, size);
        this.useWasm = true;
      } catch (error) {
        console.warn("[WASM FFT] Initialization failed; using JavaScript:", error);
        this.useWasm = false;
      }
    }
  }

  async ensureWasm(): Promise<boolean> {
    if (this.useWasm) {
      return true;
    }

    const available = await initWasmFFT();
    if (available && wasmModule) {
      try {
        selectWasmSize(wasmModule, this.size);
        this.useWasm = true;
      } catch (error) {
        console.warn("[WASM FFT] Initialization failed; using JavaScript:", error);
        this.useWasm = false;
      }
    }
    return this.useWasm;
  }

  getSize(): number {
    return this.size;
  }

  isUsingWasm(): boolean {
    return this.useWasm && wasmModule !== null;
  }

  private runWasm<T>(run: (module: WasmFFTExports) => T, fallback: () => T): T {
    if (this.useWasm && wasmModule) {
      try {
        selectWasmSize(wasmModule, this.size);
        return run(wasmModule);
      } catch (error) {
        // A runtime trap or memory-allocation failure must not corrupt the
        // user's analysis. All JS inputs remain untouched until copy-back.
        console.warn("[WASM FFT] Processing failed; using JavaScript:", error);
        this.useWasm = false;
      }
    }
    return fallback();
  }

  forward(input: Float32Array): { real: Float32Array; imag: Float32Array } {
    return this.runWasm((module) => {
      // The JS FFT zero-pads short input and treats NaN as zero. AssemblyScript
      // uses unchecked indexing, so pass exactly one safe, normalized frame.
      let frame = input.subarray(0, this.size);
      if (frame.length !== this.size || frame.some(Number.isNaN)) {
        frame = new Float32Array(this.size);
        frame.set(input.subarray(0, this.size));
        for (let i = 0; i < frame.length; i++) if (Number.isNaN(frame[i])) frame[i] = 0;
      }
      module.forward(frame, this.real, this.imag);
      return { real: this.real.slice(), imag: this.imag.slice() };
    }, () => this.jsFFT.forward(input));
  }

  inverse(real: Float32Array, imag: Float32Array): Float32Array {
    if (real.length < this.size || imag.length < this.size) return this.jsFFT.inverse(real, imag);
    return this.runWasm((module) => {
      const output = new Float32Array(this.size);
      module.inverse(real.subarray(0, this.size), imag.subarray(0, this.size), output);
      return output;
    }, () => this.jsFFT.inverse(real, imag));
  }

  getMagnitude(real: Float32Array, imag: Float32Array): Float32Array {
    const half = this.size / 2;
    if (real.length < half || imag.length < half) return this.jsFFT.getMagnitude(real, imag);
    return this.runWasm((module) => {
      const magnitude = new Float32Array(half);
      module.getMagnitude(real.subarray(0, half), imag.subarray(0, half), magnitude);
      return magnitude;
    }, () => this.jsFFT.getMagnitude(real, imag));
  }

  getPower(real: Float32Array, imag: Float32Array): Float32Array {
    return this.jsFFT.getPower(real, imag);
  }

  getMagnitudeAndPhase(
    real: Float32Array,
    imag: Float32Array,
  ): { magnitudes: Float32Array; phases: Float32Array } {
    const half = this.size / 2;
    if (real.length < half || imag.length < half) return this.jsFFT.getMagnitudeAndPhase(real, imag);
    return this.runWasm((module) => {
      const magnitudes = new Float32Array(half);
      const phases = new Float32Array(half);
      module.getMagnitudeAndPhase(real.subarray(0, half), imag.subarray(0, half), magnitudes, phases);
      return { magnitudes, phases };
    }, () => this.jsFFT.getMagnitudeAndPhase(real, imag));
  }

  fromMagnitudeAndPhase(
    magnitudes: Float32Array,
    phases: Float32Array,
  ): { real: Float32Array; imag: Float32Array } {
    if (magnitudes.length > this.size || phases.length < magnitudes.length) {
      return this.jsFFT.fromMagnitudeAndPhase(magnitudes, phases);
    }
    return this.runWasm((module) => {
      const real = new Float32Array(this.size);
      const imag = new Float32Array(this.size);
      module.fromMagnitudeAndPhase(magnitudes, phases.subarray(0, magnitudes.length), real, imag);
      return { real, imag };
    }, () => this.jsFFT.fromMagnitudeAndPhase(magnitudes, phases));
  }

  applyHannWindow(data: Float32Array): Float32Array {
    return this.runWasm((module) => {
      const output = new Float32Array(data.length);
      module.applyHannWindow(data, output);
      return output;
    }, () => this.jsFFT.applyHannWindow(data));
  }

  applySynthesisWindow(data: Float32Array): Float32Array {
    return this.jsFFT.applySynthesisWindow(data);
  }
}

let cachedWasmFFT: WasmFFT | null = null;
let cachedWasmFFTSize = 0;

export function getWasmFFT(size: number): WasmFFT {
  if (cachedWasmFFT && cachedWasmFFTSize === size) {
    return cachedWasmFFT;
  }
  cachedWasmFFT = new WasmFFT(size);
  cachedWasmFFTSize = size;
  return cachedWasmFFT;
}

export async function preloadWasmFFT(size: number): Promise<WasmFFT> {
  const fft = getWasmFFT(size);
  await fft.ensureWasm();
  return fft;
}
