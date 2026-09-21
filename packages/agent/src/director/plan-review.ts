import type {
  EditPlan,
  Genre,
  SegmentMap,
  StyleProfile,
  StyleProfileComparison,
  StyleProfileTarget,
  RenderedDraftReview,
  RenderedFrameObservation,
} from "@kove-advanced/creation-schema";
import { compareStyleProfile, reviewRenderedDraft } from "@kove-advanced/creation-schema";

export interface EditPlanReview extends StyleProfileComparison {
  readonly profile: StyleProfile;
  readonly target: StyleProfileTarget;
  readonly needsRevision: boolean;
  readonly rendered?: RenderedDraftReview;
}

export interface MaterializedDraftSummary {
  readonly clipIds: readonly string[];
  readonly textIds: readonly string[];
  readonly effectCount: number;
  readonly transitionCount: number;
  readonly audioCount: number;
}

export interface DraftSelfReview {
  readonly score: number;
  readonly issues: readonly string[];
  readonly lowConfidenceSegments: readonly string[];
  readonly execution: {
    readonly expectedEffects: number;
    readonly appliedEffects: number;
    readonly expectedTransitions: number;
    readonly appliedTransitions: number;
    readonly expectedTextElements: number;
    readonly appliedTextElements: number;
  };
  readonly needsRevision: boolean;
}

export function reviewMaterializedDraft(
  plan: EditPlan,
  segmentMap: SegmentMap,
  materialized: MaterializedDraftSummary,
  styleReview: EditPlanReview,
  renderedObservations?: readonly RenderedFrameObservation[],
): DraftSelfReview {
  const expectedEffects = plan.effects.length
    + plan.segments.reduce((sum, segment) => sum + segment.effects.length + (segment.effectSpecs?.length ?? 0), 0);
  const expectedTransitions = plan.transitions.length;
  const expectedTextElements = plan.textElements.length;
  const issues: string[] = [];
  let score = styleReview.score;
  const rendered = renderedObservations ? reviewRenderedDraft(renderedObservations) : undefined;
  if (rendered) {
    score = (score + rendered.score) / 2;
    issues.push(...rendered.issues);
  }

  if (materialized.effectCount < expectedEffects) {
    issues.push(`Only ${materialized.effectCount} of ${expectedEffects} planned effects were applied.`);
    score -= 0.2;
  }
  if (materialized.transitionCount < expectedTransitions) {
    issues.push(`Only ${materialized.transitionCount} of ${expectedTransitions} planned transitions were applied.`);
    score -= 0.2;
  }
  if (materialized.textIds.length < expectedTextElements) {
    issues.push(`Only ${materialized.textIds.length} of ${expectedTextElements} planned text elements were applied.`);
    score -= 0.1;
  }

  const lowConfidenceSegments = segmentMap.videos.flatMap((video) => video.segments
    .filter((segment) => segment.confidence < 0.5)
    .map((segment) => `${video.videoId}:${segment.id}`));
  if (lowConfidenceSegments.length > 0) {
    issues.push(`${lowConfidenceSegments.length} source segment(s) have low analysis confidence and should be spot-checked.`);
    score -= 0.1;
  }

  const normalizedScore = Math.max(0, Math.min(1, score));
  return {
    score: normalizedScore,
    issues,
    lowConfidenceSegments,
    execution: {
      expectedEffects,
      appliedEffects: materialized.effectCount,
      expectedTransitions,
      appliedTransitions: materialized.transitionCount,
      expectedTextElements,
      appliedTextElements: materialized.textIds.length,
    },
    needsRevision: normalizedScore < 0.6,
  };
}

export function reviewEditPlan(
  plan: EditPlan,
  genre?: Genre,
  referenceAnalysis?: unknown,
): EditPlanReview {
  const profile = measureEditPlanStyle(plan);
  const target = mergeStyleTargets(genreTarget(genre), referenceTarget(referenceAnalysis));
  const comparison = compareStyleProfile(profile, target);

  return {
    ...comparison,
    profile,
    target,
    needsRevision: comparison.score < 0.6,
  };
}

export function measureEditPlanStyle(plan: EditPlan): StyleProfile {
  const targetDuration = plan.metadata.targetDuration > 0
    ? plan.metadata.targetDuration
    : plan.segments.reduce(
      (sum, segment) => sum + Math.max(0, segment.sourceEndTime - segment.sourceStartTime),
      0,
    );
  const shotDurations = plan.segments
    .map((segment) => Math.max(0, segment.sourceEndTime - segment.sourceStartTime))
    .sort((left, right) => left - right);
  const transitionPalette = [...new Set(plan.transitions.map((transition) => transition.type))];
  const effectPalette = [...new Set([
    ...plan.effects.map((effect) => effect.type),
    ...plan.segments.flatMap((segment) => segment.effects),
  ])];
  const cutStyle = transitionPalette.length === 0
    ? "hard"
    : transitionPalette.every((type) => ["crossfade", "dipToBlack", "fade"].includes(type))
      ? "soft"
      : "mixed";

  return {
    version: "1.0.0",
    pacing: plan.metadata.pacing === "medium" ? "moderate" : plan.metadata.pacing,
    cutsPerMinute: targetDuration > 0 ? plan.segments.length / (targetDuration / 60) : 0,
    medianShotDuration: shotDurations.length > 0
      ? shotDurations[Math.floor(shotDurations.length / 2)]!
      : 0,
    cutOnBeatRatio: null,
    effectDensity: targetDuration > 0 ? effectPalette.length / (targetDuration / 60) : 0,
    transitionDensity: targetDuration > 0 ? plan.transitions.length / (targetDuration / 60) : 0,
    textOverlayDensity: targetDuration > 0 ? plan.textElements.length / (targetDuration / 60) : 0,
    shotTypeDistribution: {},
    cutStyle,
    effectPalette,
    transitionPalette,
    detectedBpm: null,
    dialogueRatio: 0,
    musicRatio: plan.audioDecisions.some((decision) => decision.type === "music") ? 1 : 0,
    confidence: 1,
  };
}

function genreTarget(genre?: Genre): StyleProfileTarget | undefined {
  if (!genre) return undefined;
  return genre.styleProfile ?? {
    pacing: genre.pacing ?? genre.rules.pacing,
    cutsPerMinute: genre.cutsPerMinuteTarget,
    cutStyle: genre.rules.cutStyle,
    effectPalette: genre.effectPalette ?? genre.rules.effectPalette,
    transitionPalette: genre.transitionPalette ?? genre.rules.transitionPreference,
  };
}

function referenceTarget(value: unknown): StyleProfileTarget | undefined {
  const root = asRecord(value);
  const videos = Array.isArray(root?.videos) ? root.videos : [];
  const referenceVideo = videos.find((video) => asRecord(video)?.role === "reference") ?? videos[0];
  const profile = asRecord(asRecord(referenceVideo)?.styleProfile);
  if (!profile) return undefined;

  return {
    pacing: asPacing(profile.pacing),
    cutsPerMinute: asRange(profile.cutsPerMinute),
    cutStyle: asCutStyle(profile.cutStyle),
    effectPalette: asStringArray(profile.effectPalette),
    transitionPalette: asStringArray(profile.transitionPalette),
  };
}

function mergeStyleTargets(
  base: StyleProfileTarget | undefined,
  override: StyleProfileTarget | undefined,
): StyleProfileTarget {
  return {
    ...base,
    ...override,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asStringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value as string[]
    : undefined;
}

function asRange(value: unknown): readonly [number, number] | undefined {
  return Array.isArray(value) && value.length === 2 && value.every((item) => typeof item === "number")
    ? [value[0] as number, value[1] as number]
    : undefined;
}

function asPacing(value: unknown): StyleProfileTarget["pacing"] {
  return value === "fast" || value === "moderate" || value === "medium" || value === "slow" || value === "unknown"
    ? value
    : undefined;
}

function asCutStyle(value: unknown): StyleProfileTarget["cutStyle"] {
  return value === "hard" || value === "soft" || value === "mixed" || value === "unknown"
    ? value
    : undefined;
}