import type { ReferenceProfile } from "./reference-profile";

/** Per-boundary cut comparison result (frames on the reference clock). */
export interface CutComparison {
  readonly toleranceFrames: number;
  readonly referenceFrames: number[];
  readonly outputFrames: number[];
  /** Reference cut frames with a matching output cut within tolerance. */
  readonly matchedFrames: number[];
  /** Reference cut frames with no output cut within tolerance. */
  readonly missedFrames: number[];
  /** Output cuts that match no reference cut. */
  readonly extraFrames: number[];
  readonly meanAbsoluteDeltaFrames: number;
}

/** The weighted 0-100 score breakdown written to diff-report.json. */
export interface DiffScore {
  readonly total: number;
  readonly rhythm: number;
  readonly treatmentCoverage: number;
  readonly grade: number | null;
  readonly energyShape: number | null;
}

export interface DiffReport {
  readonly score: DiffScore;
  readonly cuts: CutComparison;
  readonly shotLengths: {
    readonly reference: { median: number; p25: number; p75: number };
    readonly output: { median: number; p25: number; p75: number };
  };
  /** Measured reference boundary accents covered by a rendered transition or timed effect. */
  readonly transitionCoverage: {
    readonly referenceAccents: number;
    readonly covered: number;
    readonly uncoveredFrames: number[];
  };
}

function nearestWithin(value: number, sorted: readonly number[], tolerance: number): { index: number; delta: number } | undefined {
  let best: { index: number; delta: number } | undefined;
  for (let i = 0; i < sorted.length; i++) {
    const delta = Math.abs(sorted[i]! - value);
    if (delta <= tolerance && (best === undefined || delta < best.delta)) best = { index: i, delta };
  }
  return best;
}

export function compareCutFrames(
  referenceFrames: readonly number[],
  outputFrames: readonly number[],
  toleranceFrames: number,
): CutComparison {
  const outputSorted = [...outputFrames].sort((a, b) => a - b);
  const used = new Set<number>();
  const matchedFrames: number[] = [];
  const missedFrames: number[] = [];
  let deltaSum = 0;
  for (const frame of referenceFrames) {
    const match = nearestWithin(frame, outputSorted, toleranceFrames);
    if (match && !used.has(match.index)) {
      used.add(match.index);
      matchedFrames.push(frame);
      deltaSum += match.delta;
    } else {
      missedFrames.push(frame);
    }
  }
  const extraFrames = outputSorted.filter((_, index) => !used.has(index));
  return {
    toleranceFrames,
    referenceFrames: [...referenceFrames],
    outputFrames: outputSorted,
    matchedFrames,
    missedFrames,
    extraFrames,
    meanAbsoluteDeltaFrames: matchedFrames.length ? deltaSum / matchedFrames.length : 0,
  };
}

/** Pearson correlation; null when either series is flat (no signal to match). */
export function pearson(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length || a.length < 2) return null;
  const meanA = a.reduce((s, v) => s + v, 0) / a.length;
  const meanB = b.reduce((s, v) => s + v, 0) / b.length;
  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i]! - meanA, db = b[i]! - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return null;
  return cov / Math.sqrt(varA * varB);
}

function quantiles(frames: readonly number[]): { median: number; p25: number; p75: number } {
  if (frames.length === 0) return { median: 0, p25: 0, p75: 0 };
  const sorted = [...frames].sort((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
  return { median: at(0.5), p25: at(0.25), p75: at(0.75) };
}

/** Shot-length rhythm score: median ratio distance, 1.0 at parity, 0 beyond 2x. */
function rhythmScore(referenceMedian: number, outputMedian: number): number {
  if (referenceMedian <= 0 || outputMedian <= 0) return 0;
  const ratio = Math.min(referenceMedian, outputMedian) / Math.max(referenceMedian, outputMedian);
  // 2x off → 0, exact → 1, linear in log space: ratio = e^(-k) → score = 1 - k/ln2.
  return Math.max(0, 1 + Math.log(ratio) / Math.LN2);
}

/**
 * Build the measured diff between the reference edit and the rendered output.
 * All output measurements come from the rendered file; nothing is derived from
 * the timeline plan (a plan can declare anything, the render is the truth).
 */
export function buildDiffReport(input: {
  reference: ReferenceProfile;
  /** Output cut frames on the output clock, measured from render.mp4. */
  outputCutFrames: readonly number[];
  /** Output per-second energy samples aligned to the reference edit range length. */
  outputEnergyCurve?: readonly number[];
  /** Lab stats of the output (global), when measured. */
  outputLabStats?: { lMean: number };
  /** Reference boundary accent frames (flash/dip/etc., excluding hard cuts). */
  referenceAccentFrames?: readonly number[];
  /** Output boundary frames that carry a rendered transition or timed effect. */
  outputAccentFrames?: readonly number[];
  /** Mean Lab L of the reference, when measured. */
  referenceLabLMean?: number;
}): DiffReport {
  const { reference } = input;
  const structure = reference.structure;
  const fps = reference.fps.num / reference.fps.den;
  const tolerance = Math.max(1, Math.round(fps / 15));
  const referenceCutFrames = structure
    ? structure.events.filter((event) => event.type === "hard-cut").map((event) => event.frame)
    : reference.shots.slice(1).map((shot) => shot.startFrame);
  const cuts = compareCutFrames(referenceCutFrames, input.outputCutFrames, tolerance);

  const referenceLengths = reference.shots.map((shot) => shot.endFrame - shot.startFrame);
  const outputLengths = input.outputCutFrames.length
    ? [input.outputCutFrames[0]!, ...input.outputCutFrames.slice(1).map((frame, i) => frame - input.outputCutFrames[i]!), Math.max(1, reference.durationFrames - input.outputCutFrames.at(-1)!)]
    : [reference.durationFrames];
  const referenceStats = structure?.shotLengths ?? (() => {
    const stats = quantiles(referenceLengths);
    return { median: stats.median, p25: stats.p25, p75: stats.p75, min: Math.min(...referenceLengths), max: Math.max(...referenceLengths) };
  })();
  const outputStats = quantiles(outputLengths);

  const referenceAccents = input.referenceAccentFrames ?? structure?.events.filter((event) => event.type !== "hard-cut").map((event) => event.frame) ?? [];
  const outputAccents = input.outputAccentFrames ?? [];
  const coveredAccents = referenceAccents.filter((frame) => nearestWithin(frame, outputAccents, tolerance) !== undefined);
  const transitionCoverage = {
    referenceAccents: referenceAccents.length,
    covered: coveredAccents.length,
    uncoveredFrames: referenceAccents.filter((frame) => !coveredAccents.includes(frame)),
  };

  const energyShape = input.outputEnergyCurve && structure
    ? pearson(structure.energyCurve, [...input.outputEnergyCurve])
    : null;

  const rhythmScoreValue = rhythmScore(referenceStats.median, outputStats.median);
  const cutMatchRatio = referenceCutFrames.length ? cuts.matchedFrames.length / referenceCutFrames.length : 1;
  const coverage = referenceAccents.length ? transitionCoverage.covered / referenceAccents.length : 1;
  const grade = input.outputLabStats && input.referenceLabLMean !== undefined
    ? Math.max(0, 1 - Math.abs(input.outputLabStats.lMean - input.referenceLabLMean) / 50)
    : null;

  // Weights: rhythm 40 (cut match + shot-length parity), treatment coverage 30,
  // grade 15 (when measurable), energy shape 15 (when measurable). Unmeasured
  // dimensions drop out of both the numerator and the denominator: the total
  // is the share of *measured* weight that was actually achieved.
  const gradeWeight = grade === null ? 0 : 15;
  const energyWeight = energyShape === null ? 0 : 15;
  const measured = 40 + 30 + gradeWeight + energyWeight;
  const rhythm = Math.round((0.5 * cutMatchRatio + 0.5 * rhythmScoreValue) * 40);
  const treatmentCoverage = Math.round(coverage * 30);
  const achieved = rhythm + treatmentCoverage + (grade === null ? 0 : Math.round(grade * 15)) + (energyShape === null ? 0 : Math.round(Math.max(0, energyShape) * 15));
  const score: DiffScore = {
    total: measured > 0 ? Math.round((achieved / measured) * 100) : 0,
    rhythm,
    treatmentCoverage,
    grade: grade === null ? null : Math.round(grade * 15),
    energyShape: energyShape === null ? null : Math.round(Math.max(0, energyShape) * 15),
  };

  return {
    score,
    cuts,
    shotLengths: {
      reference: { median: referenceStats.median, p25: referenceStats.p25, p75: referenceStats.p75 },
      output: outputStats,
    },
    transitionCoverage,
  };
}
