import { rhythmSimilarity } from "@kove-advanced/core/rhythm/dtw";
export interface QualityAxes { rhythm: number; colorMatch: number; motionFidelity: number; continuity: number }
export type QualityWeights = QualityAxes;
export const DEFAULT_WEIGHTS: QualityWeights = { rhythm: 0.35, colorMatch: 0.25, motionFidelity: 0.25, continuity: 0.15 };
export function scorePlan(axes: QualityAxes, weights: QualityWeights = DEFAULT_WEIGHTS): number {
  const keys: Array<keyof QualityAxes> = ["rhythm", "colorMatch", "motionFidelity", "continuity"];
  if (keys.some((key) => !Number.isFinite(axes[key]) || axes[key] < 0 || axes[key] > 1 || !Number.isFinite(weights[key]) || weights[key] < 0)) throw new Error("Quality axes must be 0..1 and weights nonnegative");
  const total = keys.reduce((sum, key) => sum + weights[key], 0);
  if (!total) throw new Error("At least one quality weight is required");
  return keys.reduce((sum, key) => sum + axes[key] * weights[key], 0) / total;
}
export const computeRhythmAxis = rhythmSimilarity;
