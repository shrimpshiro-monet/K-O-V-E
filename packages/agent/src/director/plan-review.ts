import type {
  EditDensityReview,
  EditDensityTarget,
  EditPlan,
  Genre,
  SegmentMap,
  StyleProfile,
  StyleProfileComparison,
  StyleProfileTarget,
  RenderedDraftReview,
  RenderedFrameObservation,
} from "@kove-advanced/creation-schema";
import {
  canonicalizeTargetEffects,
  canonicalizeTargetTransitions,
  compareEditDensity,
  compareStyleProfile,
  formatDensityBrief,
  measureEditDensity,
  resolveDensityTarget,
  reviewRenderedDraft,
} from "@kove-advanced/creation-schema";

export interface EditPlanReview extends StyleProfileComparison {
  readonly profile: StyleProfile;
  readonly target: StyleProfileTarget;
  readonly needsRevision: boolean;
  readonly rendered?: RenderedDraftReview;
  /**
   * How populated the timeline is (shot rate, treatments per minute, camera
   * motion, text/SFX layering, escalation). Style says "right palette"; density
   * says "someone actually edited this". Both gate the revision pass.
   */
  readonly density: EditDensityReview;
  /** Human/LLM-readable list of density problems, ordered by severity. */
  readonly revisionBrief: string;
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
  segmentMap?: SegmentMap,
): EditPlanReview {
  const profile = measureEditPlanStyle(plan);
  const target = mergeStyleTargets(genreTarget(genre), referenceTarget(referenceAnalysis));
  const comparison = compareStyleProfile(profile, target);
  const density = compareEditDensity(
    measureEditDensity(plan, segmentMap),
    densityTarget(genre, plan.metadata.pacing),
  );

  // Density is a gate, not a suggestion: a plan can match the genre palette and
  // still be eight splices. Both scores must clear their bar before execution.
  const needsRevision = comparison.score < 0.6 || density.score < 0.6;

  return {
    ...comparison,
    profile,
    target,
    density,
    needsRevision,
    revisionBrief: buildRevisionBrief(comparison.score, comparison.deviations, density),
  };
}

/**
 * Density target for a genre: the pacing preset (fast/medium/slow) with the
 * genre's own overrides applied on top. A genre with no explicit pacing falls
 * back to its rules.
 */
export function densityTarget(
  genre?: Genre,
  fallbackPacing: Genre["pacing"] = "medium",
): EditDensityTarget {
  // With no genre selected, the plan's own declared pacing is the fairest
  // baseline — a plan that calls itself "fast" is judged against the fast
  // floor instead of the medium one.
  const pacing = genre?.pacing ?? genre?.rules.pacing ?? fallbackPacing;
  return resolveDensityTarget(pacing, genre?.densityTarget);
}

/**
 * One brief for one bounded revision attempt. The style deviations are
 * phrased as measurable gaps; the density section lists concrete additions.
 * Keeping both in a single message is what makes the second plan a real edit
 * instead of a differently-broken first draft.
 */
export function buildRevisionBrief(
  styleScore: number,
  deviations: readonly string[],
  density: EditDensityReview,
): string {
  const lines: string[] = [];
  if (styleScore < 0.6) {
    lines.push(
      `Style match is ${styleScore.toFixed(2)} against the genre target. Deviations: ` +
      `${deviations.join("; ") || "bring the measurable style profile closer to target"}.`,
    );
  }
  lines.push(formatDensityBrief(density));
  return lines.join("\n\n");
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
  // Normalize palettes to what the renderer will actually draw, so legacy
  // names ("hardCut", "warmth", "zoom-punch") measure the same way the style
  // target does instead of permanently tanking the score.
  const rawTransitionTypes = [...new Set(plan.transitions.map((transition) => transition.type))];
  const transitionPalette = canonicalizeTargetTransitions(rawTransitionTypes);
  const effectPalette = canonicalizeTargetEffects([
    ...new Set([
      ...plan.effects.map((effect) => effect.type),
      ...plan.segments.flatMap((segment) => segment.effects),
    ]),
  ]);
  // cutStyle uses the RAW names: hardCut entries still mean "hard cut" even
  // though they are not rendered as transitions.
  const cutStyle = rawTransitionTypes.length === 0
    // No transition entries means every junction is a cut — that IS a
    // hard-cut edit (plans no longer need to emit hardCut entries).
    ? plan.segments.length > 1 ? "hard" : "unknown"
    : rawTransitionTypes.every((type) => ["crossfade", "dipToBlack", "dipToWhite", "fade"].includes(type))
      ? "soft"
      : rawTransitionTypes.every((type) => ["hardCut", "cut", "flash", "glitch", "whipPan"].includes(type))
        ? "hard"
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
  const target = genre.styleProfile ?? {
    pacing: genre.pacing ?? genre.rules.pacing,
    cutsPerMinute: genre.cutsPerMinuteTarget,
    cutStyle: genre.rules.cutStyle,
    effectPalette: genre.effectPalette ?? genre.rules.effectPalette,
    transitionPalette: genre.transitionPalette ?? genre.rules.transitionPreference,
  };
  // Canonicalize target palettes with the same renderer-backed vocabulary the
  // plan is validated against, so a genre suggesting "hardCut"/"warmth" can be
  // matched by a plan that correctly emits no entry / "temperature".
  return {
    ...target,
    effectPalette: target.effectPalette
      ? canonicalizeTargetEffects(target.effectPalette)
      : target.effectPalette,
    transitionPalette: target.transitionPalette
      ? canonicalizeTargetTransitions(target.transitionPalette)
      : target.transitionPalette,
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