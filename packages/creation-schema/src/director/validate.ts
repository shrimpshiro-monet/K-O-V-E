import type { EditPlan, EditPlanLayout, PlannedSegment, PlannedSpeedRamp } from "./edit-plan";
import type { SegmentMap, VideoSegmentMap } from "./segment-map";
import { normalizeEffectType, normalizeTransitionType, isColorGradeType, getMisplacedFeatureHint } from "./effect-types";

export interface DirectorValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly severity: "error" | "warning";
  readonly path?: string;
}

function issue(
  severity: DirectorValidationIssue["severity"],
  code: string,
  message: string,
  path?: string,
): DirectorValidationIssue {
  return { severity, code, message, ...(path ? { path } : {}) };
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) dupes.add(value);
    seen.add(value);
  }
  return [...dupes];
}

export function validateSegmentMap(
  segmentMap: SegmentMap,
): readonly DirectorValidationIssue[] {
  const issues: DirectorValidationIssue[] = [];

  if (!segmentMap || !segmentMap.videos || !Array.isArray(segmentMap.videos)) {
    issues.push(
      issue("error", "invalid_structure", "SegmentMap is missing or has no videos array."),
    );
    return issues;
  }

  if (segmentMap.videos.length === 0) {
    issues.push(
      issue("error", "no_videos", "SegmentMap contains no video analyses."),
    );
    return issues;
  }

  for (const video of segmentMap.videos) {
    if (video.segments.length === 0) {
      issues.push(
        issue(
          "warning",
          "no_segments",
          `Video "${video.videoId}" has no segments.`,
          `videos.${video.videoId}.segments`,
        ),
      );
    }

    for (const dupe of duplicates(video.segments.map((s: { id: string }) => s.id))) {
      issues.push(
        issue(
          "error",
          "duplicate_segment_id",
          `Duplicate segment id "${dupe}" in video "${video.videoId}".`,
          `videos.${video.videoId}.segments`,
        ),
      );
    }

    let lastEnd = 0;
    for (const segment of video.segments) {
      // A tiny epsilon lets adjacent segments with 1-frame precision issues
      // (e.g. 5.033333 vs 5.033334) pass without a false overlap warning.
      // Without this, real SegmentMaps from the vision worker produced
      // warning spam that drowned out the actionable issues.
      if (segment.startTime < lastEnd - 1e-3) {
        issues.push(
          issue(
            "warning",
            "overlapping_segments",
            `Segment "${segment.id}" overlaps with previous segment in video "${video.videoId}".`,
            `videos.${video.videoId}.segments.${segment.id}`,
          ),
        );
      }
      if (segment.endTime <= segment.startTime) {
        issues.push(
          issue(
            "error",
            "bad_segment_duration",
            `Segment "${segment.id}" has zero or negative duration.`,
            `videos.${video.videoId}.segments.${segment.id}`,
          ),
        );
      }
      if (segment.confidence < 0 || segment.confidence > 1) {
        issues.push(
          issue(
            "error",
            "bad_confidence",
            `Segment "${segment.id}" confidence ${segment.confidence} is outside [0, 1].`,
            `videos.${video.videoId}.segments.${segment.id}`,
          ),
        );
      }
      lastEnd = segment.endTime;
    }
  }

  return issues;
}

export function validateEditPlan(
  plan: EditPlan,
  segmentMap: SegmentMap,
): readonly DirectorValidationIssue[] {
  const issues: DirectorValidationIssue[] = [];

  if (plan.segments.length === 0) {
    issues.push(issue("warning", "empty_plan", "EditPlan has no segments."));
  }

  const videoIds = new Set(
    segmentMap.videos.map((v: VideoSegmentMap) => v.videoId),
  );

  for (let i = 0; i < plan.segments.length; i++) {
    const seg = plan.segments[i] as PlannedSegment;
    if (!videoIds.has(seg.sourceVideoId)) {
      issues.push(
        issue(
          "error",
          "unknown_source_video",
          `Segment ${i} references unknown video "${seg.sourceVideoId}".`,
          `segments.${i}.sourceVideoId`,
        ),
      );
    }
    if (seg.sourceEndTime <= seg.sourceStartTime) {
      issues.push(
        issue(
          "error",
          "bad_source_range",
          `Segment ${i} has zero or negative source duration.`,
          `segments.${i}`,
        ),
      );
    }
    if (seg.targetPosition !== undefined && seg.targetPosition < 0) {
      issues.push(
        issue(
          "error",
          "negative_position",
          `Segment ${i} has negative target position.`,
          `segments.${i}.targetPosition`,
        ),
      );
    }
    validateLayout(seg.layout, i, issues);
    validateSpeedRamp(seg.speedRamp, seg.sourceEndTime - seg.sourceStartTime, i, issues);
    seg.effectSpecs?.forEach((effect, effectIndex) => {
      if (typeof effect.type !== "string" || !effect.type.trim()) {
        issues.push(issue("error", "empty_effect_type", `Segment ${i} effect ${effectIndex} has no type.`, `segments.${i}.effectSpecs.${effectIndex}.type`));
      } else if (!normalizeEffectType(effect.type) && !isColorGradeType(effect.type)) {
        pushUnknownEffect(effect.type, `segments[${i}].effectSpecs[${effectIndex}]`, issues);
      }
      validateColorGradeParams(effect, `segments[${i}].effectSpecs[${effectIndex}]`, issues);
      if (effect.intensity !== undefined && (!Number.isFinite(effect.intensity) || effect.intensity < 0 || effect.intensity > 1)) {
        issues.push(issue("warning", "effect_intensity_out_of_range", `Segment ${i} effect ${effectIndex} intensity out of [0,1] — will be clamped.`, `segments.${i}.effectSpecs.${effectIndex}.intensity`));
      }
      if (effect.startOffset !== undefined && (!Number.isFinite(effect.startOffset) || effect.startOffset < 0)) {
        issues.push(issue("warning", "effect_offset_out_of_range", `Segment ${i} effect ${effectIndex} startOffset negative — will be clamped to 0.`, `segments.${i}.effectSpecs.${effectIndex}.startOffset`));
      }
      if (effect.duration !== undefined && (!Number.isFinite(effect.duration) || effect.duration <= 0)) {
        issues.push(issue("warning", "effect_duration_invalid", `Segment ${i} effect ${effectIndex} duration non-positive — will be clamped to 0.01.`, `segments.${i}.effectSpecs.${effectIndex}.duration`));
      }
      if (effect.easing !== undefined && !effect.easing.trim()) {
        issues.push(issue("error", "effect_easing_invalid", `Segment ${i} effect ${effectIndex} easing cannot be empty.`, `segments.${i}.effectSpecs.${effectIndex}.easing`));
      }
    });
  }

  for (let i = 0; i < plan.segments.length; i += 1) {
    const layout = plan.segments[i]?.layout;
    if (!layout || layout.region === "fullscreen" || layout.region === "custom") continue;
    const hasPartner = plan.segments.some((candidate, candidateIndex) => {
      if (candidateIndex === i || candidate.trackIndex === plan.segments[i]?.trackIndex) return false;
      if (!candidate.layout) return layout.region === "pip-corner";
      if (layout.region === "pip-corner") {
        return candidate.layout.region === "fullscreen" || candidate.layout.region === "pip-corner";
      }
      const splitPair = new Set([layout.region, candidate.layout.region]);
      return (
        (splitPair.has("split-left") && splitPair.has("split-right")) ||
        (splitPair.has("split-top") && splitPair.has("split-bottom"))
      ) && rangesOverlap(plan.segments[i] as PlannedSegment, candidate);
    });
    if (!hasPartner) {
      issues.push(issue(
        "warning",
        layout.region === "pip-corner" ? "orphan_pip_layout" : "orphan_split_layout",
        `Segment ${i} uses ${layout.region} without an overlapping visual partner.`,
        `segments.${i}.layout`,
      ));
    }
  }

  for (let i = 0; i < (plan.motionMoments?.length ?? 0); i += 1) {
    const moment = plan.motionMoments?.[i];
    if (!moment) continue;
    if (moment.segmentIndex !== undefined && (moment.segmentIndex < 0 || moment.segmentIndex >= plan.segments.length || !Number.isInteger(moment.segmentIndex))) {
      issues.push(issue("error", "invalid_motion_segment", `Motion moment ${i} references an invalid segment index.`, `motionMoments.${i}.segmentIndex`));
    }
    if (moment.atTime !== undefined && (!Number.isFinite(moment.atTime) || moment.atTime < 0)) {
      issues.push(issue("error", "invalid_motion_time", `Motion moment ${i} has an invalid start time.`, `motionMoments.${i}.atTime`));
    }
    if (moment.duration !== undefined && (!Number.isFinite(moment.duration) || moment.duration <= 0)) {
      issues.push(issue("error", "invalid_motion_duration", `Motion moment ${i} has an invalid duration.`, `motionMoments.${i}.duration`));
    }
  }

  // Validate TOP-LEVEL plan.effects. These are the per-segment effects the
  // director targets via `targetSegmentIndex` — the most common shape the
  // LLM actually produces. Nothing validated them before, so an invented
  // type like "zoom-punch" or an alias that needs normalization like
  // "warmth" flowed straight through to materialize and became a silent
  // no-op (or a hard error with no clear attribution).
  for (let i = 0; i < plan.effects.length; i++) {
    const effect = plan.effects[i];
    if (!effect) continue;
    if (typeof effect.type !== "string" || !effect.type.trim()) {
      issues.push(
        issue(
          "error",
          "empty_effect_type",
          `plan.effects[${i}] has no type.`,
          `effects.${i}.type`,
        ),
      );
    } else if (!normalizeEffectType(effect.type) && !isColorGradeType(effect.type)) {
      pushUnknownEffect(effect.type, `plan.effects[${i}]`, issues);
    }
    // Color grade effects route to clip/setColorGrading, not effect/add.
    // Empty params means the grade does nothing — catch it early.
    validateColorGradeParams(effect, `plan.effects[${i}]`, issues);
    if (
      effect.targetSegmentIndex !== undefined &&
      (!Number.isInteger(effect.targetSegmentIndex) ||
        effect.targetSegmentIndex < 0 ||
        effect.targetSegmentIndex >= plan.segments.length)
    ) {
      issues.push(
        issue(
          "error",
          "invalid_effect_segment",
          `plan.effects[${i}] targetSegmentIndex ${effect.targetSegmentIndex} is out of range.`,
          `effects.${i}.targetSegmentIndex`,
        ),
      );
    }
    if (
      effect.intensity !== undefined &&
      (!Number.isFinite(effect.intensity) ||
        effect.intensity < 0 ||
        effect.intensity > 1)
    ) {
      issues.push(
        issue(
          "warning",
          "effect_intensity_out_of_range",
          `plan.effects[${i}] intensity out of [0,1] — will be clamped.`,
          `effects.${i}.intensity`,
        ),
      );
    }
    if (
      effect.startOffset !== undefined &&
      (!Number.isFinite(effect.startOffset) || effect.startOffset < 0)
    ) {
      issues.push(
        issue(
          "warning",
          "effect_offset_out_of_range",
          `plan.effects[${i}] startOffset negative — will be clamped to 0.`,
          `effects.${i}.startOffset`,
        ),
      );
    }
    if (
      effect.duration !== undefined &&
      (!Number.isFinite(effect.duration) || effect.duration <= 0)
    ) {
      issues.push(
        issue(
          "warning",
          "effect_duration_invalid",
          `plan.effects[${i}] duration non-positive — will be clamped to 0.01.`,
          `effects.${i}.duration`,
        ),
      );
    }
    if (effect.easing !== undefined && !effect.easing.trim()) {
      issues.push(
        issue(
          "error",
          "effect_easing_invalid",
          `plan.effects[${i}] easing cannot be empty.`,
          `effects.${i}.easing`,
        ),
      );
    }
  }

  // Validate transition types against the real registry
  for (let i = 0; i < plan.transitions.length; i++) {
    const transition = plan.transitions[i];
    if (!transition) continue;
    if (typeof transition.type !== "string" || !transition.type.trim()) {
      issues.push(issue("error", "empty_transition_type", `Transition ${i} has no type.`, `transitions.${i}.type`));
    } else if (!normalizeTransitionType(transition.type)) {
      issues.push(issue("error", "unknown_transition_type", `Transition ${i} type "${transition.type}" has no matching render implementation and will silently no-op.`, `transitions.${i}.type`));
    }
    if (!Number.isFinite(transition.duration) || transition.duration <= 0) {
      issues.push(issue("error", "invalid_transition_duration", `Transition ${i} has non-positive duration.`, `transitions.${i}.duration`));
    }
  }

  // Validate that effect types on segments (string[] effects array) are real
  for (let i = 0; i < plan.segments.length; i++) {
    const seg = plan.segments[i] as PlannedSegment;
    for (let j = 0; j < seg.effects.length; j++) {
      const effectType = seg.effects[j];
      if (typeof effectType !== "string" || !effectType.trim()) {
        issues.push(issue("error", "empty_effect_type", `Segment ${i} effects[${j}] has no type.`, `segments.${i}.effects.${j}`));
      } else if (!normalizeEffectType(effectType) && !isColorGradeType(effectType)) {
        pushUnknownEffect(effectType, `segments[${i}].effects[${j}]`, issues);
      }
      // colorGrade in the string effects array gets empty params by default,
      // which means it silently does nothing — warn so the LLM uses effectSpecs instead.
      if (isColorGradeType(effectType)) {
        issues.push(
          issue(
            "warning",
            "implicit_color_grade_params",
            `Segment ${i} effects[${j}] type "${effectType}" will receive empty params — use effectSpecs with explicit params instead.`,
            `segments.${i}.effects.${j}`,
          ),
        );
      }
    }
  }

  for (let i = 0; i < plan.audioDecisions.length; i++) {
    const decision = plan.audioDecisions[i];
    if (!decision) continue;
    if (
      (decision.type === "music" || decision.type === "sfx") &&
      (!decision.sourceVideoId || !String(decision.sourceVideoId).trim())
    ) {
      issues.push(issue(
        "error",
        "audio_decision_missing_source",
        `audioDecisions[${i}] has type "${decision.type}" but no sourceVideoId — it will be silently dropped. Set sourceVideoId to a media library ID with audio.`,
        `audioDecisions.${i}.sourceVideoId`,
      ));
    }
    if (!Number.isFinite(decision.startTime) || decision.startTime < 0) {
      issues.push(issue(
        "error",
        "audio_decision_bad_start",
        `audioDecisions[${i}] has invalid startTime (${decision.startTime}).`,
        `audioDecisions.${i}.startTime`,
      ));
    }
    if (!Number.isFinite(decision.duration) || decision.duration <= 0) {
      issues.push(issue(
        "error",
        "audio_decision_bad_duration",
        `audioDecisions[${i}] has invalid duration (${decision.duration}).`,
        `audioDecisions.${i}.duration`,
      ));
    }
  }

  if (plan.metadata.targetDuration <= 0) {
    issues.push(
      issue("error", "bad_target_duration", "Target duration must be positive.", "metadata.targetDuration"),
    );
  }

  return issues;
}

/**
 * Validate that a color-grade effect carries non-empty params.
 * colorGrade types route to clip/setColorGrading (not effect/add), so
 * empty params means the grade silently does nothing.
 */
function validateColorGradeParams(
  effect: { type?: unknown; params?: unknown },
  pathPrefix: string,
  issues: DirectorValidationIssue[],
): void {
  if (!isColorGradeType(effect.type as string | undefined)) return;
  const params = effect.params as Record<string, unknown> | undefined;
  if (!params || Object.keys(params).length === 0) {
    issues.push(
      issue(
        "error",
        "empty_color_grade_params",
        `${pathPrefix} is a colorGrade with no params — it will do nothing.`,
        `${pathPrefix}.params`,
      ),
    );
  }
}

/**
 * Emit an unknown-effect issue. If the type is a known misplaced feature
 * (speed ramp, transform, transition), emit "misplaced_feature" with an
 * actionable message instead — the LLM needs to know WHERE the thing belongs.
 */
function pushUnknownEffect(
  rawType: string,
  pathPrefix: string,
  issues: DirectorValidationIssue[],
): void {
  const hint = getMisplacedFeatureHint(rawType);
  if (hint) {
    issues.push(issue("error", "misplaced_feature",
      `${pathPrefix}: ${hint}`, `${pathPrefix}.type`));
    return;
  }
  issues.push(issue("error", "unknown_effect_type",
    `${pathPrefix} type "${rawType}" has no matching render implementation. Valid types: brightness, contrast, saturation, hue, blur, sharpen, vignette, grain, temperature, tint, tonal, shadow, glow, motion-blur, radial-blur, chromatic-aberration, colorGrade.`,
    `${pathPrefix}.type`));
}

function rangesOverlap(left: PlannedSegment, right: PlannedSegment): boolean {
  const leftStart = left.targetPosition ?? 0;
  const rightStart = right.targetPosition ?? 0;
  const leftEnd = leftStart + Math.max(0, left.sourceEndTime - left.sourceStartTime);
  const rightEnd = rightStart + Math.max(0, right.sourceEndTime - right.sourceStartTime);
  return leftStart < rightEnd && rightStart < leftEnd;
}

function validateLayout(
  layout: EditPlanLayout | undefined,
  segmentIndex: number,
  issues: DirectorValidationIssue[],
): void {
  if (!layout || layout.region !== "custom") return;
  const rect = layout.customRect;
  if (!rect || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 || rect.x + rect.width > 1 || rect.y + rect.height > 1) {
    issues.push(issue("error", "invalid_layout_rect", `Segment ${segmentIndex} has a custom layout rectangle outside the normalized frame.`, `segments.${segmentIndex}.layout.customRect`));
  }
}

function validateSpeedRamp(
  ramp: PlannedSpeedRamp | undefined,
  sourceDuration: number,
  segmentIndex: number,
  issues: DirectorValidationIssue[],
): void {
  if (!ramp) return;
  if (ramp.keyframes.length < 2) {
    issues.push(issue("error", "insufficient_speed_keyframes", `Segment ${segmentIndex} speed ramps need at least two keyframes.`, `segments.${segmentIndex}.speedRamp.keyframes`));
  }
  let previousTime = -Infinity;
  ramp.keyframes.forEach((keyframe, keyframeIndex) => {
    if (!Number.isFinite(keyframe.time) || keyframe.time < 0 || keyframe.time > sourceDuration) {
      issues.push(issue("error", "speed_keyframe_out_of_range", `Segment ${segmentIndex} speed keyframe ${keyframeIndex} is outside the source range.`, `segments.${segmentIndex}.speedRamp.keyframes.${keyframeIndex}.time`));
    }
    if (keyframe.time < previousTime) {
      issues.push(issue("error", "speed_keyframes_unsorted", `Segment ${segmentIndex} speed keyframes must be sorted by time.`, `segments.${segmentIndex}.speedRamp.keyframes`));
    }
    if (!Number.isFinite(keyframe.speed) || keyframe.speed < 0.1 || keyframe.speed > 20) {
      issues.push(issue("error", "speed_out_of_range", `Segment ${segmentIndex} speed must be between 0.1x and 20x.`, `segments.${segmentIndex}.speedRamp.keyframes.${keyframeIndex}.speed`));
    }
    previousTime = keyframe.time;
  });
  ramp.freezeFrames?.forEach((freeze, freezeIndex) => {
    if (!Number.isFinite(freeze.sourceTime) || !Number.isFinite(freeze.startTime) || !Number.isFinite(freeze.duration) || freeze.duration <= 0) {
      issues.push(issue("error", "invalid_freeze_frame", `Segment ${segmentIndex} freeze frame ${freezeIndex} has non-finite or non-positive values.`, `segments.${segmentIndex}.speedRamp.freezeFrames.${freezeIndex}`));
    } else if (freeze.sourceTime < 0 || freeze.sourceTime > sourceDuration || freeze.startTime < 0) {
      // Treat out-of-range freeze frames as warnings, not errors — the
      // materializer already clamps values so they won't crash the timeline.
      issues.push(issue("warning", "clamp_freeze_frame", `Segment ${segmentIndex} freeze frame ${freezeIndex} sourceTime/startTime out of range — will be clamped.`, `segments.${segmentIndex}.speedRamp.freezeFrames.${freezeIndex}`));
    }
  });
}

export function normalizeEditPlan(
  plan: EditPlan,
  segmentMap: SegmentMap,
): EditPlan {
  const videosById = new Map(segmentMap.videos.map((video) => [video.videoId, video]));
  const segments = plan.segments.map((segment) => {
    const video = videosById.get(segment.sourceVideoId);
    const duration = video && Number.isFinite(video.duration) && video.duration > 0
      ? video.duration
      : undefined;
    let start = Number.isFinite(segment.sourceStartTime)
      ? Math.max(0, segment.sourceStartTime)
      : 0;
    let end = Number.isFinite(segment.sourceEndTime)
      ? Math.max(0, segment.sourceEndTime)
      : 0;

    if (duration !== undefined) {
      start = Math.min(start, duration);
      end = Math.min(end, duration);
    }
    if (end <= start) {
      start = 0;
      end = duration ?? 1;
    }

    // Normalize effect types on this segment
    const normalizedEffectSpecs = segment.effectSpecs?.map((spec) => {
      const normalized = normalizeEffectType(spec.type);
      return normalized ? { ...spec, type: normalized } : spec;
    });
    const normalizedEffects = segment.effects.map((type) => {
      const normalized = normalizeEffectType(type);
      return normalized ?? type;
    });

    return {
      ...segment,
      sourceStartTime: start,
      sourceEndTime: end,
      ...(normalizedEffectSpecs ? { effectSpecs: normalizedEffectSpecs } : {}),
      effects: normalizedEffects,
    };
  });
  // Normalize top-level plan.effects the same way we normalize per-segment
  // effects. Without this, an alias like "warmth" survives normalization
  // and — even though validation now catches unknown types — the plan gets
  // rejected when it could have been transparently mapped to the real
  // implementation ("temperature"). Alias normalizing is what makes
  // director-authored plans from older prompts still execute.
  const effects = plan.effects.map((effect) => {
    const normalizedType = normalizeEffectType(effect.type);
    return normalizedType ? { ...effect, type: normalizedType } : effect;
  });

  const transitions = plan.transitions.map((transition) => {
    const previous = segments[transition.afterSegmentIndex];
    const next = segments[transition.afterSegmentIndex + 1];
    // Cap transition duration at half the shorter adjacent segment to
    // prevent crossfades longer than the source clips (causes frame-hold glitches)
    const maxDuration = previous && next
      ? Math.min(previous.sourceEndTime - previous.sourceStartTime, next.sourceEndTime - next.sourceStartTime) * 0.5
      : 0.25;
    const duration = Number.isFinite(transition.duration) && transition.duration > 0
      ? Math.min(transition.duration, maxDuration)
      : Math.min(0.25, maxDuration);

    // Normalize transition type
    const normalizedType = normalizeTransitionType(transition.type);

    return { ...transition, duration, type: normalizedType ?? transition.type };
  });

  return {
    ...plan,
    segments,
    effects,
    transitions,
  };
}

export function summarizeSegmentMap(segmentMap: SegmentMap): string {
  if (!segmentMap || !segmentMap.videos || !Array.isArray(segmentMap.videos)) {
    return "SegmentMap unavailable";
  }
  const totalSegments = segmentMap.videos.reduce(
    (sum, v) => sum + (v.segments?.length ?? 0),
    0,
  );
  const totalDuration = segmentMap.videos.reduce(
    (sum, v) => sum + (Number.isFinite(v.duration) ? v.duration : 0),
    0,
  );
  return `${segmentMap.videos.length} video(s), ${totalSegments} segment(s), ${totalDuration.toFixed(1)}s total`;
}

export function summarizeEditPlan(plan: EditPlan): string {
  return `${plan.segments.length} segment(s), ${plan.textElements.length} text element(s), ${plan.effects.length} effect(s), ${plan.transitions.length} transition(s), target ${plan.metadata.targetDuration}s`;
}
