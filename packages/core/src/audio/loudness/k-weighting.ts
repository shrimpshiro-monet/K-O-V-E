/**
 * ITU-R BS.1770-4 K-weighting: a high-shelf pre-filter ("stage 1") followed by
 * the RLB high-pass ("stage 2"), both biquads.
 *
 * Coefficients are derived for ANY sample rate from the analogue prototype via
 * the bilinear transform, so 44.1 / 96 kHz are exact too instead of resampled
 * 48 kHz tables. At 48 kHz this reproduces the tabulated BS.1770-4 coefficients
 * (asserted in loudness.k-weighting.test.ts).
 *
 * Prototype constants are the ones that reproduce the BS.1770 48 kHz tables
 * (they are also what libebur128 and pyloudnorm use).
 */

export interface Biquad {
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  readonly a1: number;
  readonly a2: number;
}

export interface KWeightingCoefficients {
  readonly shelf: Biquad;
  readonly highpass: Biquad;
}

const SHELF_F0 = 1681.974450955533;
const SHELF_GAIN_DB = 3.999843853973347;
const SHELF_Q = 0.7071752369554196;
const HP_F0 = 38.13547087602444;
const HP_Q = 0.5003270373238773;

export function kWeightingCoefficients(sampleRate: number): KWeightingCoefficients {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000) {
    throw new RangeError(`Unsupported sample rate: ${sampleRate}`);
  }
  // Stage 1: high shelf.
  const vh = Math.pow(10, SHELF_GAIN_DB / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  let k = Math.tan((Math.PI * SHELF_F0) / sampleRate);
  const a0 = 1 + k / SHELF_Q + k * k;
  const shelf: Biquad = {
    b0: (vh + (vb * k) / SHELF_Q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / SHELF_Q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / SHELF_Q + k * k) / a0,
  };
  // Stage 2: RLB high-pass.
  k = Math.tan((Math.PI * HP_F0) / sampleRate);
  const d = 1 + k / HP_Q + k * k;
  const highpass: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k * k - 1)) / d,
    a2: (1 - k / HP_Q + k * k) / d,
  };
  return { shelf, highpass };
}

/** Magnitude response of the cascade in dB at `frequency` (for tests/diagnostics). */
export function kWeightingResponseDb(sampleRate: number, frequency: number): number {
  const { shelf, highpass } = kWeightingCoefficients(sampleRate);
  const w = (2 * Math.PI * frequency) / sampleRate;
  const mag = (f: Biquad): number => {
    const re = (c: number, x: number) => c * Math.cos(x * w);
    const im = (c: number, x: number) => -c * Math.sin(x * w);
    const nr = f.b0 + re(f.b1, 1) + re(f.b2, 2);
    const ni = im(f.b1, 1) + im(f.b2, 2);
    const dr = 1 + re(f.a1, 1) + re(f.a2, 2);
    const di = im(f.a1, 1) + im(f.a2, 2);
    return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
  };
  return 20 * Math.log10(mag(shelf) * mag(highpass));
}
