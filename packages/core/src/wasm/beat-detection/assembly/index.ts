// The TypeScript adapter validates dimensions and pins arrays before calling
// these routines. Direct accesses avoid typed-array GC helper calls per sample.
export function computeRMSEnergies(
  samples: Float32Array,
  windowSize: i32,
  hopSize: i32,
  energies: Float32Array,
): void {
  const numSamples = samples.length;
  const numFrames = energies.length;
  const sampleData = samples.dataStart;
  const energyData = energies.dataStart;
  const invWindow: f64 = 1.0 / <f64>windowSize;
  for (let frame = 0; frame < numFrames; frame++) {
    const start = frame * hopSize;
    let sum: f64 = 0.0;
    let i = 0;
    for (; i + 3 < windowSize && start + i + 3 < numSamples; i += 4) {
      const offset = <usize>(start + i) << 2;
      const s0: f64 = <f64>load<f32>(sampleData + offset);
      const s1: f64 = <f64>load<f32>(sampleData + offset + 4);
      const s2: f64 = <f64>load<f32>(sampleData + offset + 8);
      const s3: f64 = <f64>load<f32>(sampleData + offset + 12);
      sum += s0 * s0 + s1 * s1 + s2 * s2 + s3 * s3;
    }
    for (; i < windowSize && start + i < numSamples; i++) {
      const sample: f64 = <f64>load<f32>(sampleData + (<usize>(start + i) << 2));
      sum += sample * sample;
    }
    store<f32>(energyData + (<usize>frame << 2), <f32>Math.sqrt(sum * invWindow));
  }
}

export function smoothArray(
  input: Float32Array,
  output: Float32Array,
  windowSize: i32,
): void {
  const len = input.length;
  const inputData = input.dataStart;
  const outputData = output.dataStart;
  const halfWindow = windowSize >> 1;
  const invWindow: f64 = 1.0 / <f64>windowSize;
  for (let i = 0; i < len; i++) {
    let sum: f64 = 0.0;
    const start = i - halfWindow;
    const end = i + halfWindow + 1;
    for (let j = start; j < end; j++) {
      const idx = j < 0 ? 0 : j >= len ? len - 1 : j;
      sum += <f64>load<f32>(inputData + (<usize>idx << 2));
    }
    store<f32>(outputData + (<usize>i << 2), <f32>(sum * invWindow));
  }
}

// Three-way, iterative selection avoids quadratic recursion on silent or
// constant-energy windows, which are common during beat analysis.
function quickSelect(data: usize, left: i32, right: i32, k: i32): f32 {
  while (left < right) {
    const pivot = load<f32>(data + (<usize>(left + ((right - left) >> 1)) << 2));
    let lower = left;
    let index = left;
    let upper = right;
    while (index <= upper) {
      const indexOffset = <usize>index << 2;
      const value = load<f32>(data + indexOffset);
      if (value < pivot) {
        const lowerOffset = <usize>lower << 2;
        const temp = load<f32>(data + lowerOffset);
        store<f32>(data + lowerOffset, value);
        store<f32>(data + indexOffset, temp);
        lower++;
        index++;
      } else if (value > pivot) {
        const upperOffset = <usize>upper << 2;
        const temp = load<f32>(data + upperOffset);
        store<f32>(data + upperOffset, value);
        store<f32>(data + indexOffset, temp);
        upper--;
      } else {
        index++;
      }
    }
    if (k < lower) right = lower - 1;
    else if (k > upper) left = upper + 1;
    else return load<f32>(data + (<usize>k << 2));
  }
  return load<f32>(data + (<usize>left << 2));
}

export function calculateMedian(arr: Float32Array): f64 {
  const len = arr.length;
  if (len === 0) return 0.0;
  const copy = new Float32Array(len);
  const data = copy.dataStart;
  memory.copy(data, arr.dataStart, <usize>len << 2);
  const mid = len >> 1;
  if ((len & 1) === 1) return quickSelect(data, 0, len - 1, mid);
  const lower = quickSelect(data, 0, len - 1, mid - 1);
  const upper = quickSelect(data, 0, len - 1, mid);
  return (<f64>lower + <f64>upper) * 0.5;
}

export function findPeaks(
  energies: Float32Array,
  threshold: f64,
  minDistance: i32,
  peaks: Int32Array,
): i32 {
  const len = energies.length;
  const energyData = energies.dataStart;
  const peakData = peaks.dataStart;
  let peakCount: i32 = 0;
  let lastPeak: i64 = -<i64>minDistance;
  for (let i = 1; i < len - 1; i++) {
    const offset = <usize>i << 2;
    const curr = load<f32>(energyData + offset);
    const prev = load<f32>(energyData + offset - 4);
    const next = load<f32>(energyData + offset + 4);
    if (curr > prev && curr > next && <f64>curr > threshold) {
      if (<i64>i - lastPeak >= <i64>minDistance && peakCount < peaks.length) {
        store<i32>(peakData + (<usize>peakCount << 2), i);
        peakCount++;
        lastPeak = i;
      }
    }
  }
  return peakCount;
}

export function calculateMean(arr: Float32Array): f64 {
  const len = arr.length;
  if (len === 0) return 0.0;
  const data = arr.dataStart;
  let sum: f64 = 0.0;
  for (let i = 0; i < len; i++) sum += <f64>load<f32>(data + (<usize>i << 2));
  return sum / <f64>len;
}

export function calculateStdDev(arr: Float32Array, mean: f64): f64 {
  const len = arr.length;
  if (len === 0) return 0.0;
  const data = arr.dataStart;
  let sumSq: f64 = 0.0;
  for (let i = 0; i < len; i++) {
    const diff = <f64>load<f32>(data + (<usize>i << 2)) - mean;
    sumSq += diff * diff;
  }
  return Math.sqrt(sumSq / <f64>len);
}

export function allocateF32(length: i32): Float32Array {
  return new Float32Array(length);
}

export function allocateI32(length: i32): Int32Array {
  return new Int32Array(length);
}

export function dataF32(array: Float32Array): usize {
  return array.dataStart;
}

export function dataI32(array: Int32Array): usize {
  return array.dataStart;
}
