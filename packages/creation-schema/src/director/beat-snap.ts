import type { EditPlan, PlannedSegment } from "./edit-plan";
import type { SegmentMap } from "./segment-map";
import { computePlanPlacement } from "./validate";

/**
 * How close a cut must be to a beat to count as "on the beat".
 *
 * This is a *measurement* threshold, not a snapping window. It was 0.2, which at
 * 128 BPM (a 0.47 s beat) counted roughly the middle half of every beat as
 * on-beat and made the metric meaningless. 40 ms is about one frame at 24 fps and
 * slightly over two at 60 fps: tight enough that chance alignment is rare, loose
 * enough for frame-quantised cuts. See `snapTimeToBeat` for the separate, much
 * wider window used when *moving* a cut onto a beat.
 */
export const BEAT_TOLERANCE_SECONDS = 0.04;

/**
 * Units a shot length may be expressed in, as fractions of a beat.
 *
 * Deliberately coarse-to-fine: whole beats are the strongest musical statement,
 * half and quarter beats exist because real fast-cut references do land on the
 * off-beat, and quantising those to whole beats would halve the cutting rate of
 * exactly the references that are hardest to clone.
 */
export const BEAT_SUBDIVISIONS = [1, 0.5, 0.25] as const;

export type BeatSubdivision = (typeof BEAT_SUBDIVISIONS)[number];

/** Where the timeline's beat grid came from. */
export type BeatGridSource = "music-bed" | "source-footage";

export interface TimelineBeatGrid {
  /** Beat positions in *timeline* seconds, not source time. */
  readonly beats: readonly number[];
  readonly source: BeatGridSource;
  /** Seconds per beat, from the underlying grid (the tempo, not the union). */
  readonly beatPeriodSeconds: number;
  /** Reference cut offset in seconds; negative means cuts land early. */
  readonly offsetSeconds: number;
}

export interface BeatSnapOptions {
  /**
   * The reference's median cut offset in seconds, from the analysis
   * (`cutOffsetMs`). Negative means the reference cuts early.
   *
   * Applied because it is part of the style: an edit that cuts exactly on the
   * beat is not what a reference that consistently cuts 30 ms early sounds like.
   */
  readonly cutOffsetSeconds?: number;
  /**
   * Unit when no reference shot lengths are supplied, in beats. Defaults to 1 —
   * whole beats — the unit that cannot mislead, because every cut lands on a
   * beat and the on-beat metric and the edit then agree exactly.
   */
  readonly subdivisionBeats?: number;
  /** Reference shot lengths in beats, used to choose the unit. */
  readonly referenceShotLengthsInBeats?: readonly number[];
}

export type BeatSnapIssueCode =
  | "no_beat_grid"
  | "no_material"
  | "short_of_one_subdivision"
  | "anchored_segment";

export interface BeatSnapIssue {
  readonly segmentIndex: number;
  readonly code: BeatSnapIssueCode;
  readonly message: string;
}

export interface BeatSnapReport {
  readonly gridSource: BeatGridSource | null;
  readonly beatPeriodSeconds: number;
  readonly subdivisionBeats: number;
  /** Seconds per grid step: `beatPeriodSeconds * subdivisionBeats`. */
  readonly gridStepSeconds: number;
  readonly offsetSeconds: number;
  readonly totalCuts: number;
  readonly snappedCuts: number;
  readonly meanAbsShiftSeconds: number;
  readonly maxAbsShiftSeconds: number;
  /** Cuts within {@link BEAT_TOLERANCE_SECONDS} of the grid, before and after. */
  readonly onBeatRatioBefore: number | null;
  readonly onBeatRatioAfter: number | null;
  readonly substitutedMoments: number;
  readonly issues: readonly BeatSnapIssue[];
}

export interface BeatSnapResult {
  readonly plan: EditPlan;
  readonly report: BeatSnapReport;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Collect the beats of each analysed video, in that video's own time.
 *
 * The engine puts a whole-file beat grid on every segment of a video, so the
 * union across a video's segments is that video's grid.
 */
function sourceBeatsByVideo(segmentMap?: SegmentMap): Map<string, number[]> {
  const byVideo = new Map<string, number[]>();
  for (const video of segmentMap?.videos ?? []) {
    const beats = [
      ...new Set((video.segments ?? []).flatMap((segment) => segment.beatTimestamps ?? [])),
    ].sort((left, right) => left - right);
    if (beats.length > 0) byVideo.set(video.videoId, beats);
  }
  return byVideo;
}

function medianInterval(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const gaps: number[] = [];
  for (let index = 1; index < values.length; index += 1) {
    const gap = values[index]! - values[index - 1]!;
    if (gap > 1e-6) gaps.push(gap);
  }
  if (gaps.length === 0) return 0;
  gaps.sort((left, right) => left - right);
  return gaps[Math.floor(gaps.length / 2)]!;
}

function medianOf(values: readonly number[]): number {
  const usable = values.filter((value) => value > 0).sort((left, right) => left - right);
  if (usable.length === 0) return 0;
  return usable[Math.floor(usable.length / 2)]!;
}

/**
 * Resolve the beat grid the edit should be cut against, in timeline seconds.
 *
 * A music bed wins when the plan has one: a cut's timeline position is what the
 * viewer hears against the music, so the music's beats are the ones that matter.
 * The bed is mapped from source time into timeline time through its own
 * placement, which is what makes this a *timeline* grid rather than a set of
 * source-time marks that happen to be near the cuts.
 *
 * Without a music bed the footage's own audio is the soundtrack, and each used
 * clip's beats are mapped through that clip's placement. That case reduces to
 * exactly what the density metric compared before: a cut is on-beat when the
 * incoming clip starts on one of its own beats, or when the outgoing clip ends
 * on one of its own beats. So plans without a music bed score as they always
 * did, and the change is confined to plans that actually have music.
 */
export function resolveTimelineBeatGrid(
  plan: EditPlan,
  segmentMap?: SegmentMap,
  options: BeatSnapOptions = {},
): TimelineBeatGrid | null {
  const offsetSeconds = options.cutOffsetSeconds ?? 0;
  const byVideo = sourceBeatsByVideo(segmentMap);

  const bed = plan.audioDecisions.find(
    (decision) => decision.type === "music" && decision.sourceVideoId !== undefined,
  );
  const bedBeats = bed?.sourceVideoId ? byVideo.get(bed.sourceVideoId) : undefined;
  if (bed && bedBeats && bedBeats.length > 0) {
    const bedSourceStart = bed.sourceStartTime ?? 0;
    const windowStart = bed.startTime;
    const windowEnd = bed.startTime + Math.max(0, bed.duration);
    const beats = bedBeats
      .map((beat) => round(windowStart + (beat - bedSourceStart)))
      .filter((beat) => beat >= windowStart - 1e-6 && beat <= windowEnd + 1e-6);
    if (beats.length > 0) {
      return {
        beats,
        source: "music-bed",
        beatPeriodSeconds: medianInterval(beats),
        offsetSeconds,
      };
    }
  }

  if (byVideo.size === 0) return null;

  const positions = computePlanPlacement(plan);
  const mapped = new Set<number>();
  plan.segments.forEach((segment, index) => {
    const beats = byVideo.get(segment.sourceVideoId);
    if (!beats) return;
    const position = positions[index] ?? 0;
    // Where each source-time beat is heard on the timeline.
    for (const beat of beats) mapped.add(round(position + (beat - segment.sourceStartTime)));
  });
  if (mapped.size === 0) return null;

  return {
    beats: [...mapped].sort((left, right) => left - right),
    source: "source-footage",
    // The mapped union interleaves several clips' grids, so its median gap can
    // be half a beat. Take the tempo from the per-video grids instead.
    beatPeriodSeconds: medianOf([...byVideo.values()].map(medianInterval)),
    offsetSeconds,
  };
}

/**
 * Pick the unit the reference's own cutting is expressible in.
 *
 * Each candidate is scored by how far the reference's shot lengths sit from the
 * nearest whole multiple of it. Finer units always fit at least as well, so the
 * choice is the *coarsest* unit that explains the reference, and the ratio test
 * is what stops that from always ending at quarter beats: a unit is accepted
 * only when the average miss is under a quarter of it.
 */
export function inferSubdivisionBeats(
  referenceShotLengthsInBeats: readonly number[],
  fallback = 1,
): number {
  if (referenceShotLengthsInBeats.length === 0) return fallback;

  for (const unit of BEAT_SUBDIVISIONS) {
    const residual =
      referenceShotLengthsInBeats.reduce((sum, length) => {
        if (!(length > 0)) return sum;
        return sum + Math.abs(Math.round(length / unit) * unit - length);
      }, 0) / referenceShotLengthsInBeats.length;
    if (residual <= unit * 0.25) return unit;
  }
  return BEAT_SUBDIVISIONS[BEAT_SUBDIVISIONS.length - 1]!;
}

/**
 * The grid points a cut may land on: every beat, subdivided, offset applied.
 *
 * The offset shifts the whole grid rather than the cuts, so a reference that
 * cuts 30 ms early produces a grid 30 ms early — which is the edit that was
 * measured, not an edit that is 30 ms off it.
 */
export function beatGridPoints(
  grid: TimelineBeatGrid,
  subdivisionBeats = 1,
): number[] {
  const step = grid.beatPeriodSeconds * subdivisionBeats;
  const points = new Set<number>();
  if (!(step > 0)) {
    for (const beat of grid.beats) points.add(round(beat + grid.offsetSeconds));
    return [...points].sort((left, right) => left - right);
  }
  const perBeat = Math.max(1, Math.round(1 / subdivisionBeats));
  for (const beat of grid.beats) {
    for (let index = 0; index < perBeat; index += 1) {
      points.add(round(beat + index * step + grid.offsetSeconds));
    }
  }
  return [...points].sort((left, right) => left - right);
}

function nearestGridDistance(value: number, grid: readonly number[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const point of grid) {
    const distance = Math.abs(point - value);
    if (distance < best) best = distance;
    if (best === 0) break;
  }
  return best;
}

/**
 * Fraction of cuts landing within {@link BEAT_TOLERANCE_SECONDS} of the grid,
 * measured on the timeline.
 *
 * Cut positions come from {@link computePlanPlacement}, the same function the
 * compiler and the density profile use, so this measures the edit rather than a
 * proxy for it.
 */
export function measureTimelineBeatAlignment(
  plan: EditPlan,
  grid: TimelineBeatGrid | null,
  subdivisionBeats = 1,
): number | null {
  if (!grid || grid.beats.length === 0) return null;
  if (plan.segments.length < 2) return null;
  const points = beatGridPoints(grid, subdivisionBeats);
  if (points.length === 0) return null;

  const positions = computePlanPlacement(plan);
  let cuts = 0;
  let onGrid = 0;
  for (let index = 1; index < plan.segments.length; index += 1) {
    // Overlapping (multi-track) segments are layered, not cuts.
    if ((positions[index] ?? 0) < (positions[index - 1] ?? 0)) continue;
    cuts += 1;
    if (nearestGridDistance(positions[index]!, points) <= BEAT_TOLERANCE_SECONDS) onGrid += 1;
  }
  return cuts === 0 ? null : onGrid / cuts;
}

/** Timeline ranges where material exists for a video, from the analysis. */
function materialRanges(segmentMap: SegmentMap | undefined, videoId: string): number[][] {
  const video = segmentMap?.videos.find((candidate) => candidate.videoId === videoId);
  if (!video) return [];
  return (video.segments ?? [])
    .map((segment) => [segment.startTime, segment.endTime] as number[])
    .filter((range) => range[1]! - range[0]! > 1e-6)
    .sort((left, right) => left[0]! - right[0]!);
}

interface SourceChoice {
  readonly startTime: number;
  readonly endTime: number;
  readonly substituted: boolean;
}

/**
 * Find a source span of `duration` seconds for a shot wanted from `moment`.
 *
 * A shot is trimmed or extended from its planned in-point when the material is
 * there. When it is not, a different moment is used rather than stretching the
 * shot: a stretched shot either freezes or smears, and neither is what the
 * reference did. Substitution stays inside the same source video and prefers the
 * nearest material, so the edit still shows footage the director picked.
 */
function chooseSourceSpan(
  moment: number,
  plannedEnd: number,
  duration: number,
  ranges: readonly number[][],
  videoDuration: number | undefined,
): SourceChoice | null {
  const plannedSpan = Math.max(0, plannedEnd - moment);

  if (ranges.length === 0) {
    // No analysis to draw on: trimming is safe, growing is not knowable beyond
    // the video's own length.
    if (duration <= plannedSpan + 1e-9) {
      return { startTime: moment, endTime: moment + duration, substituted: false };
    }
    if (videoDuration !== undefined && moment + duration <= videoDuration + 1e-9) {
      return { startTime: moment, endTime: moment + duration, substituted: false };
    }
    return null;
  }

  const run = ranges.find(
    (range) => moment >= range[0]! - 1e-9 && moment <= range[1]! + 1e-9,
  );
  if (run && moment + duration <= run[1]! + 1e-9) {
    return { startTime: moment, endTime: moment + duration, substituted: false };
  }

  const usable = ranges.filter((range) => range[1]! - range[0]! + 1e-9 >= duration);
  if (usable.length === 0) return null;
  let chosen = usable[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const range of usable) {
    const distance = Math.abs(range[0]! - moment);
    if (distance < bestDistance) {
      bestDistance = distance;
      chosen = range;
    }
  }
  return { startTime: chosen[0]!, endTime: chosen[0]! + duration, substituted: true };
}

function nearestGridPoint(grid: readonly number[], value: number): number {
  if (grid.length === 0) return value;
  let best = grid[0]!;
  let bestDistance = Math.abs(best - value);
  for (const point of grid) {
    const distance = Math.abs(point - value);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }
  return best;
}

/**
 * Quantise the plan's cut points onto the beat grid, deterministically.
 *
 * The director decides which footage appears, in what order, and why. This
 * decides where the cuts land, because that part is arithmetic: a model asked to
 * add 2.3 and 0.9 beats and place a cut at the sum will be approximately right
 * and audibly wrong. Nothing here consults a model, and every change is reported.
 *
 * The cascade runs on *ideal* boundaries — the running sum of the planned
 * durations, never itself quantised — and snaps each one independently. So a shot
 * that gives up 30 ms to reach the grid does not push every later cut 30 ms late;
 * the next shot absorbs the difference. Quantising each duration in turn would do
 * exactly that, and drift.
 */
export function snapPlanToBeatGrid(
  plan: EditPlan,
  segmentMap?: SegmentMap,
  options: BeatSnapOptions = {},
): BeatSnapResult {
  const issues: BeatSnapIssue[] = [];
  const grid = resolveTimelineBeatGrid(plan, segmentMap, options);
  const requestedUnit = inferSubdivisionBeats(
    options.referenceShotLengthsInBeats ?? [],
    options.subdivisionBeats ?? 1,
  );
  const durations = plan.segments.map((segment) =>
    Math.max(0, segment.sourceEndTime - segment.sourceStartTime),
  );
  const onBeatRatioBefore = measureTimelineBeatAlignment(plan, grid, requestedUnit);

  if (!grid || grid.beats.length === 0) {
    plan.segments.forEach((_, segmentIndex) => {
      issues.push({
        segmentIndex,
        code: "no_beat_grid",
        message: "No beat grid for this plan, so no cut was moved.",
      });
    });
    return {
      plan,
      report: {
        gridSource: null,
        beatPeriodSeconds: 0,
        subdivisionBeats: requestedUnit,
        gridStepSeconds: 0,
        offsetSeconds: options.cutOffsetSeconds ?? 0,
        totalCuts: Math.max(0, plan.segments.length - 1),
        snappedCuts: 0,
        meanAbsShiftSeconds: 0,
        maxAbsShiftSeconds: 0,
        onBeatRatioBefore,
        onBeatRatioAfter: onBeatRatioBefore,
        substitutedMoments: 0,
        issues,
      },
    };
  }

  const beatPeriod = grid.beatPeriodSeconds;
  const shortest = durations.length > 0 ? Math.min(...durations) : 0;

  // Refine the unit while the shortest shot cannot hold one grid step. Going
  // finer never moves a cut off the grid — the grid keeps every coarser point —
  // so the only cost is that cuts may land on the off-beat, which is why the
  // unit is not simply always a quarter beat.
  let unit: number = BEAT_SUBDIVISIONS[BEAT_SUBDIVISIONS.length - 1]!;
  if (beatPeriod > 0) {
    for (const candidate of BEAT_SUBDIVISIONS) {
      if (candidate > requestedUnit) continue;
      if (beatPeriod * candidate <= shortest + 1e-9) {
        unit = candidate;
        break;
      }
    }
  } else {
    unit = requestedUnit;
  }

  const gridPoints = beatGridPoints(grid, unit);
  const step = beatPeriod * unit;

  const positions = computePlanPlacement(plan);
  let ideal = positions[0] ?? 0;
  let cursor = ideal;
  // Where the *plan* says the running shot ends. Chain detection has to use the
  // plan's own geometry, not `cursor`: snapping deliberately moves the cut, so
  // comparing the next segment's planned start against the snapped position made
  // every segment after the first look anchored.
  let plannedEnd = (positions[0] ?? 0) + (durations[0] ?? 0);
  let snappedCuts = 0;
  let substitutedMoments = 0;
  let totalShift = 0;
  let maxShift = 0;
  let totalCuts = 0;

  const snappedSegments: PlannedSegment[] = new Array(plan.segments.length);
  // Shift applied to the cut at each boundary, keyed by the boundary's planned
  // position, so absolute-time text can be carried along.
  const shiftByBoundary = new Map<number, number>();

  plan.segments.forEach((segment, index) => {
    const duration = durations[index]!;
    const planned = positions[index] ?? 0;

    if (index > 0) {
      // Footage layered inside the shot that is already running. An overlay is
      // not a splice, so it neither gets snapped nor advances the chain.
      if (planned < plannedEnd - 1e-6) {
        snappedSegments[index] = segment;
        issues.push({
          segmentIndex: index,
          code: "anchored_segment",
          message: `Segment ${index} overlaps the running shot, so it is treated as a layer rather than a cut and left where it was.`,
        });
        return;
      }

      // A segment that does not begin where the previous shot ends is anchored:
      // a deliberate placement, or a gap. Snapping it would move content the
      // director positioned on purpose, so it is left alone and the cascade
      // re-anchors to where it actually sits.
      if (Math.abs(planned - plannedEnd) > 1e-6) {
        snappedSegments[index] = segment;
        issues.push({
          segmentIndex: index,
          code: "anchored_segment",
          message: `Segment ${index} is anchored at ${planned.toFixed(3)}s rather than continuing the cut chain, so it was left where it was.`,
        });
        plannedEnd = planned + duration;
        cursor = plannedEnd;
        ideal = cursor;
        return;
      }
    }

    if (index === plan.segments.length - 1) {
      // Nothing follows, so there is no cut to move. The tail is the editor's
      // business, not the grid's.
      snappedSegments[index] = segment;
      return;
    }

    // This shot's end is a cut. `ideal` is the running sum of *planned*
    // durations and is never quantised, so each cut is snapped from the same
    // ideal position the plan asked for — which is what stops one shot's
    // rounding error from being pushed into every later cut.
    totalCuts += 1;
    ideal += duration;
    plannedEnd = planned + duration;
    const boundary = positions[index + 1] ?? planned + duration;

    let target = nearestGridPoint(gridPoints, ideal);
    // Keep the shot positive; a snap may not collapse it.
    if (target <= cursor + 1e-6) {
      target = gridPoints.find((point) => point > cursor + 1e-6) ?? target;
    }
    const snappedDuration = round(target - cursor);

    if (!(snappedDuration > 1e-6)) {
      issues.push({
        segmentIndex: index,
        code: "short_of_one_subdivision",
        message: `Shot ${index} is shorter than one grid step (${step.toFixed(3)}s), so its cut was left where it was.`,
      });
      snappedSegments[index] = segment;
      cursor = boundary;
      ideal = boundary;
      return;
    }

    const ranges = materialRanges(segmentMap, segment.sourceVideoId);
    const videoDuration = segmentMap?.videos.find(
      (video) => video.videoId === segment.sourceVideoId,
    )?.duration;
    const choice = chooseSourceSpan(
      segment.sourceStartTime,
      segment.sourceEndTime,
      snappedDuration,
      ranges,
      videoDuration,
    );

    if (!choice) {
      issues.push({
        segmentIndex: index,
        code: "no_material",
        message: `No ${snappedDuration.toFixed(3)}s of material for shot ${index}, so its planned span was kept instead of being stretched.`,
      });
      snappedSegments[index] = segment;
      // Re-base on what the plan will actually play, so later cuts are snapped
      // from reality rather than from a position that never existed.
      cursor = boundary;
      ideal = boundary;
      return;
    }

    if (choice.substituted) substitutedMoments += 1;
    const shift = round(target - boundary);
    totalShift += Math.abs(shift);
    maxShift = Math.max(maxShift, Math.abs(shift));
    snappedCuts += 1;
    shiftByBoundary.set(round(boundary), shift);

    snappedSegments[index] = {
      ...segment,
      sourceStartTime: round(choice.startTime),
      sourceEndTime: round(choice.endTime),
    };
    cursor = target;
  });

  // Text sits at absolute timeline times, so it has to ride with the cuts that
  // were just moved or it drifts off its shot. Audio decisions are deliberately
  // left alone: the music bed defines the grid the cuts were snapped to, and
  // moving it would move the target.
  const textElements = plan.textElements.map((text) => {
    let accumulated = 0;
    for (const [boundary, shift] of shiftByBoundary) {
      if (boundary <= text.startTime + 1e-9) accumulated += shift;
    }
    return accumulated === 0 ? text : { ...text, startTime: round(text.startTime + accumulated) };
  });

  const snappedPlan: EditPlan = { ...plan, segments: snappedSegments, textElements };

  return {
    plan: snappedPlan,
    report: {
      gridSource: grid.source,
      beatPeriodSeconds: beatPeriod,
      subdivisionBeats: unit,
      gridStepSeconds: step,
      offsetSeconds: grid.offsetSeconds,
      totalCuts,
      snappedCuts,
      meanAbsShiftSeconds: snappedCuts > 0 ? totalShift / snappedCuts : 0,
      maxAbsShiftSeconds: maxShift,
      onBeatRatioBefore,
      onBeatRatioAfter: measureTimelineBeatAlignment(snappedPlan, grid, unit),
      substitutedMoments,
      issues,
    },
  };
}
