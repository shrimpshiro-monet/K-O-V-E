import { dtwDistance, rhythmSimilarity } from "./dtw";

/** Pure pacing shape: each shot is a fraction of its sequence's total duration.
 * Keep this outside dtwDistance so exact 1:1 scoring can retain raw durations. */
export function normalizeDurationsByTotal(durations: readonly number[]): number[] {
  if (durations.some((duration) => !Number.isFinite(duration) || duration < 0)) {
    throw new Error("Rhythm requires finite nonnegative shot durations");
  }
  const total = durations.reduce((sum, duration) => sum + duration, 0);
  if (!Number.isFinite(total)) throw new Error("Rhythm duration total must be finite");
  if (durations.length && total === 0) throw new Error("Cannot normalize a zero-duration rhythm");
  return total ? durations.map((duration) => duration / total) : [];
}

/** Style comparison only: invariant to a uniform speed change, not to the
 * order or relative size of shots. Exact Mirror still uses rhythmSimilarity. */
export function tempoInvariantRhythmSimilarity(reference: readonly number[], candidate: readonly number[]): number {
  if (!reference.length || !candidate.length) return rhythmSimilarity(reference, candidate);
  // No meaningful tempo for an all-zero sequence: use the exact metric rather
  // than silently dividing by zero or calling its shape a perfect match.
  if (reference.every((duration) => duration === 0) || candidate.every((duration) => duration === 0)) {
    return rhythmSimilarity(reference, candidate);
  }
  const normalizedReference = normalizeDurationsByTotal(reference);
  const normalizedCandidate = normalizeDurationsByTotal(candidate);
  const referenceScale = normalizedReference.reduce((max, duration) => Math.max(max, duration), 1e-9);
  const scale = normalizedCandidate.reduce((max, duration) => Math.max(max, duration), referenceScale);
  return Math.max(0, 1 - dtwDistance(normalizedReference, normalizedCandidate).cost / scale);
}
