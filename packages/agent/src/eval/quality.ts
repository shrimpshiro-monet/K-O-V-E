import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Structural quality scoring for produced edits, measured against real
 * reference fingerprints (the measured shot/beat structure of a human edit,
 * e.g. evaluation-files/reference/real-*.json).
 *
 * Hard gates answer "is the plan valid"; this answers "does the cut look
 * like an edit a human would ship". It is informational: it never flips a
 * case's ok/gates, it only travels with the result so a baseline report
 * carries both.
 */

export interface ReferenceFingerprint {
  /** File the fingerprint was measured from. */
  readonly source: string;
  readonly shotCount: number;
  readonly shotDurationsSec: readonly number[];
  readonly beatCount: number;
  readonly durationSeconds: number;
}

/** What the director actually produced, as far as structure goes. */
export interface ProducedCutStats {
  readonly clipCount: number;
  readonly clipDurationsSec: readonly number[];
  readonly timelineDuration: number;
  readonly transitionCount: number;
  readonly effectCount: number;
  readonly textCount: number;
}

export interface QualityComponent {
  readonly score: number;
  readonly detail: string;
}

export interface QualityScore {
  readonly reference: string;
  readonly cutGranularity: QualityComponent;
  readonly rhythmSimilarity: QualityComponent;
  readonly craft: QualityComponent;
  /** Mean of the three components (0..1). */
  readonly overall: number;
}

const round4 = (n: number): number => Math.round(n * 10000) / 10000;

interface RawProfile {
  readonly fps?: { readonly num?: number; readonly den?: number };
  readonly durationFrames?: number;
  readonly beatGridMs?: readonly unknown[];
  readonly shots?: ReadonlyArray<{
    readonly startFrame?: number;
    readonly endFrame?: number;
    readonly captionWindows?: readonly unknown[];
  }>;
}

/**
 * Parses a measured profile file. Accepts both the browser-measurement wrapper
 * ({ clock, profile, ... }) and a bare ReferenceProfile; returns null for
 * anything structurally unusable.
 */
export function parseReferenceFingerprint(source: string, json: unknown): ReferenceFingerprint | null {
  if (typeof json !== "object" || json === null) return null;
  const root = json as Record<string, unknown>;
  const profile = (root.profile && typeof root.profile === "object" ? root.profile : root) as RawProfile;
  const num = profile.fps?.num;
  const den = profile.fps?.den;
  const shots = profile.shots;
  if (!Array.isArray(shots) || shots.length === 0) return null;
  if (!num || !den || num <= 0 || den <= 0) return null;
  const fps = num / den;
  const durations: number[] = [];
  for (const shot of shots) {
    if (typeof shot?.startFrame !== "number" || typeof shot?.endFrame !== "number") return null;
    const seconds = (shot.endFrame - shot.startFrame) / fps;
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    durations.push(seconds);
  }
  const durationSeconds =
    typeof profile.durationFrames === "number" && profile.durationFrames > 0
      ? profile.durationFrames / fps
      : durations.reduce((sum, d) => sum + d, 0);
  return {
    source,
    shotCount: durations.length,
    shotDurationsSec: durations,
    beatCount: Array.isArray(profile.beatGridMs) ? profile.beatGridMs.length : 0,
    durationSeconds,
  };
}

/** Loads every real-*.json fingerprint in a directory (missing dir → []). */
export function loadReferenceFingerprints(dir: string): ReferenceFingerprint[] {
  if (!existsSync(dir)) return [];
  const fingerprints: ReferenceFingerprint[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!/^real-.*\.json$/i.test(name)) continue;
    try {
      const fingerprint = parseReferenceFingerprint(name, JSON.parse(readFileSync(resolve(dir, name), "utf8")));
      if (fingerprint) fingerprints.push(fingerprint);
    } catch {
      // A malformed fingerprint file is skipped, never fatal to the run.
    }
  }
  return fingerprints;
}

const mean = (values: readonly number[]): number =>
  values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;

const stdev = (values: readonly number[]): number => {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / (values.length - 1));
};

/** log-ratio closeness: 1 when a == b, decaying toward 0 as they diverge. */
const ratioCloseness = (a: number, b: number): number => {
  if (a <= 0 || b <= 0) return 0;
  return Math.exp(-Math.abs(Math.log(a / b)));
};

/**
 * Scores a produced edit against one reference fingerprint.
 * - cutGranularity: do the cuts sit at the reference's granularity
 *   (sub-second chops vs one long take read very differently)?
 * - rhythmSimilarity: does the clip-length distribution (mean + spread)
 *   track the reference's shot-length distribution?
 * - craft: did the director use transitions, effects and text at all?
 */
export function scoreProducedEdit(produced: ProducedCutStats, ref: ReferenceFingerprint): QualityScore {
  const granularityScore =
    produced.clipCount <= 0 || ref.shotCount <= 0
      ? 0
      : ratioCloseness(produced.clipCount, ref.shotCount);
  const cutGranularity: QualityComponent = {
    score: round4(granularityScore),
    detail: `${produced.clipCount} produced cuts vs ${ref.shotCount} reference shots`,
  };

  const prodMean = mean(produced.clipDurationsSec);
  const refMean = mean(ref.shotDurationsSec);
  const prodCv = prodMean > 0 ? stdev(produced.clipDurationsSec) / prodMean : 0;
  const refCv = refMean > 0 ? stdev(ref.shotDurationsSec) / refMean : 0;
  const meanScore = ratioCloseness(prodMean, refMean);
  const spreadScore = ratioCloseness(prodCv + 1e-6, refCv + 1e-6);
  const rhythmSimilarity: QualityComponent = {
    score: round4((meanScore + spreadScore) / 2),
    detail:
      `mean cut ${prodMean.toFixed(2)}s vs ${refMean.toFixed(2)}s, ` +
      `spread(cv) ${prodCv.toFixed(2)} vs ${refCv.toFixed(2)}`,
  };

  const craftChecks = [
    produced.transitionCount > 0,
    produced.effectCount > 0,
    produced.textCount > 0,
  ];
  const craft: QualityComponent = {
    score: round4(craftChecks.filter(Boolean).length / craftChecks.length),
    detail:
      `transitions=${produced.transitionCount} effects=${produced.effectCount} texts=${produced.textCount}`,
  };

  return {
    reference: ref.source,
    cutGranularity,
    rhythmSimilarity,
    craft,
    overall: round4((cutGranularity.score + rhythmSimilarity.score + craft.score) / 3),
  };
}

/** Best-matching reference (an edit only needs to clear one style target). */
export function bestQuality(
  produced: ProducedCutStats,
  refs: readonly ReferenceFingerprint[],
): QualityScore | null {
  let best: QualityScore | null = null;
  for (const ref of refs) {
    const score = scoreProducedEdit(produced, ref);
    if (!best || score.overall > best.overall) best = score;
  }
  return best;
}

/** Aggregate quality over passing runs, keyed by reference and overall. */
export function summarizeQuality(scores: readonly QualityScore[]): {
  readonly references: readonly string[];
  readonly scored: number;
  readonly meanOverall: number | null;
  readonly byReference: Record<string, number>;
} | null {
  if (!scores.length) return null;
  const byReference = new Map<string, number[]>();
  for (const score of scores) {
    const bucket = byReference.get(score.reference) ?? [];
    bucket.push(score.overall);
    byReference.set(score.reference, bucket);
  }
  const map: Record<string, number> = {};
  for (const [name, values] of byReference) map[name] = round4(mean(values));
  return {
    references: [...byReference.keys()].sort(),
    scored: scores.length,
    meanOverall: round4(mean(scores.map(s => s.overall))),
    byReference: map,
  };
}
