export function computeRMSEnergies(
  samples: Float32Array,
  windowSize: i32,
  hopSize: i32,
  energies: Float32Array,
): void {
  const numSamples = samples.length;
  const numFrames = energies.length;
  const invWindow: f64 = 1.0 / <f64>windowSize;

  for (let frame = 0; frame < numFrames; frame++) {
    const start = frame * hopSize;
    let sum: f64 = 0.0;

    let i = 0;
    for (; i + 3 < windowSize && start + i + 3 < numSamples; i += 4) {
      const idx = start + i;
      const s0: f64 = <f64>unchecked(samples[idx]);
      const s1: f64 = <f64>unchecked(samples[idx + 1]);
      const s2: f64 = <f64>unchecked(samples[idx + 2]);
      const s3: f64 = <f64>unchecked(samples[idx + 3]);
      sum += s0 * s0 + s1 * s1 + s2 * s2 + s3 * s3;
    }

    for (; i < windowSize && start + i < numSamples; i++) {
      const s: f64 = <f64>unchecked(samples[start + i]);
      sum += s * s;
    }

    unchecked((energies[frame] = <f32>Math.sqrt(sum * invWindow)));
  }
}

export function smoothArray(
  input: Float32Array,
  output: Float32Array,
  windowSize: i32,
): void {
  const len = input.length;
  const halfWindow = windowSize >> 1;
  const invWindow: f64 = 1.0 / <f64>windowSize;

  for (let i = 0; i < len; i++) {
    let sum: f64 = 0.0;
    const start = i - halfWindow;
    const end = i + halfWindow + 1;

    for (let j = start; j < end; j++) {
      const idx = j < 0 ? 0 : j >= len ? len - 1 : j;
      sum += <f64>unchecked(input[idx]);
    }

    unchecked((output[i] = <f32>(sum * invWindow)));
  }
}

// Three-way, iterative selection avoids quadratic recursion on silent or
// constant-energy windows, which are common during beat analysis.
function quickSelect(arr: Float32Array, left: i32, right: i32, k: i32): f32 {
  while (left < right) {
    const pivot = unchecked(arr[left + ((right - left) >> 1)]);
    let lower = left;
    let index = left;
    let upper = right;
    while (index <= upper) {
      const value = unchecked(arr[index]);
      if (value < pivot) {
        const temp = unchecked(arr[lower]);
        unchecked((arr[lower] = value));
        unchecked((arr[index] = temp));
        lower++;
        index++;
      } else if (value > pivot) {
        const temp = unchecked(arr[upper]);
        unchecked((arr[upper] = value));
        unchecked((arr[index] = temp));
        upper--;
      } else {
        index++;
      }
    }
    if (k < lower) right = lower - 1;
    else if (k > upper) left = upper + 1;
    else return unchecked(arr[k]);
  }
  return unchecked(arr[left]);
}

export function calculateMedian(arr: Float32Array): f64 {
  const len = arr.length;
  if (len === 0) return 0.0;

  const copy = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    unchecked((copy[i] = arr[i]));
  }

  const mid = len >> 1;
  if ((len & 1) === 1) {
    return quickSelect(copy, 0, len - 1, mid);
  } else {
    const lower = quickSelect(copy, 0, len - 1, mid - 1);
    const upper = quickSelect(copy, 0, len - 1, mid);
    return (<f64>lower + <f64>upper) * 0.5;
  }
}

export function findPeaks(
  energies: Float32Array,
  threshold: f64,
  minDistance: i32,
  peaks: Int32Array,
): i32 {
  const len = energies.length;
  let peakCount: i32 = 0;
  let lastPeak: i64 = -<i64>minDistance;

  for (let i = 1; i < len - 1; i++) {
    const curr = unchecked(energies[i]);
    const prev = unchecked(energies[i - 1]);
    const next = unchecked(energies[i + 1]);

    if (curr > prev && curr > next && <f64>curr > threshold) {
      if (<i64>i - lastPeak >= <i64>minDistance) {
        if (peakCount < peaks.length) {
          unchecked((peaks[peakCount] = i));
          peakCount++;
          lastPeak = i;
        }
      }
    }
  }

  return peakCount;
}

export function calculateMean(arr: Float32Array): f64 {
  const len = arr.length;
  if (len === 0) return 0.0;

  let sum: f64 = 0.0;
  for (let i = 0; i < len; i++) {
    sum += <f64>unchecked(arr[i]);
  }
  return sum / <f64>len;
}

export function calculateStdDev(arr: Float32Array, mean: f64): f64 {
  const len = arr.length;
  if (len === 0) return 0.0;

  let sumSq: f64 = 0.0;
  for (let i = 0; i < len; i++) {
    const diff = <f64>unchecked(arr[i]) - mean;
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
