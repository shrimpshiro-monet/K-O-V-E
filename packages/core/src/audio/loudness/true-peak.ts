/**
 * True-peak estimation per ITU-R BS.1770-4 Annex 2: 4x oversampling with a
 * band-limited (Kaiser-windowed sinc) interpolator. The three inter-sample
 * points between every pair of input samples are evaluated; the original
 * samples are the fourth phase.
 *
 * Tolerance required by EBU Tech 3341 signals 15-23: +0.2 / -0.4 dB.
 */

export const TRUE_PEAK_OVERSAMPLING = 4;
/** Taps per polyphase branch. 12 x 4 = the 48-tap structure of BS.1770 Annex 2. */
export const TRUE_PEAK_TAPS = 12;
const KAISER_BETA = 6.5;

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 60; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < 1e-18 * sum) break;
  }
  return sum;
}

const sinc = (x: number): number => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));

/**
 * coefficients[p-1][k] weights input sample x[n0 - T/2 + 1 + k] to give the
 * value at n0 + p/4, for p = 1..3 (k = 0..T-1). DC gain is normalised to 1.
 */
export function buildTruePeakFilter(
  taps = TRUE_PEAK_TAPS,
  ratio = TRUE_PEAK_OVERSAMPLING,
): Float64Array[] {
  const half = taps / 2;
  const i0Beta = besselI0(KAISER_BETA);
  const phases: Float64Array[] = [];
  for (let p = 1; p < ratio; p++) {
    const frac = p / ratio;
    const c = new Float64Array(taps);
    let sum = 0;
    for (let k = 0; k < taps; k++) {
      const t = k - (half - 1) - frac; // distance from the interpolation point in samples
      const r = t / half;
      const w = Math.abs(r) >= 1 ? 0 : besselI0(KAISER_BETA * Math.sqrt(1 - r * r)) / i0Beta;
      c[k] = sinc(t) * w;
      sum += c[k]!;
    }
    for (let k = 0; k < taps; k++) c[k]! /= sum;
    phases.push(c);
  }
  return phases;
}

/** Streaming per-channel true-peak tracker. */
export class TruePeakTracker {
  private readonly phases = buildTruePeakFilter();
  private readonly taps = TRUE_PEAK_TAPS;
  /** Linear ring of the most recent `taps` samples, oldest first (shifted on push). */
  private readonly history = new Float64Array(TRUE_PEAK_TAPS);
  private _samplePeak = 0;
  private _truePeak = 0;

  get samplePeak(): number {
    return this._samplePeak;
  }
  get truePeak(): number {
    return Math.max(this._truePeak, this._samplePeak);
  }

  push(x: number): void {
    const h = this.history;
    const taps = this.taps;
    for (let i = 0; i < taps - 1; i++) h[i] = h[i + 1]!;
    h[taps - 1] = x;
    const ax = Math.abs(x);
    if (ax > this._samplePeak) this._samplePeak = ax;
    this.scan(h);
  }

  private scan(h: Float64Array): void {
    const phases = this.phases;
    for (let p = 0; p < phases.length; p++) {
      const c = phases[p]!;
      let acc = 0;
      for (let k = 0; k < this.taps; k++) acc += c[k]! * h[k]!;
      const a = Math.abs(acc);
      if (a > this._truePeak) this._truePeak = a;
    }
  }

  /**
   * Peak including the tail: feeds taps/2 zeros through a COPY of the state so the
   * final inter-sample points are seen without disturbing a running meter.
   */
  peakWithTail(): { samplePeak: number; truePeak: number } {
    const h = Float64Array.from(this.history);
    let tp = this._truePeak;
    const phases = this.phases;
    for (let z = 0; z < this.taps / 2; z++) {
      for (let i = 0; i < this.taps - 1; i++) h[i] = h[i + 1]!;
      h[this.taps - 1] = 0;
      for (let p = 0; p < phases.length; p++) {
        const c = phases[p]!;
        let acc = 0;
        for (let k = 0; k < this.taps; k++) acc += c[k]! * h[k]!;
        tp = Math.max(tp, Math.abs(acc));
      }
    }
    return { samplePeak: this._samplePeak, truePeak: Math.max(tp, this._samplePeak) };
  }
}
