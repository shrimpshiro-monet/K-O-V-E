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
  /**
   * The frame rate this plan will be rendered at, when the caller knows it.
   *
   * A cut cannot reach the file between frames: the renderer shows frame `k` for
   * every time in `[k/fps, (k+1)/fps)`, so a cut planned at an arbitrary instant
   * is served by the *next* frame — up to a whole frame late, median half a
   * frame (22 ms at 25 fps, which is over half the 40 ms tolerance the edit is
   * measured with). Supplying the rate here puts each cut on the nearest frame
   * boundary instead, so the file plays when the plan says it does.
   *
   * Omitted means no frame grid is applied and cuts keep the behaviour they had.
   * There is deliberately no default: guessing 30 fps for a 25 fps render would
   * move every cut in the wrong direction, silently.
   */
  readonly fps?: number;
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
  /** The unit the reference's own cutting implies (the requested unit). */
  readonly subdivisionBeats: number;
  /** Seconds per step of that unit: `beatPeriodSeconds * subdivisionBeats`. */
  readonly gridStepSeconds: number;
  /**
   * The finest unit any cut actually needed, or null when every cut was
   * expressible in `subdivisionBeats`.
   *
   * Refinement is per cut: a shot too short to hold the requested step pulls
   * only the cuts on either side of it onto a finer lattice.
   */
  readonly refinedSubdivisionBeats: number | null;
  /** How many cuts used a finer lattice than `subdivisionBeats`. */
  readonly refinedCuts: number;
  readonly offsetSeconds: number;
  readonly totalCuts: number;
  readonly snappedCuts: number;
  readonly meanAbsShiftSeconds: number;
  readonly maxAbsShiftSeconds: number;
  /**
   * Cuts within {@link BEAT_TOLERANCE_SECONDS} of the unit the *reference*
   * implies, before and after — not of whatever lattice this pass happened to
   * place them on.
   *
   * Measuring against the lattice the pass chose makes the ratio an identity:
   * cuts placed on quarter beats measure as 100% on-grid even when the
   * reference, and every other metric, cut on the beat.
   */
  readonly onBeatRatioBefore: number | null;
  readonly onBeatRatioAfter: number | null;
  readonly substitutedMoments: number;
  /**
   * The frame rate the cuts were aligned to, or null when no frame grid was
   * applied — because none was supplied, or because there was no beat grid to
   * snap onto in the first place.
   */
  readonly fps: number | null;
  /** Cuts this pass placed on a frame boundary. */
  readonly frameAlignedCuts: number;
  /**
   * How far the frame boundary moved a cut, on top of the beat snap, in seconds.
   * At most half a frame; the point of the number is that it is visible.
   */
  readonly meanAbsFrameShiftSeconds: number;
  readonly maxAbsFrameShiftSeconds: number;
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
 * How far *below* a frame boundary a cut is planted.
 *
 * The renderer starts a clip at the first frame whose time reaches the cut
 * (`start <= k/fps`), so a cut placed exactly *on* the boundary is at the mercy
 * of floating-point summation: the plan's cut positions are the running sum of
 * `sourceEndTime - sourceStartTime`, and a sum one ulp above the boundary costs
 * a whole frame — 40 ms at 25 fps. One microsecond below is invisible (0.0025%
 * of a frame at 25 fps), and it survives both that summation and any downstream
 * rounding to microseconds. So the frame a cut is planned on is the frame the
 * viewer sees it on, whatever the renderer's tie-breaking convention is.
 *
 * The guards add up: cut k sits (k x 1us) early, which is 0.06 ms by the
 * hundredth cut. Below the noise floor of every metric here.
 */
const FRAME_GUARD_SECONDS = 1e-6;

/**
 * A frame rate worth aligning to, or null when the caller gave us nothing usable.
 *
 * Bounded at 1000 fps so a units mix-up (24000 for ms-per-frame, say) cannot
 * quietly move every cut.
 */
function resolveFrameRate(fps: number | undefined): number | null {
  if (fps === undefined || !Number.isFinite(fps) || fps <= 0 || fps > 1000) return null;
  return fps;
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
 *
 * With `options.fps` set, each cut is then placed on the nearest frame boundary,
 * because a cut planned between frames is played by the *next* one. The frame
 * grid never overrides the beat grid: half a frame is the most it can move a cut
 * (20 ms at 25 fps, inside the 40 ms tolerance the plan is measured with), so
 * which beat a cut lands on is decided above, and this only decides the exact
 * instant within it.
 */
export function snapPlanToBeatGrid(
  plan: EditPlan,
  segmentMap?: SegmentMap,
  options: BeatSnapOptions = {},
): BeatSnapResult {
  const issues: BeatSnapIssue[] = [];
  const grid = resolveTimelineBeatGrid(plan, segmentMap, options);
  const frameFps = resolveFrameRate(options.fps);
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
        refinedSubdivisionBeats: null,
        refinedCuts: 0,
        offsetSeconds: options.cutOffsetSeconds ?? 0,
        totalCuts: Math.max(0, plan.segments.length - 1),
        snappedCuts: 0,
        meanAbsShiftSeconds: 0,
        maxAbsShiftSeconds: 0,
        onBeatRatioBefore,
        onBeatRatioAfter: onBeatRatioBefore,
        substitutedMoments: 0,
        // No grid means no cut was moved, so there is nothing for a frame grid to
        // align either. Frame alignment rides with the beat snap: a plan with no
        // beats is left exactly as the director wrote it.
        fps: null,
        frameAlignedCuts: 0,
        meanAbsFrameShiftSeconds: 0,
        maxAbsFrameShiftSeconds: 0,
        issues,
      },
    };
  }

  const beatPeriod = grid.beatPeriodSeconds;

  // The unit is chosen **per cut**, from the two shots it joins, rather than
  // once for the whole plan. Chosen globally it was decided by the *shortest*
  // span anywhere in the plan, so one anomalous sliver — 0.03s against a 0.86s
  // median shot — dropped every cut in a 24s edit onto quarter beats, and an
  // edit whose reference cuts on the beat went out cutting on the nearest
  // 16th. A cut needs the finer lattice only when its own shots are too short
  // to hold a coarser step; otherwise going finer is pure harm, because every
  // coarse point is still on the finer lattice and the nearest-point search
  // will happily prefer the off-beat one.
  const unitForShot = (shotDuration: number): number => {
    if (!(beatPeriod > 0)) return requestedUnit;
    for (const candidate of BEAT_SUBDIVISIONS) {
      if (candidate > requestedUnit) continue;
      if (beatPeriod * candidate <= shotDuration + 1e-9) return candidate;
    }
    return BEAT_SUBDIVISIONS[BEAT_SUBDIVISIONS.length - 1]!;
  };
  const pointsByUnit = new Map<number, number[]>();
  const pointsForUnit = (unitValue: number): number[] => {
    const cached = pointsByUnit.get(unitValue);
    if (cached) return cached;
    const points = beatGridPoints(grid, unitValue);
    pointsByUnit.set(unitValue, points);
    return points;
  };
  // Tracked so the report can say the plan was refined, and by how much.
  let refinedUnit: number | null = null;
  let refinedCuts = 0;

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
  let frameAlignedCuts = 0;
  let frameShiftTotal = 0;
  let frameShiftMax = 0;

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

    // The next shot constrains this cut only when it continues the chain: a
    // layer or an anchored segment starts wherever the director put it, so its
    // length says nothing about where this cut belongs.
    const nextPlanned = positions[index + 1];
    const nextDuration =
      nextPlanned !== undefined && Math.abs(nextPlanned - plannedEnd) <= 1e-6
        ? (durations[index + 1] ?? duration)
        : duration;
    const localUnit = Math.min(unitForShot(duration), unitForShot(nextDuration));
    const localPoints = pointsForUnit(localUnit);
    if (localUnit < requestedUnit) {
      refinedCuts += 1;
      refinedUnit = refinedUnit === null ? localUnit : Math.min(refinedUnit, localUnit);
    }

    let target = nearestGridPoint(localPoints, ideal);
    // Keep the shot positive; a snap may not collapse it.
    if (target <= cursor + 1e-6) {
      target = localPoints.find((point) => point > cursor + 1e-6) ?? target;
    }

    // The beat lattice decides *which* beat; the frame grid decides the exact
    // instant within it. Half a frame is the most this can move a cut — 20 ms at
    // 25 fps, inside the 40 ms tolerance the plan is measured with — so it
    // refines the decision above rather than replacing it.
    let frameShift = 0;
    if (frameFps !== null) {
      const beatTarget = target;
      let frameTarget = Math.round(beatTarget * frameFps) / frameFps;
      if (frameTarget <= cursor + FRAME_GUARD_SECONDS) {
        // That frame is too close to the previous cut to leave a shot between
        // them. The next boundary that does leave one wins: a one-frame shot
        // renders, a zero-frame shot does not.
        frameTarget = Math.ceil((cursor + FRAME_GUARD_SECONDS) * frameFps + 1e-9) / frameFps;
      }
      frameShift = Math.abs(frameTarget - beatTarget);
      target = frameTarget;
    }

    // Aligned cuts are stored at full precision on purpose: the guard above is
    // worth nothing if the span it lives in gets rounded to the nearest
    // microsecond afterwards.
    const snappedDuration =
      frameFps === null ? round(target - cursor) : target - cursor - FRAME_GUARD_SECONDS;

    if (!(snappedDuration > 1e-6)) {
      issues.push({
        segmentIndex: index,
        code: "short_of_one_subdivision",
        message: `Shot ${index} is shorter than one grid step (${(beatPeriod * localUnit).toFixed(3)}s), so its cut was left where it was.`,
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

    if (frameFps !== null) {
      frameAlignedCuts += 1;
      frameShiftTotal += frameShift;
      frameShiftMax = Math.max(frameShiftMax, frameShift);
      snappedSegments[index] = {
        ...segment,
        sourceStartTime: choice.startTime,
        sourceEndTime: choice.endTime,
      };
      // Advance by the geometry the renderer will actually walk — the running
      // sum of `sourceEndTime - sourceStartTime` — not by the position this pass
      // meant to reach. The two differ by a rounding error per shot (the span is
      // `start + duration`, and the plan subtracts them again), and the next cut
      // has to be measured from where the plan really ends or the guard stops
      // holding on exactly the cuts it exists for.
      cursor += choice.endTime - choice.startTime;
    } else {
      snappedSegments[index] = {
        ...segment,
        sourceStartTime: round(choice.startTime),
        sourceEndTime: round(choice.endTime),
      };
      cursor = target;
    }
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
      subdivisionBeats: requestedUnit,
      gridStepSeconds: beatPeriod * requestedUnit,
      refinedSubdivisionBeats: refinedUnit,
      refinedCuts,
      offsetSeconds: grid.offsetSeconds,
      totalCuts,
      snappedCuts,
      meanAbsShiftSeconds: snappedCuts > 0 ? totalShift / snappedCuts : 0,
      maxAbsShiftSeconds: maxShift,
      onBeatRatioBefore,
      // Measured at the reference's unit, not at whatever lattice a short shot
      // forced this cut onto — otherwise the number is a tautology.
      onBeatRatioAfter: measureTimelineBeatAlignment(snappedPlan, grid, requestedUnit),
      substitutedMoments,
      fps: frameFps,
      frameAlignedCuts,
      meanAbsFrameShiftSeconds: frameAlignedCuts > 0 ? frameShiftTotal / frameAlignedCuts : 0,
      maxAbsFrameShiftSeconds: frameShiftMax,
      issues,
    },
  };
}
