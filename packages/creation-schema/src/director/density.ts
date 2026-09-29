import type { EditPlan, Pacing, PlannedSegment } from "./edit-plan";
import type { SegmentMap } from "./segment-map";
import { collectCameraMoveIds } from "./camera-moves";
import { computePlanPlacement } from "./validate";

/**
 * Edit-density measurement and review.
 *
 * The style profile answers "does this match the genre's palette and cut
 * rate". That is necessary and not sufficient: a plan can hit 24 cuts/minute
 * and still be eight splices with two effects — a slideshow with a fast clock.
 * Density answers the other half of the question: *how populated is this
 * timeline*, and does it evolve?
 *
 * Every dimension here is measured from the plan alone (plus optional beat
 * timestamps from the segment map), so the same numbers drive the director
 * prompt, the pre-commit review, and the revision brief. Nothing is scored
 * that the renderer cannot actually draw.
 */

export interface EditDensityProfile {
  readonly targetDuration: number;
  readonly shotCount: number;
  readonly shotsPerMinute: number;
  readonly medianShotDuration: number;
  readonly shortestShotDuration: number;
  readonly longestShotDuration: number;
  /** Longest ÷ shortest shot. 1 = metronome, ≥3 = varied rhythm. */
  readonly shotLengthContrast: number;
  /** Fraction of shots carrying at least one effect, move, ramp, or layout. */
  readonly treatedShotRatio: number;
  readonly effectHits: number;
  readonly effectHitsPerMinute: number;
  readonly distinctEffectTypes: number;
  readonly transitionCount: number;
  readonly distinctTransitionTypes: number;
  readonly textCount: number;
  readonly textsPerMinute: number;
  readonly distinctTextAnimations: number;
  readonly speedRampCount: number;
  readonly freezeFrameCount: number;
  readonly cameraMoveCount: number;
  readonly cameraMoveRatio: number;
  readonly distinctCameraMoves: number;
  readonly layoutVariety: number;
  readonly sfxHits: number;
  readonly audioLayers: number;
  readonly motionMomentCount: number;
  /** Shots that begin inside the hook window (first 2s, or 35% of short edits). */
  readonly hookShots: number;
  readonly hookWindow: number;
  /** Fraction of cuts landing within 0.2s of a beat. null when no beat data. */
  readonly onBeatCutRatio: number | null;
  /** Treatments per 10s in each third of the edit. */
  readonly phaseIntensity: readonly [number, number, number];
  readonly escalation: "rising" | "flat" | "falling";
}

export interface EditDensityTarget {
  readonly shotsPerMinute?: readonly [number, number];
  readonly minimumShotContrast?: number;
  readonly effectHitsPerMinute?: readonly [number, number];
  readonly minimumEffectTypes?: number;
  readonly minimumTreatedShotRatio?: number;
  readonly minimumTransitions?: number;
  readonly minimumTransitionTypes?: number;
  readonly textsPerMinute?: readonly [number, number];
  readonly minimumTextAnimations?: number;
  readonly minimumSpeedRamps?: number;
  /** Fraction of shots that should carry an authored camera move. */
  readonly minimumCameraMoveRatio?: number;
  readonly minimumCameraMoveVariety?: number;
  readonly minimumLayoutVariety?: number;
  readonly minimumSfxHits?: number;
  readonly minimumMotionMoments?: number;
  readonly hookShots?: number;
  readonly minimumOnBeatCutRatio?: number;
  readonly requiresEscalation?: boolean;
}

export type DensityDeficiencySeverity = "minor" | "moderate" | "major";

export interface DensityDeficiency {
  readonly code: string;
  readonly metric: string;
  readonly actual: number | null;
  readonly target: number | readonly [number, number];
  readonly severity: DensityDeficiencySeverity;
  /** Numbers-and-action sentence an LLM can execute directly. */
  readonly directive: string;
}

export interface EditDensityReview {
  readonly profile: EditDensityProfile;
  readonly target: EditDensityTarget;
  readonly score: number;
  readonly deficiencies: readonly DensityDeficiency[];
  /** Compact, machine-checkable summary used by the pre-commit review. */
  readonly summary: string;
}

const HOOK_WINDOW_SECONDS = 2;
const BEAT_TOLERANCE_SECONDS = 0.2;
/** Treatments counted as "energy" for the escalation measurement. */
const PHASE_COUNT = 3;

export const DENSITY_PRESETS: Readonly<Record<Pacing, EditDensityTarget>> = {
  fast: {
    shotsPerMinute: [18, 90],
    minimumShotContrast: 3,
    effectHitsPerMinute: [12, 90],
    minimumEffectTypes: 4,
    minimumTreatedShotRatio: 0.8,
    minimumTransitionTypes: 2,
    textsPerMinute: [8, 48],
    minimumTextAnimations: 2,
    minimumSpeedRamps: 2,
    minimumCameraMoveRatio: 0.6,
    minimumCameraMoveVariety: 3,
    minimumSfxHits: 3,
    minimumMotionMoments: 0,
    hookShots: 3,
    minimumOnBeatCutRatio: 0.5,
    requiresEscalation: true,
  },
  medium: {
    shotsPerMinute: [10, 42],
    minimumShotContrast: 2,
    effectHitsPerMinute: [5, 40],
    minimumEffectTypes: 3,
    minimumTreatedShotRatio: 0.6,
    minimumTransitions: 2,
    minimumTransitionTypes: 2,
    textsPerMinute: [4, 26],
    minimumTextAnimations: 2,
    minimumSpeedRamps: 1,
    minimumCameraMoveRatio: 0.35,
    minimumCameraMoveVariety: 2,
    minimumSfxHits: 1,
    hookShots: 2,
    minimumOnBeatCutRatio: 0.3,
    requiresEscalation: true,
  },
  slow: {
    shotsPerMinute: [4, 24],
    minimumShotContrast: 1.5,
    effectHitsPerMinute: [2, 24],
    minimumEffectTypes: 2,
    minimumTreatedShotRatio: 0.4,
    minimumTransitions: 1,
    minimumTransitionTypes: 1,
    textsPerMinute: [1, 14],
    minimumTextAnimations: 1,
    minimumSpeedRamps: 0,
    minimumCameraMoveRatio: 0.2,
    minimumCameraMoveVariety: 1,
    minimumSfxHits: 0,
    hookShots: 1,
    requiresEscalation: false,
  },
};

/**
 * Resolve the target for a genre: the genre's own overrides win, falling back
 * to the preset for its pacing band. An explicit `pacing: "slow"` on a
 * caption-heavy format therefore lowers the cut-rate expectation while keeping
 * the genre's text requirements.
 */
export function resolveDensityTarget(
  pacing: Pacing,
  override?: EditDensityTarget,
): EditDensityTarget {
  return { ...DENSITY_PRESETS[pacing], ...(override ?? {}) };
}

export function measureEditDensity(
  plan: EditPlan,
  segmentMap?: SegmentMap,
): EditDensityProfile {
  const segments = plan.segments;
  const durations = segments.map((segment) =>
    Math.max(0, segment.sourceEndTime - segment.sourceStartTime),
  );
  const targetDuration = plan.metadata.targetDuration > 0
    ? plan.metadata.targetDuration
    : durations.reduce((sum, duration) => sum + duration, 0);
  const minutes = targetDuration > 0 ? targetDuration / 60 : 0;
  const perMinute = (count: number): number => (minutes > 0 ? count / minutes : 0);

  const sortedDurations = [...durations].sort((left, right) => left - right);
  const medianShotDuration = sortedDurations.length > 0
    ? sortedDurations[Math.floor(sortedDurations.length / 2)]!
    : 0;
  const shortestShotDuration = sortedDurations[0] ?? 0;
  const longestShotDuration = sortedDurations[sortedDurations.length - 1] ?? 0;
  const shotLengthContrast = shortestShotDuration > 1e-3
    ? Math.min(50, longestShotDuration / shortestShotDuration)
    : longestShotDuration > 0
      ? 50
      : 1;

  const effectHits = segments.reduce(
    (sum, segment) => sum + segment.effects.length + (segment.effectSpecs?.length ?? 0),
    plan.effects.length,
  );
  const effectTypes = new Set<string>([
    ...plan.effects.map((effect) => effect.type),
    ...segments.flatMap((segment) => [
      ...segment.effects,
      ...(segment.effectSpecs ?? []).map((spec) => spec.type),
    ]),
  ]);

  const cameraMoves = segments.flatMap((segment) => segment.cameraMoves ?? []);
  const movingShots = segments.filter((segment) => (segment.cameraMoves?.length ?? 0) > 0).length;

  const positions = computePlanPlacement(plan);
  const treatedShotRatio = segments.length > 0
    ? segments.filter((segment) => isTreated(segment)).length / segments.length
    : 0;

  const distinctTextAnimations = new Set(
    plan.textElements
      .map((text) => text.animation ?? plan.captionTemplate?.animation)
      .filter((animation): animation is string => Boolean(animation && animation !== "none")),
  ).size;

  const layouts = new Set<string>();
  for (const segment of segments) {
    const region = segment.layout?.region;
    if (region && region !== "fullscreen") layouts.add(region);
  }

  const beats = beatTimeline(segmentMap);
  const onBeatCutRatio = beats
    ? onBeatRatio(segments, positions, beats)
    : null;

  const hookWindow = Math.min(HOOK_WINDOW_SECONDS, targetDuration * 0.35);
  const hookShots = segments.filter((_, index) => (positions[index] ?? 0) <= hookWindow).length;

  const phaseIntensity = measurePhaseIntensity(plan, positions, targetDuration);
  const [first, , last] = phaseIntensity;
  const escalation: EditDensityProfile["escalation"] = last > first * 1.15
    ? "rising"
    : last < first * 0.85
      ? "falling"
      : "flat";

  return {
    targetDuration,
    shotCount: segments.length,
    shotsPerMinute: perMinute(segments.length),
    medianShotDuration,
    shortestShotDuration,
    longestShotDuration,
    shotLengthContrast,
    treatedShotRatio,
    effectHits,
    effectHitsPerMinute: perMinute(effectHits),
    distinctEffectTypes: effectTypes.size,
    transitionCount: plan.transitions.length,
    distinctTransitionTypes: new Set(plan.transitions.map((transition) => transition.type)).size,
    textCount: plan.textElements.length,
    textsPerMinute: perMinute(plan.textElements.length),
    distinctTextAnimations,
    speedRampCount: segments.filter((segment) => Boolean(segment.speedRamp)).length,
    freezeFrameCount: segments.reduce(
      (sum, segment) => sum + (segment.speedRamp?.freezeFrames?.length ?? 0),
      0,
    ),
    cameraMoveCount: cameraMoves.length,
    cameraMoveRatio: segments.length > 0 ? movingShots / segments.length : 0,
    distinctCameraMoves: collectCameraMoveIds(cameraMoves).length,
    layoutVariety: layouts.size,
    sfxHits: plan.audioDecisions.filter((decision) => decision.type === "sfx").length,
    audioLayers: plan.audioDecisions.filter((decision) => decision.type !== "silence").length,
    motionMomentCount: plan.motionMoments?.length ?? 0,
    hookShots,
    hookWindow,
    onBeatCutRatio,
    phaseIntensity,
    escalation,
  };
}

/**
 * Concrete, countable budget for one edit length — "12-30 shots, 8-25 effect
 * hits, 8 moving shots, 5-14 texts, 4 SFX". This is what the director prompt
 * shows the model: abstract per-minute ranges are much easier to under-deliver
 * than a list of counts for the render it is about to author.
 */
export interface DensityBudget {
  readonly targetDuration: number;
  readonly shots: readonly [number, number];
  readonly effectHits: readonly [number, number];
  readonly cameraMoves: number;
  readonly treatedShots: number;
  readonly texts: readonly [number, number];
  readonly textAnimations: number;
  readonly effectTypes: number;
  readonly speedRamps: number;
  readonly sfxHits: number;
  readonly hookShots: number;
}

export function planDensityBudget(
  target: EditDensityTarget,
  targetDuration: number,
): DensityBudget {
  const duration = Math.max(1, targetDuration);
  const scale = duration / 60;
  const range = (values?: readonly [number, number]): [number, number] =>
    values ? [Math.max(1, Math.round(values[0] * scale)), Math.max(1, Math.round(values[1] * scale))] : [0, 0];
  const shots = range(target.shotsPerMinute);
  const cameraMoves = Math.max(
    target.minimumCameraMoveVariety ?? 1,
    Math.ceil((target.minimumCameraMoveRatio ?? 0) * Math.max(1, shots[0])),
  );
  return {
    targetDuration: duration,
    shots,
    effectHits: range(target.effectHitsPerMinute),
    cameraMoves,
    treatedShots: Math.ceil((target.minimumTreatedShotRatio ?? 0) * Math.max(1, shots[0])),
    texts: range(target.textsPerMinute),
    textAnimations: target.minimumTextAnimations ?? 0,
    effectTypes: target.minimumEffectTypes ?? 0,
    speedRamps: target.minimumSpeedRamps ?? 0,
    sfxHits: target.minimumSfxHits ?? 0,
    hookShots: target.hookShots ?? 0,
  };
}

/**
 * A shot counts as "treated" when something other than the cut is shaping it:
 * an effect, an authored camera move, a speed ramp, or a non-fullscreen layout.
 */
function isTreated(segment: PlannedSegment): boolean {
  return (
    segment.effects.length > 0 ||
    (segment.effectSpecs?.length ?? 0) > 0 ||
    (segment.cameraMoves?.length ?? 0) > 0 ||
    Boolean(segment.speedRamp) ||
    Boolean(segment.layout && segment.layout.region !== "fullscreen")
  );
}

function beatTimeline(segmentMap?: SegmentMap): Map<string, number[]> | null {
  const videos = segmentMap?.videos;
  if (!videos || videos.length === 0) return null;
  const byVideo = new Map<string, number[]>();
  let any = false;
  for (const video of videos) {
    const beats = [...new Set(
      (video.segments ?? []).flatMap((segment) => segment.beatTimestamps ?? []),
    )].sort((left, right) => left - right);
    if (beats.length > 0) any = true;
    byVideo.set(video.videoId, beats);
  }
  return any ? byVideo : null;
}

function onBeatRatio(
  segments: readonly PlannedSegment[],
  positions: readonly number[],
  beats: ReadonlyMap<string, number[]>,
): number | null {
  if (segments.length < 2) return null;
  let cuts = 0;
  let onBeat = 0;
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const previous = segments[index - 1]!;
    // Overlapping (multi-track) segments are layered, not cuts.
    if ((positions[index] ?? 0) < (positions[index - 1] ?? 0)) continue;
    cuts += 1;
    const candidates = [
      ...(beats.get(segment.sourceVideoId) ?? []),
      ...(beats.get(previous.sourceVideoId) ?? []),
    ];
    const hit = candidates.some(
      (beat) =>
        Math.abs(beat - segment.sourceStartTime) <= BEAT_TOLERANCE_SECONDS ||
        Math.abs(beat - previous.sourceEndTime) <= BEAT_TOLERANCE_SECONDS,
    );
    if (hit) onBeat += 1;
  }
  if (cuts === 0) return null;
  return onBeat / cuts;
}

/** Treatments per 10 seconds of timeline in each third of the edit. */
function measurePhaseIntensity(
  plan: EditPlan,
  positions: readonly number[],
  targetDuration: number,
): readonly [number, number, number] {
  const counts: [number, number, number] = [0, 0, 0];
  if (!(targetDuration > 0)) return counts;
  const third = targetDuration / PHASE_COUNT;
  plan.segments.forEach((segment, index) => {
    const local = (segment.effects.length
      + (segment.effectSpecs?.length ?? 0)
      + (segment.cameraMoves?.length ?? 0)
      + (segment.speedRamp ? 1 : 0)) / 1;
    const bucket = Math.min(
      PHASE_COUNT - 1,
      Math.max(0, Math.floor((positions[index] ?? 0) / third)),
    );
    counts[bucket] += local;
  });
  // Texts and SFX land between shots, so they are bucketed by their own time.
  for (const text of plan.textElements) {
    const bucket = Math.min(PHASE_COUNT - 1, Math.max(0, Math.floor(text.startTime / third)));
    counts[bucket] += 1;
  }
  for (const decision of plan.audioDecisions) {
    if (decision.type !== "sfx") continue;
    const bucket = Math.min(PHASE_COUNT - 1, Math.max(0, Math.floor(decision.startTime / third)));
    counts[bucket] += 1;
  }
  const perTenSeconds = third > 0 ? 10 / third : 0;
  return [
    counts[0] * perTenSeconds,
    counts[1] * perTenSeconds,
    counts[2] * perTenSeconds,
  ] as const;
}

interface DimensionSpec {
  readonly metric: string;
  readonly code: string;
  readonly score: number;
  readonly actual: number | null;
  readonly target: number | readonly [number, number];
  readonly directive: string;
  readonly weight?: number;
}

export function compareEditDensity(
  profile: EditDensityProfile,
  target: EditDensityTarget,
): EditDensityReview {
  const dimensions: DimensionSpec[] = [];

  if (target.shotsPerMinute) {
    const [min, max] = target.shotsPerMinute;
    dimensions.push({
      metric: "shotsPerMinute",
      code: "shot_count",
      score: rangeScore(profile.shotsPerMinute, min, max),
      actual: round(profile.shotsPerMinute),
      target: target.shotsPerMinute,
      directive:
        `Only ${profile.shotCount} shot(s) over ${profile.targetDuration.toFixed(1)}s = ` +
        `${profile.shotsPerMinute.toFixed(1)} cuts/min; this genre wants ${min}-${max}. ` +
        `Split the longest shots at beat boundaries and add roughly ${suggestShots(profile, min)} more shot(s) — ` +
        `short 0.4-1.2s inserts of a different angle, reaction, or detail from the same footage count.`,
      weight: 2.5,
    });
  }

  if (target.minimumShotContrast !== undefined) {
    dimensions.push({
      metric: "shotLengthContrast",
      code: "shot_rhythm_uniform",
      score: minimumScore(profile.shotLengthContrast, target.minimumShotContrast),
      actual: round(profile.shotLengthContrast),
      target: target.minimumShotContrast,
      directive:
        `Shot lengths are near-uniform (shortest ${profile.shortestShotDuration.toFixed(2)}s, ` +
        `longest ${profile.longestShotDuration.toFixed(2)}s, ratio ${profile.shotLengthContrast.toFixed(1)}; ` +
        `want ≥${target.minimumShotContrast}). Mix a few sub-0.5s micro-cuts with 2-4s holds instead of ` +
        `one consistent shot length.`,
      weight: 1.5,
    });
  }

  if (target.effectHitsPerMinute) {
    const [min, max] = target.effectHitsPerMinute;
    dimensions.push({
      metric: "effectHitsPerMinute",
      code: "effect_density",
      score: rangeScore(profile.effectHitsPerMinute, min, max),
      actual: round(profile.effectHitsPerMinute),
      target: target.effectHitsPerMinute,
      directive:
        `Only ${profile.effectHits} effect hit(s) (${profile.effectHitsPerMinute.toFixed(1)}/min); ` +
        `this genre runs ${min}-${max}/min. Add short (0.15-0.5s) hits with explicit params on the ` +
        `hardest cuts — chromatic-aberration, motion-blur, glow, radial-blur, flash-adjacent grades.`,
      weight: 2,
    });
  }

  if (target.minimumEffectTypes !== undefined) {
    dimensions.push({
      metric: "distinctEffectTypes",
      code: "effect_variety",
      score: minimumScore(profile.distinctEffectTypes, target.minimumEffectTypes),
      actual: profile.distinctEffectTypes,
      target: target.minimumEffectTypes,
      directive:
        `Only ${profile.distinctEffectTypes} distinct effect type(s) across the edit; use at least ` +
        `${target.minimumEffectTypes} so the treatment reads as authored rather than a preset.`,
      weight: 1.5,
    });
  }

  if (target.minimumTreatedShotRatio !== undefined) {
    dimensions.push({
      metric: "treatedShotRatio",
      code: "static_shots",
      score: minimumScore(profile.treatedShotRatio, target.minimumTreatedShotRatio),
      actual: round(profile.treatedShotRatio),
      target: target.minimumTreatedShotRatio,
      directive:
        `${Math.round((1 - profile.treatedShotRatio) * 100)}% of shots carry no effect, camera move, ` +
        `speed ramp, or layout — they read as raw splices. Give every shot at least one treatment ` +
        `(target ≥${Math.round(target.minimumTreatedShotRatio * 100)}%).`,
      weight: 2,
    });
  }

  if (target.minimumCameraMoveRatio !== undefined) {
    dimensions.push({
      metric: "cameraMoveRatio",
      code: "camera_motion",
      score: minimumScore(profile.cameraMoveRatio, target.minimumCameraMoveRatio),
      actual: round(profile.cameraMoveRatio),
      target: target.minimumCameraMoveRatio,
      directive:
        `Only ${profile.cameraMoveCount} camera move(s) across ${profile.shotCount} shot(s) ` +
        `(${Math.round(profile.cameraMoveRatio * 100)}% of shots move; want ≥` +
        `${Math.round(target.minimumCameraMoveRatio * 100)}%). Add \`cameraMoves\` to the remaining ` +
        `shots — slow-push/drift on holds, punch-in on beats, handheld for energy, snap-zoom on the hook.`,
      weight: 2,
    });
  }

  if (target.minimumCameraMoveVariety !== undefined) {
    dimensions.push({
      metric: "distinctCameraMoves",
      code: "camera_move_variety",
      score: minimumScore(profile.distinctCameraMoves, target.minimumCameraMoveVariety),
      actual: profile.distinctCameraMoves,
      target: target.minimumCameraMoveVariety,
      directive:
        `Only ${profile.distinctCameraMoves} distinct camera move(s); vary them (≥` +
        `${target.minimumCameraMoveVariety}) so the motion does not feel mechanical.`,
      weight: 1.5,
    });
  }

  if (target.minimumSpeedRamps !== undefined && target.minimumSpeedRamps > 0) {
    dimensions.push({
      metric: "speedRampCount",
      code: "speed_ramps",
      score: minimumScore(profile.speedRampCount, target.minimumSpeedRamps),
      actual: profile.speedRampCount,
      target: target.minimumSpeedRamps,
      directive:
        `${profile.speedRampCount} speed ramp(s) (want ≥${target.minimumSpeedRamps}). Ramp down into the ` +
        `biggest moment (1.0→0.35 over ~0.4s) and back up out of it, or add a freeze frame on the peak.`,
      weight: 1.2,
    });
  }

  if (target.textsPerMinute) {
    const [min, max] = target.textsPerMinute;
    dimensions.push({
      metric: "textsPerMinute",
      code: "text_density",
      score: rangeScore(profile.textsPerMinute, min, max),
      actual: round(profile.textsPerMinute),
      target: target.textsPerMinute,
      directive:
        `${profile.textCount} text element(s) (${profile.textsPerMinute.toFixed(1)}/min); this format runs ` +
        `${min}-${max}/min. Add hooks, callouts, name tags, captions and a closing beat — each with its own ` +
        `timing, position and animation.`,
      weight: 1.5,
    });
  }

  if (target.minimumTextAnimations !== undefined) {
    dimensions.push({
      metric: "distinctTextAnimations",
      code: "text_animation_variety",
      score: minimumScore(profile.distinctTextAnimations, target.minimumTextAnimations),
      actual: profile.distinctTextAnimations,
      target: target.minimumTextAnimations,
      directive:
        `${profile.distinctTextAnimations} distinct text animation(s); use ≥` +
        `${target.minimumTextAnimations} (pop, bounce, slide-up, typewriter, zoom-blur, split, cascade) ` +
        `so the type does not enter the same way every time.`,
      weight: 1,
    });
  }

  if (target.minimumTransitions !== undefined && target.minimumTransitions > 0) {
    dimensions.push({
      metric: "transitionCount",
      code: "transition_count",
      score: minimumScore(profile.transitionCount, target.minimumTransitions),
      actual: profile.transitionCount,
      target: target.minimumTransitions,
      directive:
        `${profile.transitionCount} rendered transition(s) (want ≥${target.minimumTransitions}). Hard cuts ` +
        `stay the default, but a few deliberate blends — whipPan, flash, zoom, glitch — mark the chapter changes.`,
      weight: 1,
    });
  }

  if (target.minimumTransitionTypes !== undefined && profile.transitionCount > 0) {
    dimensions.push({
      metric: "distinctTransitionTypes",
      code: "transition_variety",
      score: minimumScore(profile.distinctTransitionTypes, target.minimumTransitionTypes),
      actual: profile.distinctTransitionTypes,
      target: target.minimumTransitionTypes,
      directive:
        `${profile.distinctTransitionTypes} distinct transition type(s) for ${profile.transitionCount} ` +
        `transition(s); alternate at least ${target.minimumTransitionTypes} (never the same blend twice in a row).`,
      weight: 1,
    });
  }

  if (target.minimumLayoutVariety !== undefined && target.minimumLayoutVariety > 0) {
    dimensions.push({
      metric: "layoutVariety",
      code: "layout_variety",
      score: minimumScore(profile.layoutVariety, target.minimumLayoutVariety),
      actual: profile.layoutVariety,
      target: target.minimumLayoutVariety,
      directive:
        `Only ${profile.layoutVariety} non-fullscreen layout region(s); this format needs ≥` +
        `${target.minimumLayoutVariety} (split-left/split-right, pip-corner) on overlapping tracks.`,
      weight: 1.5,
    });
  }

  if (target.minimumSfxHits !== undefined && target.minimumSfxHits > 0) {
    dimensions.push({
      metric: "sfxHits",
      code: "sfx_layer",
      score: minimumScore(profile.sfxHits, target.minimumSfxHits),
      actual: profile.sfxHits,
      target: target.minimumSfxHits,
      directive:
        `${profile.sfxHits} SFX hit(s) (want ≥${target.minimumSfxHits}). Layer one-shot hits on the biggest ` +
        `cuts/impacts — they are what makes a cut feel like it landed.`,
      weight: 1.2,
    });
  }

  if (target.minimumMotionMoments !== undefined && target.minimumMotionMoments > 0) {
    dimensions.push({
      metric: "motionMomentCount",
      code: "motion_moments",
      score: minimumScore(profile.motionMomentCount, target.minimumMotionMoments),
      actual: profile.motionMomentCount,
      target: target.minimumMotionMoments,
      directive:
        `${profile.motionMomentCount} motion moment(s) (want ≥${target.minimumMotionMoments}). Use the named ` +
        `moves — particle-burst-on-cut, glitch-transition, 3d-title-card — for the single biggest beat.`,
      weight: 0.8,
    });
  }

  if (target.hookShots !== undefined && target.hookShots > 0) {
    dimensions.push({
      metric: "hookShots",
      code: "hook",
      score: minimumScore(profile.hookShots, target.hookShots),
      actual: profile.hookShots,
      target: target.hookShots,
      directive:
        `The first ${profile.hookWindow.toFixed(1)}s contains ${profile.hookShots} shot(s) (want ≥${target.hookShots}). ` +
        `Open cold: 2-3 micro-shots of the strongest footage before the first title, no slow ramp-in.`,
      weight: 1.5,
    });
  }

  if (target.minimumOnBeatCutRatio !== undefined && profile.onBeatCutRatio !== null) {
    dimensions.push({
      metric: "onBeatCutRatio",
      code: "beat_sync",
      score: minimumScore(profile.onBeatCutRatio, target.minimumOnBeatCutRatio),
      actual: round(profile.onBeatCutRatio),
      target: target.minimumOnBeatCutRatio,
      directive:
        `${Math.round(profile.onBeatCutRatio * 100)}% of cuts land on a beat (want ≥` +
        `${Math.round(target.minimumOnBeatCutRatio * 100)}%). Re-align cut points to the beatTimestamps ` +
        `listed for each segment (±0.2s) and put effect hits on downbeats.`,
      weight: 1.2,
    });
  }

  if (target.requiresEscalation) {
    const score = profile.escalation === "rising" ? 1 : profile.escalation === "flat" ? 0.45 : 0.15;
    dimensions.push({
      metric: "escalation",
      code: "no_evolution",
      score,
      actual: round(profile.phaseIntensity[2]!),
      target: round(profile.phaseIntensity[0]! * 1.15),
      directive:
        `Energy is ${profile.escalation} across the edit ` +
        `(treatments per 10s: ${profile.phaseIntensity.map((value) => value.toFixed(1)).join(" → ")}). ` +
        `Build an arc: phase 1 establishes with clean moves, phase 2 doubles effect hits and shortens shots, ` +
        `phase 3 is the densest (fastest cuts, heaviest treatment, payoff text) then resolves.`,
      weight: 1.5,
    });
  }

  const totalWeight = dimensions.reduce((sum, dimension) => sum + (dimension.weight ?? 1), 0);
  const score = totalWeight > 0
    ? dimensions.reduce((sum, dimension) => sum + dimension.score * (dimension.weight ?? 1), 0) / totalWeight
    : 1;

  const deficiencies = dimensions
    .filter((dimension) => dimension.score < 0.999)
    .map<DensityDeficiency>((dimension) => ({
      code: dimension.code,
      metric: dimension.metric,
      actual: dimension.actual,
      target: dimension.target,
      severity: dimension.score < 0.35 ? "major" : dimension.score < 0.7 ? "moderate" : "minor",
      directive: dimension.directive,
    }))
    .sort((left, right) => severityRank(right.severity) - severityRank(left.severity));

  return {
    profile,
    target,
    score: Math.max(0, Math.min(1, score)),
    deficiencies,
    summary: summarizeDensityProfile(profile),
  };
}

/** One-line, human-readable density summary. */
export function summarizeDensityProfile(profile: EditDensityProfile): string {
  const beats = profile.onBeatCutRatio === null
    ? "beat data unavailable"
    : `cuts on beat ${Math.round(profile.onBeatCutRatio * 100)}%`;
  return [
    `${profile.shotCount} shots / ${profile.targetDuration.toFixed(1)}s (${profile.shotsPerMinute.toFixed(1)}/min)`,
    `median ${profile.medianShotDuration.toFixed(2)}s, contrast ${profile.shotLengthContrast.toFixed(1)}x`,
    `${profile.effectHits} effect hits (${profile.effectHitsPerMinute.toFixed(1)}/min, ${profile.distinctEffectTypes} types)`,
    `${profile.cameraMoveCount} camera moves (${profile.distinctCameraMoves} kinds)`,
    `${profile.textCount} texts (${profile.distinctTextAnimations} animations)`,
    `${profile.speedRampCount} speed ramps`,
    `${profile.sfxHits} SFX`,
    `treated shots ${Math.round(profile.treatedShotRatio * 100)}%`,
    `evolution ${profile.escalation}`,
    beats,
  ].join(" · ");
}

/**
 * Revision brief handed back to the director. Ordered by severity so a single
 * bounded revision pass fixes the loudest problems first.
 */
export function formatDensityBrief(review: EditDensityReview, limit = 8): string {
  const header =
    `Density score ${review.score.toFixed(2)} for a ${review.profile.targetDuration.toFixed(1)}s edit ` +
    `(${review.summary}).`;
  if (review.deficiencies.length === 0) {
    return `${header} The timeline is populated and evolving — keep it.`;
  }
  const lines = review.deficiencies
    .slice(0, limit)
    .map((deficiency, index) =>
      `${index + 1}. [${deficiency.code} · ${deficiency.severity}] ${deficiency.directive}`,
    );
  return [
    header,
    "The edit is under-built for its target. Fix every item below in the revised plan and keep everything that already works:",
    ...lines,
  ].join("\n");
}

function suggestShots(profile: EditDensityProfile, minimumPerMinute: number): number {
  const wanted = Math.ceil((minimumPerMinute * profile.targetDuration) / 60);
  return Math.max(1, wanted - profile.shotCount);
}

function rangeScore(value: number, min: number, max: number): number {
  if (value >= min && value <= max) return 1;
  const span = Math.max(max - min, 1);
  const distance = value < min ? min - value : value - max;
  return Math.max(0, 1 - distance / span);
}

function minimumScore(value: number, minimum: number): number {
  if (minimum <= 0) return 1;
  return Math.max(0, Math.min(1, value / minimum));
}

function severityRank(severity: DensityDeficiencySeverity): number {
  return severity === "major" ? 2 : severity === "moderate" ? 1 : 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
