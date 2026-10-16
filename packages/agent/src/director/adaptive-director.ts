import type { ReferenceProfile } from "@kove-advanced/core/mirror/reference-profile";
import { searchBestPlan, type TunableParam } from "./plan-optimizer";
import type { QualityAxes } from "./edit-quality-score";
export interface SemanticChoice { shotIndex: number; footageClipId: string; cameraMoveFamily: string; captionText: string }
export interface DirectorOutput { semantic: SemanticChoice[]; tunedParams: Record<string, number>; score: number; history: number[] }
/** Pure search phase; caller supplies measurements from each preview. No fabricated perceptual axes. */
export function runAdaptiveDirector(reference: ReferenceProfile, semantic: SemanticChoice[], measurePreview: (values: Record<string, number>) => QualityAxes): DirectorOutput {
  const params: TunableParam[] = reference.shots.flatMap((shot, i) => [
    { path: `shot[${i}].cameraIntensity`, min: 0, max: 2, current: Math.min(2, Math.max(0, shot.cameraMotion?.samples[0]?.scale ?? 1)), actionType: "keyframe/setAll" },
    { path: `shot[${i}].transitionDuration`, min: 0.05, max: 1, current: 0.3, actionType: "transition/update" },
  ]);
  const result = searchBestPlan(params, measurePreview, { trials: 150, stepDecay: 0.975 });
  return { semantic, tunedParams: result.bestValues, score: result.bestScore, history: result.history };
}
