// All raw data accesses below rely on the TypeScript adapters validating array
// lengths and pinning the managed arrays. Avoid per-sample typed-array helper
// calls in hot loops; they add GC shadow-stack overhead on every access.
let size: i32 = 0;
let cosTable: Float32Array | null = null;
let sinTable: Float32Array | null = null;
let reverseTable: Uint32Array | null = null;

export function init(fftSize: i32): void {
  if (fftSize <= 0 || (fftSize & (fftSize - 1)) !== 0) {
    return;
  }

  size = fftSize;
  const halfSize = size >> 1;

  const cosTab = new Float32Array(halfSize);
  const sinTab = new Float32Array(halfSize);
  const revTab = new Uint32Array(size);
  const cosData = cosTab.dataStart;
  const sinData = sinTab.dataStart;
  const revData = revTab.dataStart;

  const twoPi: f32 = 6.283185307179586;
  for (let i = 0; i < halfSize; i++) {
    const angle: f32 = (-twoPi * <f32>i) / <f32>size;
    const offset = <usize>i << 2;
    store<f32>(cosData + offset, Mathf.cos(angle));
    store<f32>(sinData + offset, Mathf.sin(angle));
  }

  const bits = <i32>Math.log2(<f64>size);
  for (let i = 0; i < size; i++) {
    let reversed: u32 = 0;
    for (let j = 0; j < bits; j++) {
      reversed = (reversed << 1) | ((<u32>i >> j) & 1);
    }
    store<u32>(revData + (<usize>i << 2), reversed);
  }

  cosTable = cosTab;
  sinTable = sinTab;
  reverseTable = revTab;
}

export function getSize(): i32 {
  return size;
}

export function forward(input: Float32Array, real: Float32Array, imag: Float32Array): void {
  if (!reverseTable || !cosTable || !sinTable) return;
  const revData = reverseTable!.dataStart;
  const cosData = cosTable!.dataStart;
  const sinData = sinTable!.dataStart;
  const inputData = input.dataStart;
  const realData = real.dataStart;
  const imagData = imag.dataStart;
  const n = size;

  for (let i = 0; i < n; i++) {
    const rev = load<u32>(revData + (<usize>i << 2));
    const sample = load<f32>(inputData + (<usize>i << 2));
    // The JS FFT uses `input[i] || 0`, which normalizes negative zero.
    store<f32>(realData + (<usize>rev << 2), sample == 0 ? 0 : sample);
    store<f32>(imagData + (<usize>rev << 2), 0);
  }

  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const tableStep = n / len;
    for (let i = 0; i < n; i += len) {
      for (let j = 0; j < halfLen; j++) {
        const tableOffset = <usize>(j * tableStep) << 2;
        const cos = load<f32>(cosData + tableOffset);
        const sin = load<f32>(sinData + tableOffset);
        const even = <usize>(i + j) << 2;
        const odd = <usize>(i + j + halfLen) << 2;
        const oddReal = load<f32>(realData + odd);
        const oddImag = load<f32>(imagData + odd);
        const tReal = oddReal * cos - oddImag * sin;
        const tImag = oddReal * sin + oddImag * cos;
        const evenReal = load<f32>(realData + even);
        const evenImag = load<f32>(imagData + even);
        store<f32>(realData + odd, evenReal - tReal);
        store<f32>(imagData + odd, evenImag - tImag);
        store<f32>(realData + even, evenReal + tReal);
        store<f32>(imagData + even, evenImag + tImag);
      }
    }
  }
}

export function inverse(real: Float32Array, imag: Float32Array, output: Float32Array): void {
  if (!reverseTable || !cosTable || !sinTable) return;
  const n = size;
  const outReal = new Float32Array(n);
  const outImag = new Float32Array(n);
  // No allocations happen after taking these data addresses. The bound input
  // arrays are pinned by the TypeScript bridge for the duration of the call.
  const revData = reverseTable!.dataStart;
  const cosData = cosTable!.dataStart;
  const sinData = sinTable!.dataStart;
  const realData = real.dataStart;
  const imagData = imag.dataStart;
  const outRealData = outReal.dataStart;
  const outImagData = outImag.dataStart;
  const outputData = output.dataStart;

  for (let i = 0; i < n; i++) {
    const rev = load<u32>(revData + (<usize>i << 2));
    store<f32>(outRealData + (<usize>rev << 2), load<f32>(realData + (<usize>i << 2)));
    store<f32>(outImagData + (<usize>rev << 2), -load<f32>(imagData + (<usize>i << 2)));
  }

  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const tableStep = n / len;
    for (let i = 0; i < n; i += len) {
      for (let j = 0; j < halfLen; j++) {
        const tableOffset = <usize>(j * tableStep) << 2;
        const cos = load<f32>(cosData + tableOffset);
        const sin = load<f32>(sinData + tableOffset);
        const even = <usize>(i + j) << 2;
        const odd = <usize>(i + j + halfLen) << 2;
        const oddReal = load<f32>(outRealData + odd);
        const oddImag = load<f32>(outImagData + odd);
        const tReal = oddReal * cos - oddImag * sin;
        const tImag = oddReal * sin + oddImag * cos;
        const evenReal = load<f32>(outRealData + even);
        const evenImag = load<f32>(outImagData + even);
        store<f32>(outRealData + odd, evenReal - tReal);
        store<f32>(outImagData + odd, evenImag - tImag);
        store<f32>(outRealData + even, evenReal + tReal);
        store<f32>(outImagData + even, evenImag + tImag);
      }
    }
  }

  const invN: f32 = 1.0 / <f32>n;
  for (let i = 0; i < n; i++) {
    const offset = <usize>i << 2;
    store<f32>(outputData + offset, load<f32>(outRealData + offset) * invN);
  }
}

export function getMagnitude(real: Float32Array, imag: Float32Array, magnitude: Float32Array): void {
  const realData = real.dataStart;
  const imagData = imag.dataStart;
  const magnitudeData = magnitude.dataStart;
  const halfSize = size >> 1;
  for (let i = 0; i < halfSize; i++) {
    const offset = <usize>i << 2;
    const r: f64 = <f64>load<f32>(realData + offset);
    const im: f64 = <f64>load<f32>(imagData + offset);
    store<f32>(magnitudeData + offset, <f32>Math.sqrt(r * r + im * im));
  }
}

export function getMagnitudeAndPhase(
  real: Float32Array,
  imag: Float32Array,
  magnitudes: Float32Array,
  phases: Float32Array,
): void {
  const realData = real.dataStart;
  const imagData = imag.dataStart;
  const magnitudeData = magnitudes.dataStart;
  const phaseData = phases.dataStart;
  const halfSize = size >> 1;
  for (let i = 0; i < halfSize; i++) {
    const offset = <usize>i << 2;
    const r = load<f32>(realData + offset);
    const im = load<f32>(imagData + offset);
    store<f32>(magnitudeData + offset, <f32>Math.sqrt(<f64>r * <f64>r + <f64>im * <f64>im));
    store<f32>(phaseData + offset, Mathf.atan2(im, r));
  }
}

export function fromMagnitudeAndPhase(
  magnitudes: Float32Array,
  phases: Float32Array,
  real: Float32Array,
  imag: Float32Array,
): void {
  const n = size;
  const halfSize = magnitudes.length;
  const magnitudeData = magnitudes.dataStart;
  const phaseData = phases.dataStart;
  const realData = real.dataStart;
  const imagData = imag.dataStart;
  for (let i = 0; i < halfSize; i++) {
    const offset = <usize>i << 2;
    const mag = load<f32>(magnitudeData + offset);
    const phase = load<f32>(phaseData + offset);
    store<f32>(realData + offset, mag * Mathf.cos(phase));
    store<f32>(imagData + offset, mag * Mathf.sin(phase));
  }
  for (let i = 1; i < halfSize; i++) {
    const source = <usize>i << 2;
    const destination = <usize>(n - i) << 2;
    store<f32>(realData + destination, load<f32>(realData + source));
    store<f32>(imagData + destination, -load<f32>(imagData + source));
  }
}

export function applyHannWindow(input: Float32Array, output: Float32Array): void {
  const n = input.length;
  const inputData = input.dataStart;
  const outputData = output.dataStart;
  const twoPi: f32 = 6.283185307179586;
  const nMinus1: f32 = <f32>(n - 1);
  for (let i = 0; i < n; i++) {
    const offset = <usize>i << 2;
    const windowVal: f32 = 0.5 * (1.0 - Mathf.cos((twoPi * <f32>i) / nMinus1));
    store<f32>(outputData + offset, load<f32>(inputData + offset) * windowVal);
  }
}

export function allocateF32(length: i32): Float32Array {
  return new Float32Array(length);
}

export function allocateU32(length: i32): Uint32Array {
  return new Uint32Array(length);
}

// Expose data locations via the compiler rather than duplicating the
// AssemblyScript typed-array object layout in JavaScript.
export function dataF32(array: Float32Array): usize {
  return array.dataStart;
}
