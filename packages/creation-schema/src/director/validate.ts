import type { EditPlan, EditPlanLayout, PlannedSegment, PlannedSpeedRamp } from "./edit-plan";
import type { SegmentMap, VideoSegmentMap } from "./segment-map";
import {
  canonicalizeTransitionType,
  getMisplacedFeatureHint,
  isColorGradeType,
  isSupportedEffectType,
  isSupportedTransitionType,
  normalizeEffectType,
  SUPPORTED_CLIP_EFFECT_TYPES,
  SUPPORTED_TRANSITION_TYPES,
} from "./vocab";

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
      if (!effect.type.trim()) {
        issues.push(issue("error", "empty_effect_type", `Segment ${i} effect ${effectIndex} has no type.`, `segments.${i}.effectSpecs.${effectIndex}.type`));
      }
      if (effect.intensity !== undefined && (!Number.isFinite(effect.intensity) || effect.intensity < 0 || effect.intensity > 1)) {
        issues.push(issue("error", "effect_intensity_out_of_range", `Segment ${i} effect ${effectIndex} intensity must be between 0 and 1.`, `segments.${i}.effectSpecs.${effectIndex}.intensity`));
      }
      if (effect.startOffset !== undefined && (!Number.isFinite(effect.startOffset) || effect.startOffset < 0)) {
        issues.push(issue("error", "effect_offset_out_of_range", `Segment ${i} effect ${effectIndex} startOffset cannot be negative.`, `segments.${i}.effectSpecs.${effectIndex}.startOffset`));
      }
      if (effect.duration !== undefined && (!Number.isFinite(effect.duration) || effect.duration <= 0)) {
        issues.push(issue("error", "effect_duration_invalid", `Segment ${i} effect ${effectIndex} duration must be positive.`, `segments.${i}.effectSpecs.${effectIndex}.duration`));
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

  if (plan.metadata.targetDuration <= 0) {
    issues.push(
      issue("error", "bad_target_duration", "Target duration must be positive.", "metadata.targetDuration"),
    );
  }

  // ---- Renderer-backed vocabulary -----------------------------------------
  const unsupportedEffect = (type: string, path: string): void => {
    if (isSupportedEffectType(type)) return;
    // A structural feature in the wrong place gets an actionable hint so the
    // bounded repair attempt knows where it belongs instead of deleting it.
    const hint = getMisplacedFeatureHint(type);
    if (hint) {
      issues.push(issue("error", "misplaced_feature", `${path}: ${hint}`, path));
      return;
    }
    issues.push(issue(
      "error",
      "unsupported_effect",
      `Effect "${type}" is not supported by the renderer. Supported effects: ${SUPPORTED_CLIP_EFFECT_TYPES.join(", ")} (colorGrade also maps to clip color grading).`,
      path,
    ));
  };

  for (let i = 0; i < plan.segments.length; i++) {
    const segment = plan.segments[i] as PlannedSegment;
    segment.effects.forEach((type, effectIndex) => {
      if (typeof type !== "string" || !type.trim()) {
        issues.push(issue("error", "empty_effect_type", `Segment ${i} effects[${effectIndex}] has no type.`, `segments.${i}.effects.${effectIndex}`));
      } else {
        unsupportedEffect(type, `segments.${i}.effects.${effectIndex}`);
        // colorGrade in the string effects array gets empty params by default,
        // which means it silently does nothing — warn so the LLM uses
        // effectSpecs with explicit params instead.
        if (isColorGradeType(type)) {
          issues.push(issue(
            "warning",
            "implicit_color_grade_params",
            `Segment ${i} effects[${effectIndex}] type "${type}" will receive empty params — use effectSpecs with explicit params instead.`,
            `segments.${i}.effects.${effectIndex}`,
          ));
        }
      }
    });
    segment.effectSpecs?.forEach((spec, effectIndex) => {
      const path = `segments.${i}.effectSpecs.${effectIndex}`;
      unsupportedEffect(spec.type, `${path}.type`);
      if (isColorGradeType(spec.type) && (!spec.params || Object.keys(spec.params).length === 0)) {
        issues.push(issue("error", "empty_color_grade_params", `${path} is a colorGrade with no params — it will do nothing.`, `${path}.params`));
      }
      // The effects engine defaults every numeric param to 0, so a spec with
      // no params and no intensity renders as a no-op. The materializer
      // synthesizes defaults from `intensity` when intensity is present —
      // this flags the remaining case for the revision pass to fill in.
      if (
        spec.type &&
        !isColorGradeType(spec.type) &&
        (!spec.params || Object.keys(spec.params).length === 0) &&
        spec.intensity === undefined
      ) {
        issues.push(issue("warning", "effect_spec_missing_params", `${path} effect "${spec.type}" has no params and no intensity — it will render as a no-op.`, `${path}.params`));
      }
    });
  }
  plan.effects.forEach((effect, effectIndex) => {
    const path = `effects.${effectIndex}`;
    unsupportedEffect(effect.type, `${path}.type`);
    if (isColorGradeType(effect.type) && (!effect.params || Object.keys(effect.params).length === 0)) {
      issues.push(issue("error", "empty_color_grade_params", `${path} is a colorGrade with no params — it will do nothing.`, `${path}.params`));
    }
    if (
      effect.targetSegmentIndex !== undefined &&
      (!Number.isInteger(effect.targetSegmentIndex) ||
        effect.targetSegmentIndex < 0 ||
        effect.targetSegmentIndex >= plan.segments.length)
    ) {
      issues.push(issue("error", "invalid_effect_segment", `${path} targetSegmentIndex ${effect.targetSegmentIndex} is out of range.`, `${path}.targetSegmentIndex`));
    }
  });

  plan.transitions.forEach((transition, index) => {
    const canonical = canonicalizeTransitionType(transition.type);
    // Hard cuts canonicalize to null (drop) — anything else must be renderable.
    if (canonical !== null && !isSupportedTransitionType(canonical)) {
      issues.push(issue(
        "error",
        "unsupported_transition",
        `Transition "${transition.type}" is not supported by the renderer. Supported transitions: ${SUPPORTED_TRANSITION_TYPES.join(", ")}. Hard cuts should be emitted as adjacent clips with no transition entry.`,
        `transitions.${index}.type`,
      ));
    }
  });

  // ---- Text position contract (normalized 0-1, title-engine units) --------
  plan.textElements.forEach((text, index) => {
    if (!text || !Number.isFinite(text.startTime) || text.startTime < 0) {
      issues.push(issue("error", "invalid_text_timing", `Text element ${index} has an invalid startTime.`, `textElements.${index}.startTime`));
      return;
    }
    if (!Number.isFinite(text.duration) || text.duration <= 0) {
      issues.push(issue("error", "invalid_text_timing", `Text element ${index} must have a positive duration.`, `textElements.${index}.duration`));
    }
    const position = text.position;
    if (
      position &&
      (!Number.isFinite(position.x) || !Number.isFinite(position.y) ||
        position.x < 0 || position.x > 1 || position.y < 0 || position.y > 1)
    ) {
      issues.push(issue(
        "error",
        "invalid_text_position",
        `Text element ${index} position (${String(position.x)}, ${String(position.y)}) is outside the normalized 0-1 range (0,0 = top-left; 0.5,0.5 = center).`,
        `textElements.${index}.position`,
      ));
    }
  });

  // ---- Same-track primary-video overlap ------------------------------------
  const placement = computePlanPlacement(plan);
  const byTrack = new Map<number, { start: number; end: number; index: number }[]>();
  plan.segments.forEach((segment, index) => {
    const trackKey = Math.max(0, Math.floor(segment.trackIndex ?? 0));
    const start = placement[index] ?? 0;
    const end = start + Math.max(0, segment.sourceEndTime - segment.sourceStartTime);
    const list = byTrack.get(trackKey) ?? [];
    for (const other of list) {
      if (start < other.end - 1e-6 && other.start < end - 1e-6) {
        issues.push(issue(
          "error",
          "overlapping_timeline_segments",
          `Segments ${other.index} and ${index} overlap in time on the same track (${other.start.toFixed(2)}-${other.end.toFixed(2)}s vs ${start.toFixed(2)}-${end.toFixed(2)}s). Primary video on one track must not overlap; use overlapping trackIndex values with split/pip layout for intentional overlays.`,
          `segments.${index}.targetPosition`,
        ));
        break;
      }
    }
    list.push({ start, end, index });
    byTrack.set(trackKey, list);
  });

  return issues;
}

/**
 * Plan-relative timeline positions for every segment — the single source of
 * truth shared by validation (overlap checks) and materialization.
 *
 * Rules (mirroring what materializeEditPlan commits):
 * 1. If the segment follows a transition (afterSegmentIndex === i-1), place it
 *    directly after the previous segment.
 * 2. Otherwise an explicit `targetPosition` wins (clamped at 0).
 * 3. Otherwise the segment follows the previous content on its own track.
 *
 * Positions are relative to the plan itself and ignore whatever is already on
 * the timeline: replace-plan commits remove the previous plan's content, so
 * placement must not shift based on state that is about to be removed.
 */
export function computePlanPlacement(plan: EditPlan): number[] {
  const positions: number[] = [];
  const trackEnd = new Map<number, number>();
  const transitionAfter = new Set(
    plan.transitions.map((transition) => transition.afterSegmentIndex),
  );
  plan.segments.forEach((segment, index) => {
    const trackKey = Math.max(0, Math.floor(segment.trackIndex ?? 0));
    const duration = Math.max(0, segment.sourceEndTime - segment.sourceStartTime);
    const previous = positions[index - 1];
    let position: number;
    if (index > 0 && transitionAfter.has(index - 1) && previous !== undefined) {
      position = previous + Math.max(0, (plan.segments[index - 1]?.sourceEndTime ?? 0) - (plan.segments[index - 1]?.sourceStartTime ?? 0));
    } else if (Number.isFinite(segment.targetPosition)) {
      position = Math.max(0, segment.targetPosition as number);
    } else {
      position = trackEnd.get(trackKey) ?? 0;
    }
    positions.push(position);
    trackEnd.set(trackKey, Math.max(trackEnd.get(trackKey) ?? 0, position + duration));
  });
  return positions;
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
    if (!Number.isFinite(freeze.sourceTime) || freeze.sourceTime < 0 || freeze.sourceTime > sourceDuration || !Number.isFinite(freeze.startTime) || freeze.startTime < 0 || !Number.isFinite(freeze.duration) || freeze.duration <= 0) {
      issues.push(issue("error", "invalid_freeze_frame", `Segment ${segmentIndex} freeze frame ${freezeIndex} is invalid.`, `segments.${segmentIndex}.speedRamp.freezeFrames.${freezeIndex}`));
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

    // Canonicalize effect names to what the renderer actually draws, so an
    // alias like "warmth" reaches materialize as "temperature" instead of
    // being rejected (or silently dropped).
    const effectSpecs = segment.effectSpecs?.map((spec) => {
      const canonical = normalizeEffectType(spec.type);
      return canonical ? { ...spec, type: canonical } : spec;
    });
    const effects = segment.effects.map((type) => normalizeEffectType(type) ?? type);

    return {
      ...segment,
      sourceStartTime: start,
      sourceEndTime: end,
      ...(effectSpecs ? { effectSpecs } : {}),
      effects,
    };
  });
  const effects = plan.effects.map((effect) => {
    const canonical = normalizeEffectType(effect.type);
    return canonical ? { ...effect, type: canonical } : effect;
  });

  const transitions = plan.transitions.map((transition) => {
    const previous = segments[transition.afterSegmentIndex];
    const next = segments[transition.afterSegmentIndex + 1];
    // Cap transition duration at half the shorter adjacent segment to prevent
    // blends longer than the source clips (causes frame-hold glitches).
    const maxDuration = previous && next
      ? Math.min(previous.sourceEndTime - previous.sourceStartTime, next.sourceEndTime - next.sourceStartTime) * 0.5
      : 0.25;
    const duration = Number.isFinite(transition.duration) && transition.duration > 0
      ? Math.min(transition.duration, maxDuration)
      : Math.min(0.25, maxDuration);

    // Hard cuts canonicalize to null — the entry is kept here and dropped by
    // canonicalizePlanTransitions, never rewritten into a rendered blend.
    const canonical = canonicalizeTransitionType(transition.type);

    return { ...transition, duration, type: canonical ?? transition.type };
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
