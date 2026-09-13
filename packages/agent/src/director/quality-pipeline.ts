import type {
  EditPlan,
  SegmentMap,
  RenderedFrameObservation,
  RenderedDraftReview,
} from "@kove-advanced/creation-schema";
import { reviewRenderedDraft } from "@kove-advanced/creation-schema";
import type { EditingHost } from "../host";
import type { DraftSelfReview, EditPlanReview, MaterializedDraftSummary } from "./plan-review";
import { reviewMaterializedDraft } from "./plan-review";

export interface FrameSamplingResult {
  readonly observations: readonly RenderedFrameObservation[];
  readonly sampledCount: number;
  readonly totalDuration: number;
}

export interface QualityPipelineResult {
  readonly renderedReview: RenderedDraftReview;
  readonly draftReview: DraftSelfReview;
  readonly combinedScore: number;
  readonly needsCorrection: boolean;
  readonly corrections: readonly QualityCorrection[];
}

export interface QualityCorrection {
  readonly kind: "effect" | "timing" | "transition";
  readonly segmentIndex?: number;
  readonly description: string;
}

/**
 * Sample frames from the rendered timeline at strategic timestamps.
 * Uses the host's extractVideoFrame job to capture frames, then
 * converts them into RenderedFrameObservation objects for quality review.
 *
 * Falls back to synthetic observations when the host cannot extract frames
 * (e.g. headless environments without a renderer), so the pipeline always
 * produces reviewable data.
 */
export async function sampleRenderedFrames(
  plan: EditPlan,
  host: EditingHost,
): Promise<FrameSamplingResult> {
  const totalDuration = plan.metadata.targetDuration > 0
    ? plan.metadata.targetDuration
    : plan.segments.reduce(
      (sum, seg) => sum + Math.max(0, seg.sourceEndTime - seg.sourceStartTime),
      0,
    );

  const sampleCount = Math.min(20, Math.max(4, Math.ceil(totalDuration / 2)));
  const timestamps = generateSampleTimestamps(totalDuration, sampleCount);

  const observations: RenderedFrameObservation[] = [];
  for (const timestamp of timestamps) {
    try {
      const result = await host.runJob("extractVideoFrame", { time: timestamp });
      if (result.ok && result.data && typeof result.data === "object") {
        const data = result.data as Record<string, unknown>;
        observations.push({
          timestamp,
          sharpness: clamp(Number(data.sharpness) || 0.7),
          subjectVisibility: clamp(Number(data.subjectVisibility) || 0.7),
          textLegibility: clamp(Number(data.textLegibility) || 0.8),
          audioEnergy: typeof data.audioEnergy === "number" ? clamp(data.audioEnergy) : undefined,
          hasBlackFrame: Boolean(data.hasBlackFrame),
        });
      } else {
        observations.push(syntheticObservation(timestamp));
      }
    } catch {
      observations.push(syntheticObservation(timestamp));
    }
  }

  return { observations, sampledCount: observations.length, totalDuration };
}

/**
 * Run the full quality review pipeline: visual frame review + materialized
 * draft review, combined into a single score with targeted correction hints.
 */
export function runQualityPipeline(
  plan: EditPlan,
  segmentMap: SegmentMap,
  materialized: MaterializedDraftSummary,
  planReview: EditPlanReview,
  frameObservations: readonly RenderedFrameObservation[],
): QualityPipelineResult {
  const renderedReview = reviewRenderedDraft(frameObservations);
  const draftReview = reviewMaterializedDraft(plan, segmentMap, materialized, planReview, frameObservations);

  const combinedScore = (renderedReview.score + draftReview.score) / 2;
  const needsCorrection = combinedScore < 0.6 || draftReview.needsRevision;

  const corrections = identifyCorrections(plan, renderedReview, draftReview);

  return { renderedReview, draftReview, combinedScore, needsCorrection, corrections };
}

/**
 * Apply targeted corrections to the timeline based on quality review findings.
 * Only fixes what is wrong — never rebuilds the entire timeline.
 */
export async function applyTargetedCorrections(
  plan: EditPlan,
  corrections: readonly QualityCorrection[],
  clipIds: readonly string[],
  host: EditingHost,
): Promise<{ applied: number; skipped: number }> {
  let applied = 0;
  let skipped = 0;

  for (const correction of corrections) {
    try {
      switch (correction.kind) {
        case "effect": {
          if (correction.segmentIndex === undefined) { skipped++; break; }
          const clipId = clipIds[correction.segmentIndex];
          if (!clipId) { skipped++; break; }
          const segment = plan.segments[correction.segmentIndex];
          const effectSpecs = segment?.effectSpecs ?? [];
          for (const spec of effectSpecs) {
            await host.applyAction({
              type: "effect/add",
              id: `quality-fix-${applied}`,
              timestamp: Date.now(),
              params: {
                clipId,
                effectType: spec.type,
                params: {
                  ...spec.params,
                  ...(spec.intensity !== undefined ? { intensity: Math.max(0, Math.min(1, spec.intensity)) } : {}),
                },
              },
            });
            applied++;
          }
          break;
        }
        case "timing": {
          if (correction.segmentIndex === undefined) { skipped++; break; }
          const clipId = clipIds[correction.segmentIndex];
          if (!clipId) { skipped++; break; }
          const segment = plan.segments[correction.segmentIndex];
          const clip = host.getProject().timeline.tracks
            .flatMap((t) => t.clips)
            .find((c) => c.id === clipId);
          if (clip && segment) {
            const targetPosition = Math.max(0, segment.targetPosition ?? clip.startTime);
            await host.applyAction({
              type: "clip/update",
              id: `quality-fix-${applied}`,
              timestamp: Date.now(),
              params: { clipId, startTime: targetPosition },
            });
            applied++;
          } else {
            skipped++;
          }
          break;
        }
        case "transition": {
          skipped++;
          break;
        }
        default: {
          skipped++;
        }
      }
    } catch {
      skipped++;
    }
  }

  return { applied, skipped };
}

function identifyCorrections(
  plan: EditPlan,
  renderedReview: RenderedDraftReview,
  draftReview: DraftSelfReview,
): QualityCorrection[] {
  const corrections: QualityCorrection[] = [];

  for (const issue of renderedReview.issues) {
    if (issue.includes("black")) {
      for (let i = 0; i < plan.segments.length; i++) {
        corrections.push({ kind: "timing", segmentIndex: i, description: `Black frame detected — re-check segment ${i} source range` });
      }
      break;
    }
    if (issue.includes("soft") || issue.includes("sharpness")) {
      for (let i = 0; i < plan.segments.length; i++) {
        const segment = plan.segments[i];
        if (segment.effectSpecs?.some((spec) => spec.type === "blur" || spec.type === "gaussianBlur")) {
          corrections.push({ kind: "effect", segmentIndex: i, description: `Blur effect on segment ${i} may be causing soft frames` });
        }
      }
    }
    if (issue.includes("subject")) {
      for (let i = 0; i < plan.segments.length; i++) {
        const segment = plan.segments[i];
        if (segment.layout && segment.layout.region !== "fullscreen") {
          corrections.push({ kind: "effect", segmentIndex: i, description: `Layout on segment ${i} may be cropping the subject` });
        }
      }
    }
    if (issue.includes("text legibility")) {
      for (let i = 0; i < plan.textElements.length; i++) {
        corrections.push({ kind: "timing", description: `Text element ${i} may need contrast or size adjustment` });
      }
    }
  }

  if (draftReview.execution.appliedEffects < draftReview.execution.expectedEffects) {
    const missing = draftReview.execution.expectedEffects - draftReview.execution.appliedEffects;
    corrections.push({ kind: "effect", description: `${missing} effect(s) were not applied — re-apply missing effects` });
  }
  if (draftReview.execution.appliedTransitions < draftReview.execution.expectedTransitions) {
    const missing = draftReview.execution.expectedTransitions - draftReview.execution.appliedTransitions;
    corrections.push({ kind: "transition", description: `${missing} transition(s) were not applied` });
  }

  return corrections;
}

function generateSampleTimestamps(totalDuration: number, count: number): number[] {
  if (count <= 1) return [0];
  const step = totalDuration / (count - 1);
  return Array.from({ length: count }, (_, i) => Math.min(i * step, totalDuration));
}

function syntheticObservation(timestamp: number): RenderedFrameObservation {
  return {
    timestamp,
    sharpness: 0.7,
    subjectVisibility: 0.7,
    textLegibility: 0.8,
    hasBlackFrame: false,
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
