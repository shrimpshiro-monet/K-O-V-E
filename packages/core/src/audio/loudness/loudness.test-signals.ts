/** Synthetic reference signals described in EBU Tech 3341 (Table 1) and Tech 3342 (Table 1). */

export const FS = 48_000;
export const dbToLin = (db: number): number => Math.pow(10, db / 20);

export function sine(
  seconds: number,
  freq: number,
  amplitude: number,
  fs = FS,
  phaseDeg = 0,
): Float64Array {
  const n = Math.round(seconds * fs);
  const out = new Float64Array(n);
  const ph = (phaseDeg * Math.PI) / 180;
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin(2 * Math.PI * freq * (i / fs) + ph);
  return out;
}

/** 1 kHz tone at a per-channel peak level in dBFS. */
export const tone = (seconds: number, dbfs: number, fs = FS): Float64Array =>
  sine(seconds, 1000, dbToLin(dbfs), fs);

export const silence = (seconds: number, fs = FS): Float64Array =>
  new Float64Array(Math.round(seconds * fs));

export function concat(...parts: Float64Array[]): Float64Array {
  const out = new Float64Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Same signal applied in phase to both channels. */
export const stereo = (x: Float64Array): Float64Array[] => [x, x];

/** Raised-cosine fade-in/out of `ms` milliseconds. */
export function taper(x: Float64Array, ms: number, fs = FS): Float64Array {
  const n = Math.round((ms / 1000) * fs);
  const out = Float64Array.from(x);
  for (let i = 0; i < n && i < out.length; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
    out[i]! *= g;
    out[out.length - 1 - i]! *= g;
  }
  return out;
}

/** Windowed-sinc low-pass FIR, cutoff as a fraction of the sample rate it runs at. */
function lowpassTaps(cutoff: number, taps: number): Float64Array {
  const h = new Float64Array(taps);
  const m = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const t = i - m;
    const sinc = t === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * t) / (Math.PI * t);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    h[i] = sinc * w;
    sum += h[i]!;
  }
  for (let i = 0; i < taps; i++) h[i]! /= sum;
  return h;
}

/**
 * Tech 3341 signals 20-23: f/6 sine (amp 0.5) containing ONE period of an f/4 sine (amp 1.0),
 * continuous in phase at both sides, synthesised at 4 x fs, low-pass filtered, then
 * decimated by 4 with `offset` (0..3) samples at the 4 x fs rate.
 */
export function interSamplePeakSignal(offset: number, fs = FS, seconds = 0.5): Float64Array {
  const periodsLead = Math.round((seconds * fs) / 6 / 2); // whole f/6 periods before and after
  const six = 24; // samples per f/6 period at 4 x fs
  const four = 16; // samples per f/4 period at 4 x fs
  const total = periodsLead * six * 2 + four;
  const x = new Float64Array(total);
  let n = 0;
  for (let p = 0; p < periodsLead * six; p++, n++) x[n] = 0.5 * Math.sin((2 * Math.PI * p) / six);
  for (let p = 0; p < four; p++, n++) x[n] = 1.0 * Math.sin((2 * Math.PI * p) / four);
  for (let p = 0; p < periodsLead * six; p++, n++) x[n] = 0.5 * Math.sin((2 * Math.PI * p) / six);
  // anti-alias then decimate
  const taps = 255;
  const h = lowpassTaps(0.45 / 4, taps);
  const y = new Float64Array(total);
  const m = (taps - 1) / 2;
  for (let i = 0; i < total; i++) {
    let acc = 0;
    for (let k = 0; k < taps; k++) {
      const j = i + k - m;
      if (j >= 0 && j < total) acc += h[k]! * x[j]!;
    }
    y[i] = acc;
  }
  const out = new Float64Array(Math.floor((total - offset) / 4));
  for (let i = 0; i < out.length; i++) out[i] = y[offset + i * 4]!;
  return taper(out, 10, fs);
}

export const maxAbs = (x: ArrayLike<number>): number => {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]!));
  return m;
};
