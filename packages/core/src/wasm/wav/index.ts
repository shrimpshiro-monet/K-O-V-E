import { TypedArrayBindings, fetchAudioWasm, arraysOverlap, inputArray, outputArray } from "../typed-array-bindings";

export type WasmWavExports = {
  encodeWav16Mono(
    samples: Float32Array,
    output: Uint8Array,
    dataOffset: number,
  ): void;
  encodeWav24Mono(
    samples: Float32Array,
    output: Uint8Array,
    dataOffset: number,
  ): void;
  encodeWav16Stereo(
    left: Float32Array,
    right: Float32Array,
    output: Uint8Array,
    dataOffset: number,
  ): void;
  encodeWav24Stereo(
    left: Float32Array,
    right: Float32Array,
    output: Uint8Array,
    dataOffset: number,
  ): void;
  writeWavHeader(
    output: Uint8Array,
    numChannels: number,
    sampleRate: number,
    bitsPerSample: number,
    numSamples: number,
  ): void;
  memory: WebAssembly.Memory;
};

// Keep the WASM working set bounded even when a caller encodes long audio.
const WAV_CHUNK_FRAMES = 65_536;
const MAX_I32 = 0x7fffffff;

function canEncode(
  left: Float32Array,
  right: Float32Array | null,
  output: Uint8Array,
  offset: number,
  bytesPerFrame: number,
): boolean {
  const required = offset + left.length * bytesPerFrame;
  return Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(required) &&
    required <= output.length && (right === null || right.length >= left.length);
}

function bindWav(exports: WebAssembly.Exports): WasmWavExports {
  const binding = new TypedArrayBindings(exports, [
    "allocateU8", "dataU8", "encodeWav16Mono", "encodeWav24Mono",
    "encodeWav16Stereo", "encodeWav24Stereo", "writeWavHeader",
  ]);
  const encode = (
    name: string,
    left: Float32Array,
    right: Float32Array | null,
    output: Uint8Array,
    offset: number,
    bytesPerFrame: number,
  ): void => {
    if (!canEncode(left, right, output, offset, bytesPerFrame)) {
      throw new RangeError("Invalid audio WASM output or channel length");
    }
    for (let start = 0; start < left.length; start += WAV_CHUNK_FRAMES) {
      const end = Math.min(left.length, start + WAV_CHUNK_FRAMES);
      const out = output.subarray(offset + start * bytesPerFrame, offset + end * bytesPerFrame);
      const args = [inputArray(left.subarray(start, end))];
      if (right) args.push(inputArray(right.subarray(start, end)));
      binding.call(name, [...args, outputArray(out), 0]);
    }
  };
  return {
    memory: binding.memory,
    encodeWav16Mono: (samples, output, offset) => encode("encodeWav16Mono", samples, null, output, offset, 2),
    encodeWav24Mono: (samples, output, offset) => encode("encodeWav24Mono", samples, null, output, offset, 3),
    encodeWav16Stereo: (left, right, output, offset) => encode("encodeWav16Stereo", left, right, output, offset, 4),
    encodeWav24Stereo: (left, right, output, offset) => encode("encodeWav24Stereo", left, right, output, offset, 6),
    writeWavHeader: (output, channels, sampleRate, bitDepth, frames) => {
      if (output.length < 44) throw new RangeError("WAV header output is too short");
      binding.call("writeWavHeader", [outputArray(output.subarray(0, 44)), channels, sampleRate, bitDepth, frames]);
    },
  };
}

let wasmModule: WasmWavExports | null = null;
let loadPromise: Promise<WasmWavExports | null> | null = null;

async function loadWasmModule(): Promise<WasmWavExports | null> {
  if (typeof WebAssembly === "undefined") {
    return null;
  }

  const wasmBytes = await fetchAudioWasm(new URL("./build/wav.wasm", import.meta.url));
  if (!wasmBytes) return null;

  try {
    const { instance } = await WebAssembly.instantiate(wasmBytes, {
      env: {
        abort: () => {
          throw new Error("WASM abort");
        },
      },
    });

    const bound = bindWav(instance.exports);
    const header = new Uint8Array(44);
    const pcm = new Uint8Array(2);
    bound.writeWavHeader(header, 1, 48_000, 16, 1);
    bound.encodeWav16Mono(Float32Array.of(0.5), pcm, 0);
    if (header[0] !== 0x52 || header[1] !== 0x49 || header[2] !== 0x46 || header[3] !== 0x46 ||
        new DataView(header.buffer).getUint32(24, true) !== 48_000 ||
        new DataView(pcm.buffer).getInt16(0, true) !== 16_384) {
      throw new Error("Audio WASM WAV binding failed its self-test");
    }
    return bound;
  } catch (error) {
    console.warn("[WASM WAV] Invalid module or failed self-test; using JavaScript:", error);
    return null;
  }
}

export async function initWasmWav(): Promise<boolean> {
  if (wasmModule) {
    return true;
  }

  if (!loadPromise) {
    loadPromise = loadWasmModule();
  }

  wasmModule = await loadPromise;
  return wasmModule !== null;
}

export function isWasmWavAvailable(): boolean {
  return wasmModule !== null;
}

function jsEncodeWav16Mono(
  samples: Float32Array,
  output: Uint8Array,
  dataOffset: number,
): void {
  for (let i = 0; i < samples.length; i++) {
    let sample = samples[i];
    sample = Math.max(-1, Math.min(1, sample));
    const intSample = Math.round(sample * 32767);
    const offset = dataOffset + i * 2;
    output[offset] = intSample & 0xff;
    output[offset + 1] = (intSample >> 8) & 0xff;
  }
}

function jsEncodeWav16Stereo(
  left: Float32Array,
  right: Float32Array,
  output: Uint8Array,
  dataOffset: number,
): void {
  for (let i = 0; i < left.length; i++) {
    let leftSample = Math.max(-1, Math.min(1, left[i]));
    let rightSample = Math.max(-1, Math.min(1, right[i]));

    const leftInt = Math.round(leftSample * 32767);
    const rightInt = Math.round(rightSample * 32767);
    const offset = dataOffset + i * 4;

    output[offset] = leftInt & 0xff;
    output[offset + 1] = (leftInt >> 8) & 0xff;
    output[offset + 2] = rightInt & 0xff;
    output[offset + 3] = (rightInt >> 8) & 0xff;
  }
}

function jsEncodeWav24Stereo(
  left: Float32Array,
  right: Float32Array,
  output: Uint8Array,
  dataOffset: number,
): void {
  const maxVal = 8388607;
  for (let i = 0; i < left.length; i++) {
    let leftSample = Math.max(-1, Math.min(1, left[i]));
    let rightSample = Math.max(-1, Math.min(1, right[i]));

    const leftInt = Math.round(leftSample * maxVal);
    const rightInt = Math.round(rightSample * maxVal);
    const offset = dataOffset + i * 6;

    output[offset] = leftInt & 0xff;
    output[offset + 1] = (leftInt >> 8) & 0xff;
    output[offset + 2] = (leftInt >> 16) & 0xff;
    output[offset + 3] = rightInt & 0xff;
    output[offset + 4] = (rightInt >> 8) & 0xff;
    output[offset + 5] = (rightInt >> 16) & 0xff;
  }
}

function jsWriteWavHeader(
  output: Uint8Array,
  numChannels: number,
  sampleRate: number,
  bitsPerSample: number,
  numSamples: number,
): void {
  const bytesPerSample = bitsPerSample >> 3;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;
  const fileSize = 36 + dataSize;

  output[0] = 0x52;
  output[1] = 0x49;
  output[2] = 0x46;
  output[3] = 0x46;

  output[4] = fileSize & 0xff;
  output[5] = (fileSize >> 8) & 0xff;
  output[6] = (fileSize >> 16) & 0xff;
  output[7] = (fileSize >> 24) & 0xff;

  output[8] = 0x57;
  output[9] = 0x41;
  output[10] = 0x56;
  output[11] = 0x45;

  output[12] = 0x66;
  output[13] = 0x6d;
  output[14] = 0x74;
  output[15] = 0x20;

  output[16] = 16;
  output[17] = 0;
  output[18] = 0;
  output[19] = 0;

  output[20] = 1;
  output[21] = 0;

  output[22] = numChannels & 0xff;
  output[23] = (numChannels >> 8) & 0xff;

  output[24] = sampleRate & 0xff;
  output[25] = (sampleRate >> 8) & 0xff;
  output[26] = (sampleRate >> 16) & 0xff;
  output[27] = (sampleRate >> 24) & 0xff;

  output[28] = byteRate & 0xff;
  output[29] = (byteRate >> 8) & 0xff;
  output[30] = (byteRate >> 16) & 0xff;
  output[31] = (byteRate >> 24) & 0xff;

  output[32] = blockAlign & 0xff;
  output[33] = (blockAlign >> 8) & 0xff;

  output[34] = bitsPerSample & 0xff;
  output[35] = (bitsPerSample >> 8) & 0xff;

  output[36] = 0x64;
  output[37] = 0x61;
  output[38] = 0x74;
  output[39] = 0x61;

  output[40] = dataSize & 0xff;
  output[41] = (dataSize >> 8) & 0xff;
  output[42] = (dataSize >> 16) & 0xff;
  output[43] = (dataSize >> 24) & 0xff;
}

export class WavEncoder {
  private useWasm: boolean;

  constructor() {
    this.useWasm = wasmModule !== null;
  }

  async ensureWasm(): Promise<boolean> {
    if (this.useWasm) {
      return true;
    }

    const available = await initWasmWav();
    if (available) {
      this.useWasm = true;
    }
    return this.useWasm;
  }

  isUsingWasm(): boolean {
    return this.useWasm && wasmModule !== null;
  }

  private runWasm(run: (module: WasmWavExports) => void, fallback: () => void): void {
    if (this.useWasm && wasmModule) {
      try {
        run(wasmModule);
        return;
      } catch (error) {
        console.warn("[WASM WAV] Processing failed; using JavaScript:", error);
        this.useWasm = false;
      }
    }
    fallback();
  }

  encodeWav16Mono(samples: Float32Array, output: Uint8Array, dataOffset: number): void {
    if (arraysOverlap(samples, output) || !canEncode(samples, null, output, dataOffset, 2)) {
      return jsEncodeWav16Mono(samples, output, dataOffset);
    }
    this.runWasm(
      (module) => module.encodeWav16Mono(samples, output, dataOffset),
      () => jsEncodeWav16Mono(samples, output, dataOffset),
    );
  }

  encodeWav16Stereo(left: Float32Array, right: Float32Array, output: Uint8Array, dataOffset: number): void {
    if (arraysOverlap(left, output) || arraysOverlap(right, output) || !canEncode(left, right, output, dataOffset, 4)) {
      return jsEncodeWav16Stereo(left, right, output, dataOffset);
    }
    this.runWasm(
      (module) => module.encodeWav16Stereo(left, right, output, dataOffset),
      () => jsEncodeWav16Stereo(left, right, output, dataOffset),
    );
  }

  encodeWav24Stereo(left: Float32Array, right: Float32Array, output: Uint8Array, dataOffset: number): void {
    if (arraysOverlap(left, output) || arraysOverlap(right, output) || !canEncode(left, right, output, dataOffset, 6)) {
      return jsEncodeWav24Stereo(left, right, output, dataOffset);
    }
    this.runWasm(
      (module) => module.encodeWav24Stereo(left, right, output, dataOffset),
      () => jsEncodeWav24Stereo(left, right, output, dataOffset),
    );
  }

  writeWavHeader(
    output: Uint8Array,
    numChannels: number,
    sampleRate: number,
    bitsPerSample: number,
    numSamples: number,
  ): void {
    if (output.length < 44 || [numChannels, sampleRate, bitsPerSample, numSamples].some(
      (value) => !Number.isInteger(value) || value < 0 || value > MAX_I32,
    )) {
      return jsWriteWavHeader(output, numChannels, sampleRate, bitsPerSample, numSamples);
    }
    this.runWasm(
      (module) => module.writeWavHeader(output, numChannels, sampleRate, bitsPerSample, numSamples),
      () => jsWriteWavHeader(output, numChannels, sampleRate, bitsPerSample, numSamples),
    );
  }

  encodeFullWav(
    samples: Float32Array[],
    sampleRate: number,
    bitsPerSample: 16 | 24 = 16,
  ): Uint8Array {
    const numChannels = samples.length;
    if (numChannels < 1 || numChannels > 2) throw new Error("WAV encoding requires one or two channels");
    const numSamples = samples[0].length;
    if (numChannels === 2 && samples[1].length !== numSamples) {
      throw new Error("WAV channels must have equal sample counts");
    }
    const bytesPerSample = bitsPerSample >> 3;
    const dataSize = numSamples * numChannels * bytesPerSample;
    // RIFF's size field includes 36 bytes after the size field; silently
    // wrapping it would produce a WAV whose declared length is incorrect.
    if (dataSize > 0xffffffff - 36) throw new RangeError("WAV exceeds the 4 GiB RIFF size limit");
    const output = new Uint8Array(44 + dataSize);

    this.writeWavHeader(output, numChannels, sampleRate, bitsPerSample, numSamples);

    if (numChannels === 1 && bitsPerSample === 16) {
      this.encodeWav16Mono(samples[0], output, 44);
    } else if (numChannels === 1 && bitsPerSample === 24) {
      this.encodeWav24Mono(samples[0], output, 44);
    } else if (bitsPerSample === 16) {
      this.encodeWav16Stereo(samples[0], samples[1], output, 44);
    } else {
      this.encodeWav24Stereo(samples[0], samples[1], output, 44);
    }

    return output;
  }

  private encodeWav24Mono(
    samples: Float32Array,
    output: Uint8Array,
    dataOffset: number,
  ): void {
    this.runWasm(
      (module) => module.encodeWav24Mono(samples, output, dataOffset),
      () => {
        const maxVal = 8388607;
        for (let i = 0; i < samples.length; i++) {
          const sample = Math.max(-1, Math.min(1, samples[i]));
          const intSample = Math.round(sample * maxVal);
          const offset = dataOffset + i * 3;
          output[offset] = intSample & 0xff;
          output[offset + 1] = (intSample >> 8) & 0xff;
          output[offset + 2] = (intSample >> 16) & 0xff;
        }
      },
    );
  }
}

let cachedEncoder: WavEncoder | null = null;

export function getWavEncoder(): WavEncoder {
  if (!cachedEncoder) {
    cachedEncoder = new WavEncoder();
  }
  return cachedEncoder;
}

export async function preloadWasmWav(): Promise<WavEncoder> {
  const encoder = getWavEncoder();
  await encoder.ensureWasm();
  return encoder;
}
