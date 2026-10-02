import { kWeightingCoefficients } from "./k-weighting";
import { TruePeakTracker } from "./true-peak";

/**
 * Programme loudness per ITU-R BS.1770-4, with the EBU R128 / Tech 3341 / Tech 3342
 * measures built on it:
 *
 *  - Integrated loudness: 400 ms blocks, 75 % overlap (100 ms step), absolute gate
 *    -70 LUFS, relative gate 10 LU below the absolute-gated mean. Incomplete trailing
 *    blocks are discarded.
 *  - Momentary (400 ms) and short-term (3 s) maxima: sliding rectangular windows, not gated,
 *    tracked on a ~1 ms grid (Tech 3341 case 13/14 shift the tone in 20 ms steps).
 *  - Loudness range (Tech 3342): 3 s windows at 10 Hz, absolute gate -70 LUFS, relative gate
 *    -20 LU, 10th-95th percentile spread (percentile indexing as in the Tech 3342 reference code).
 *  - True peak: 4x oversampled (see true-peak.ts), reported in dBTP.
 *
 * Streaming: call `push()` with consecutive chunks, `result()` at any time (non-destructive).
 * Memory is O(duration) at 10 floats/second, independent of the sample rate.
 */

export type ChannelRole = "M" | "L" | "R" | "C" | "LFE" | "Ls" | "Rs";

/** BS.1770-4 channel weights G_i (applied to mean-square). LFE is excluded. */
export const CHANNEL_WEIGHT: Readonly<Record<ChannelRole, number>> = {
  M: 1,
  L: 1,
  R: 1,
  C: 1,
  LFE: 0,
  Ls: 1.41,
  Rs: 1.41,
};

/** Default roles for a channel count (BS.775 / WAV order: L R C LFE Ls Rs). */
export function defaultChannelRoles(count: number): ChannelRole[] {
  switch (count) {
    case 1:
      return ["M"];
    case 2:
      return ["L", "R"];
    case 3:
      return ["L", "R", "C"];
    case 4:
      return ["L", "R", "Ls", "Rs"];
    case 5:
      return ["L", "R", "C", "Ls", "Rs"];
    case 6:
      return ["L", "R", "C", "LFE", "Ls", "Rs"];
    default:
      throw new RangeError(
        `No default channel layout for ${count} channels; pass channelRoles explicitly`,
      );
  }
}

export interface LoudnessMeterOptions {
  readonly sampleRate: number;
  /** Defaults to `defaultChannelRoles(channelCount)`. Mono is measured as one centred channel (weight 1). */
  readonly channelRoles?: readonly ChannelRole[];
  readonly channelCount?: number;
}

export interface LoudnessResult {
  readonly standard: "ITU-R BS.1770-4 / EBU R128 (Tech 3341, Tech 3342)";
  readonly sampleRate: number;
  readonly channelRoles: readonly ChannelRole[];
  readonly durationSeconds: number;
  /** null = not measurable (silence / too short) — never a fabricated number. */
  readonly integratedLufs: number | null;
  readonly loudnessRangeLu: number | null;
  readonly momentaryMaxLufs: number | null;
  readonly shortTermMaxLufs: number | null;
  readonly truePeakDbtp: number | null;
  readonly samplePeakDbfs: number | null;
  readonly truePeakDbtpPerChannel: readonly (number | null)[];
  readonly gating: {
    readonly blocks: number;
    readonly absoluteGated: number;
    readonly relativeGated: number;
    readonly relativeThresholdLufs: number | null;
  };
  readonly range: {
    readonly windows: number;
    readonly relativeThresholdLufs: number | null;
    readonly lowLufs: number | null;
    readonly highLufs: number | null;
  };
}

const OFFSET = -0.691;
const ABS_GATE_LUFS = -70;
const REL_GATE_LU = -10;
const LRA_REL_GATE_LU = -20;
const LRA_LOW = 10;
const LRA_HIGH = 95;

const toLufs = (energy: number): number => OFFSET + 10 * Math.log10(energy);
const fromLufs = (lufs: number): number => Math.pow(10, (lufs - OFFSET) / 10);
const db = (linear: number): number | null => (linear > 0 ? 20 * Math.log10(linear) : null);

interface ChannelState {
  // stage 1 and stage 2 transposed-DF-II states
  s1a: number;
  s1b: number;
  s2a: number;
  s2b: number;
  readonly tp: TruePeakTracker;
}

export class LoudnessMeter {
  readonly sampleRate: number;
  readonly channelRoles: readonly ChannelRole[];
  private readonly weights: Float64Array;
  private readonly states: ChannelState[];
  private readonly coef: ReturnType<typeof kWeightingCoefficients>;

  private frames = 0;

  // 100 ms sub-blocks (gating + LRA)
  private readonly subLen: number;
  private subSum = 0;
  private subCount = 0;
  private subEnergies: number[] = []; // mean-square weighted sum per 100 ms sub-block (sum / subLen)

  // ~1 ms bins for momentary / short-term maxima
  private readonly binLen: number;
  private binSum = 0;
  private binCount = 0;
  private readonly mRing: Float64Array;
  private readonly sRing: Float64Array;
  private mIdx = 0;
  private sIdx = 0;
  private mFilled = 0;
  private sFilled = 0;
  private mSum = 0;
  private sSum = 0;
  private mMax = 0;
  private sMax = 0;

  constructor(options: LoudnessMeterOptions) {
    const { sampleRate } = options;
    const roles =
      options.channelRoles ?? defaultChannelRoles(options.channelCount ?? 2);
    this.sampleRate = sampleRate;
    this.channelRoles = roles;
    this.weights = Float64Array.from(roles.map((r) => CHANNEL_WEIGHT[r]));
    this.coef = kWeightingCoefficients(sampleRate);
    this.states = roles.map(() => ({ s1a: 0, s1b: 0, s2a: 0, s2b: 0, tp: new TruePeakTracker() }));
    this.subLen = Math.max(1, Math.round(sampleRate / 10));
    this.binLen = Math.max(1, Math.round(sampleRate / 1000));
    this.mRing = new Float64Array(Math.max(1, Math.round((0.4 * sampleRate) / this.binLen)));
    this.sRing = new Float64Array(Math.max(1, Math.round((3 * sampleRate) / this.binLen)));
  }

  get channelCount(): number {
    return this.channelRoles.length;
  }

  /** Feed one chunk: one array per channel, all the same length. */
  push(channels: ArrayLike<number>[]): void {
    if (channels.length !== this.channelCount) {
      throw new RangeError(`Expected ${this.channelCount} channels, got ${channels.length}`);
    }
    const length = channels[0]?.length ?? 0;
    for (const ch of channels) {
      if (ch.length !== length) throw new RangeError("All channels must have the same length");
    }
    const { shelf, highpass } = this.coef;
    const sb0 = shelf.b0, sb1 = shelf.b1, sb2 = shelf.b2, sa1 = shelf.a1, sa2 = shelf.a2;
    const hb0 = highpass.b0, hb1 = highpass.b1, hb2 = highpass.b2, ha1 = highpass.a1, ha2 = highpass.a2;
    const nCh = this.channelCount;
    // Per-channel filtered energy for this chunk is accumulated sample by sample.
    for (let n = 0; n < length; n++) {
      let e = 0;
      for (let c = 0; c < nCh; c++) {
        const st = this.states[c]!;
        const x = channels[c]![n]!;
        st.tp.push(x);
        const w = this.weights[c]!;
        if (w === 0) continue; // LFE: not part of the loudness measurement
        // stage 1
        const y1 = sb0 * x + st.s1a;
        st.s1a = sb1 * x - sa1 * y1 + st.s1b;
        st.s1b = sb2 * x - sa2 * y1;
        // stage 2
        const y2 = hb0 * y1 + st.s2a;
        st.s2a = hb1 * y1 - ha1 * y2 + st.s2b;
        st.s2b = hb2 * y1 - ha2 * y2;
        e += w * y2 * y2;
      }
      this.accumulate(e);
    }
    this.frames += length;
  }

  private accumulate(e: number): void {
    // 100 ms sub-block
    this.subSum += e;
    if (++this.subCount === this.subLen) {
      this.subEnergies.push(this.subSum / this.subLen);
      this.subSum = 0;
      this.subCount = 0;
    }
    // ~1 ms bin
    this.binSum += e;
    if (++this.binCount === this.binLen) {
      this.pushBin(this.binSum);
      this.binSum = 0;
      this.binCount = 0;
    }
  }

  private pushBin(sum: number): void {
    const mOld = this.mRing[this.mIdx]!;
    this.mRing[this.mIdx] = sum;
    this.mIdx = (this.mIdx + 1) % this.mRing.length;
    this.mSum += sum - mOld;
    if (this.mFilled < this.mRing.length) this.mFilled++;
    else {
      const energy = Math.max(0, this.mSum) / (this.mRing.length * this.binLen);
      if (energy > this.mMax) this.mMax = energy;
    }

    const sOld = this.sRing[this.sIdx]!;
    this.sRing[this.sIdx] = sum;
    this.sIdx = (this.sIdx + 1) % this.sRing.length;
    this.sSum += sum - sOld;
    if (this.sFilled < this.sRing.length) this.sFilled++;
    else {
      const energy = Math.max(0, this.sSum) / (this.sRing.length * this.binLen);
      if (energy > this.sMax) this.sMax = energy;
    }
  }

  /** Snapshot of everything measured so far. Does not modify the meter. */
  result(): LoudnessResult {
    const blocks = this.gatingBlocks();
    const gating = this.integrated(blocks);
    const range = this.loudnessRange();

    const tps = this.states.map((s) => s.tp.peakWithTail());
    const perChannel = tps.map((t) => db(t.truePeak));
    const tpMax = Math.max(0, ...tps.map((t) => t.truePeak));
    const spMax = Math.max(0, ...tps.map((t) => t.samplePeak));

    return {
      standard: "ITU-R BS.1770-4 / EBU R128 (Tech 3341, Tech 3342)",
      sampleRate: this.sampleRate,
      channelRoles: this.channelRoles,
      durationSeconds: this.frames / this.sampleRate,
      integratedLufs: gating.lufs,
      loudnessRangeLu: range.lra,
      momentaryMaxLufs: this.mMax > 0 ? toLufs(this.mMax) : null,
      shortTermMaxLufs: this.sMax > 0 ? toLufs(this.sMax) : null,
      truePeakDbtp: db(tpMax),
      samplePeakDbfs: db(spMax),
      truePeakDbtpPerChannel: perChannel,
      gating: {
        blocks: blocks.length,
        absoluteGated: gating.absoluteGated,
        relativeGated: gating.relativeGated,
        relativeThresholdLufs: gating.relativeThreshold,
      },
      range: {
        windows: range.windows,
        relativeThresholdLufs: range.relativeThreshold,
        lowLufs: range.low,
        highLufs: range.high,
      },
    };
  }

  /** Loudness (LUFS) of every complete 400 ms block at a 100 ms step; -Infinity for digital silence. */
  blockLoudnessSeries(): number[] {
    return this.gatingBlocks().map((z) => (z > 0 ? toLufs(z) : -Infinity));
  }

  /** Un-gated 3 s short-term loudness (LUFS) at 10 Hz — the input to the LRA algorithm. */
  shortTermLoudnessSeries(): number[] {
    return this.shortTermEnergies().map((z) => (z > 0 ? toLufs(z) : -Infinity));
  }

  private shortTermEnergies(): number[] {
    const sub = this.subEnergies;
    const W = 30;
    const levels: number[] = [];
    if (sub.length >= W) {
      let acc = 0;
      for (let i = 0; i < W; i++) acc += sub[i]!;
      levels.push(acc / W);
      for (let j = W; j < sub.length; j++) {
        acc += sub[j]! - sub[j - W]!;
        levels.push(Math.max(0, acc) / W);
      }
    }
    return levels;
  }

  /** Energies of every complete 400 ms block at a 100 ms step. */
  private gatingBlocks(): number[] {
    const sub = this.subEnergies;
    const out: number[] = [];
    for (let j = 0; j + 4 <= sub.length; j++) {
      out.push((sub[j]! + sub[j + 1]! + sub[j + 2]! + sub[j + 3]!) / 4);
    }
    return out;
  }

  private integrated(blocks: number[]): {
    lufs: number | null;
    absoluteGated: number;
    relativeGated: number;
    relativeThreshold: number | null;
  } {
    const absEnergy = fromLufs(ABS_GATE_LUFS);
    let sum = 0;
    let n = 0;
    for (const z of blocks) {
      if (z > absEnergy) {
        sum += z;
        n++;
      }
    }
    if (n === 0) return { lufs: null, absoluteGated: 0, relativeGated: 0, relativeThreshold: null };
    const relThreshold = toLufs(sum / n) + REL_GATE_LU;
    const relEnergy = fromLufs(relThreshold);
    let rSum = 0;
    let rN = 0;
    for (const z of blocks) {
      if (z > absEnergy && z > relEnergy) {
        rSum += z;
        rN++;
      }
    }
    return {
      lufs: rN > 0 ? toLufs(rSum / rN) : null,
      absoluteGated: n,
      relativeGated: rN,
      relativeThreshold: relThreshold,
    };
  }

  /** Tech 3342 loudness range from 3 s windows at 10 Hz. */
  private loudnessRange(): {
    lra: number | null;
    windows: number;
    relativeThreshold: number | null;
    low: number | null;
    high: number | null;
  } {
    const levels = this.shortTermEnergies();
    const stl = levels.map((e) => (e > 0 ? toLufs(e) : -Infinity));
    const absGated = stl.filter((l) => l >= ABS_GATE_LUFS);
    if (absGated.length === 0) {
      return { lra: null, windows: levels.length, relativeThreshold: null, low: null, high: null };
    }
    const meanPower = absGated.reduce((s, l) => s + Math.pow(10, l / 10), 0) / absGated.length;
    const relThreshold = 10 * Math.log10(meanPower) + LRA_REL_GATE_LU;
    const gated = absGated.filter((l) => l >= relThreshold).sort((a, b) => a - b);
    const n = gated.length;
    if (n === 0) return { lra: null, windows: levels.length, relativeThreshold: relThreshold, low: null, high: null };
    // MATLAB: sorted(round((n-1)*p/100 + 1)), 1-based  ->  0-based round((n-1)*p/100)
    const low = gated[Math.round(((n - 1) * LRA_LOW) / 100)]!;
    const high = gated[Math.round(((n - 1) * LRA_HIGH) / 100)]!;
    return { lra: high - low, windows: levels.length, relativeThreshold: relThreshold, low, high };
  }
}

export interface MeasureOptions {
  readonly channelRoles?: readonly ChannelRole[];
}

/** Measure a whole buffer (one Float32Array/number[] per channel). */
export function measureLoudness(
  channels: ArrayLike<number>[],
  sampleRate: number,
  options: MeasureOptions = {},
): LoudnessResult {
  const meter = new LoudnessMeter({
    sampleRate,
    channelCount: channels.length,
    channelRoles: options.channelRoles,
  });
  meter.push(channels);
  return meter.result();
}
