/**
 * Deterministic reference→plan compiler.
 *
 * This is the "clone a reference edit" mapping path, and it deliberately
 * contains no LLM: the engine's cut evidence is already a shot list, so the
 * job here is arithmetic (reference seconds → source seconds) plus a fixed
 * vocabulary mapping for junctions and camera motion. An LLM in this path
 * re-authors the plan instead of reproducing it.
 */

import type {
  CameraMoveId,
  EditPlan,
  PlannedCameraMove,
  PlannedSegment,
  PlannedTransition,
} from "@kove-advanced/creation-schema";

// ---------------------------------------------------------------------------
// Report shape (what the python engine returns and the registry stashes)
// ---------------------------------------------------------------------------

export interface EngineCutEvidence {
  readonly time?: number;
  readonly confidence?: number;
}

export interface EngineForensicCandidate {
  readonly type?: string;
  readonly startTime?: number;
  readonly endTime?: number;
  readonly confidence?: number;
  readonly evidence?: Record<string, unknown>;
}

export interface EngineReferenceReport {
  readonly analysisVersion?: string;
  readonly videoId?: string;
  readonly role?: string;
  readonly name?: string;
  readonly duration?: number;
  readonly summary?: {
    readonly pacing?: string;
    readonly cutCount?: number;
    readonly cutsPerMinute?: number;
    readonly dominantSceneTypes?: readonly string[];
    readonly dominantMotionLevels?: readonly string[];
    readonly dialogueLed?: boolean;
  };
  readonly styleProfile?: {
    readonly pacing?: string;
    readonly cutsPerMinute?: number;
    readonly medianShotDuration?: number;
    readonly detectedBpm?: number | null;
    readonly confidence?: number;
    readonly [key: string]: unknown;
  };
  readonly editPattern?: {
    readonly cutStyle?: string;
    readonly transitionCount?: number;
    readonly effectCount?: number;
    readonly textOverlayCount?: number;
    readonly colorTreatment?: unknown;
    /** One entry per shot start — the shot skeleton. */
    readonly cutEvidence?: readonly EngineCutEvidence[];
    readonly transitions?: readonly EngineForensicCandidate[];
    readonly effects?: readonly EngineForensicCandidate[];
    readonly textOverlays?: readonly EngineForensicCandidate[];
  };
  readonly audio?: {
    readonly dialogueRatio?: number;
    readonly musicRatio?: number;
    readonly silenceRatio?: number;
    readonly detectedBpm?: number | null;
  };
  readonly forensics?: {
    readonly transitions?: readonly EngineForensicCandidate[];
    readonly effectCandidates?: readonly EngineForensicCandidate[];
    readonly overlayCandidates?: readonly EngineForensicCandidate[];
    readonly [key: string]: unknown;
  };
}

/** A source clip the mirror is allowed to cut from. */
export interface MirrorSource {
  readonly videoId: string;
  readonly durationSec: number;
}

export type FitPolicy = "wrap" | "trim" | "scale";

export interface StructuralDiff {
  /** Compiled shot count equals the reference shot count (tolerance 0). */
  readonly cutCountMatch: boolean;
  /** Largest per-shot duration error, in seconds. */
  readonly maxShotDriftSec: number;
}

export interface MirrorFitContext {
  readonly sources?: readonly MirrorSource[];
  readonly fitPolicy?: FitPolicy;
}

export const MIRROR_GENRE = "reference-mirror";
export const MINIMUM_ANALYSIS_VERSION = "1.2.0";

/** A shot shorter than half a frame is not a shot — it is a cut at the end. */
const MIN_SHOT_SEC = 1 / 120;
/** A motion peak this close to a cut is the cut's whip, not in-shot movement. */
const WHIP_WINDOW_SEC = 0.8;
const DEFAULT_TRANSITION_SEC = 0.4;
/** Optical-flow magnitude that saturates camera-move intensity. */
const FLOW_SATURATION = 12;

// ---------------------------------------------------------------------------
// Version gate
// ---------------------------------------------------------------------------

function versionParts(value: string): number[] {
  return value
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

/**
 * Numeric version compare — never a string compare. "1.10.0" must beat
 * "1.2.0", which `"1.10.0" < "1.2.0"` gets wrong.
 */
export function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

export function atLeast(actual: string | undefined, minimum: string): boolean {
  if (!actual) return false;
  return compareVersions(actual, minimum) >= 0;
}

// ---------------------------------------------------------------------------
// Shot skeleton
// ---------------------------------------------------------------------------

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function numberOr(value: unknown, fallback: number): number {
  return isFiniteNumber(value) ? value : fallback;
}

/**
 * Shot start times. `cutEvidence` is authoritative; without it the detector
 * found nothing, so transitions are used as boundaries and — failing that —
 * the whole clip is one shot.
 */
export function mirrorShotStarts(report: EngineReferenceReport): number[] {
  const evidence = (report.editPattern?.cutEvidence ?? [])
    .map((entry) => entry.time)
    .filter(isFiniteNumber)
    .sort((a, b) => a - b);
  if (evidence.length > 0) return evidence;

  const boundaries = (report.editPattern?.transitions ?? report.forensics?.transitions ?? [])
    .map((candidate) => candidate.startTime)
    .filter(isFiniteNumber)
    .sort((a, b) => a - b);
  return [0, ...boundaries];
}

/** Reference-space shot windows derived from the skeleton. */
function shotWindows(report: EngineReferenceReport): Array<{ start: number; end: number }> {
  const starts = mirrorShotStarts(report);
  const duration = numberOr(report.duration, 0);
  return starts
    .map((start, index) => ({
      start,
      end: index + 1 < starts.length ? starts[index + 1]! : Math.max(start, duration),
    }))
    // A cut sitting on the very end yields a zero-length shot; keeping it
    // would invent a segment the reference does not have.
    .filter((window) => window.end - window.start > MIN_SHOT_SEC);
}

/**
 * Shot durations after the fit policy is applied.
 *
 * - wrap/trim never rescale: shots keep their reference length and the source
 *   either loops or runs out.
 * - scale stretches the whole skeleton so it fits the sources exactly once.
 */
export function fittedShotDurations(
  report: EngineReferenceReport,
  sources: readonly MirrorSource[],
  fitPolicy: FitPolicy,
): number[] {
  const durations = shotWindows(report).map((window) => window.end - window.start);
  if (fitPolicy !== "scale" || durations.length === 0) return durations;

  const total = durations.reduce((sum, value) => sum + value, 0);
  const capacity = sources.reduce(
    (sum, source) => sum + Math.max(0, numberOr(source.durationSec, 0)),
    0,
  );
  if (total <= 0 || capacity <= 0) return durations;
  return durations.map((value) => (value * capacity) / total);
}

// ---------------------------------------------------------------------------
// Junction + motion mapping
// ---------------------------------------------------------------------------

function transitionForType(type: string | undefined): string | null {
  switch (type) {
    case "hard-cut":
      return null;
    case "fade-to-black":
      return "dipToBlack";
    case "unknown-boundary":
      return "crossfade";
    default:
      return null;
  }
}

function motionCandidates(report: EngineReferenceReport): EngineForensicCandidate[] {
  const effects = report.editPattern?.effects ?? report.forensics?.effectCandidates ?? [];
  return effects.filter(
    (candidate) => candidate.type === "camera-motion-or-whip-pan-candidate",
  );
}

function flowOf(candidate: EngineForensicCandidate): number {
  const flow = candidate.evidence?.meanOpticalFlow;
  return isFiniteNumber(flow) ? flow : 0;
}

function directionOf(candidate: EngineForensicCandidate): number {
  const direction = candidate.evidence?.dominantDirection;
  return isFiniteNumber(direction) ? direction : 0;
}

/**
 * Which named move a motion candidate becomes. The direction comes from the
 * optical-flow angle (degrees, y pointing down), so a downward smear is a
 * tilt-down rather than a push.
 */
export function motionMoveFor(candidate: EngineForensicCandidate): CameraMoveId {
  const flow = flowOf(candidate);
  const direction = directionOf(candidate);
  const window =
    isFiniteNumber(candidate.startTime) && isFiniteNumber(candidate.endTime)
      ? Math.abs(candidate.endTime - candidate.startTime)
      : Number.POSITIVE_INFINITY;

  if (flow >= 8) return "whip-shake";
  if (window <= 0.25) return "snap-zoom";
  if (Math.abs(direction) <= 45) return "drift-right";
  if (Math.abs(direction) >= 135) return "drift-left";
  return direction > 0 ? "tilt-down" : "tilt-up";
}

export function motionIntensityFor(candidate: EngineForensicCandidate): number {
  const flow = flowOf(candidate);
  const intensity = flow > 0 ? flow / FLOW_SATURATION : numberOr(candidate.confidence, 0.5);
  return Math.max(0, Math.min(1, intensity));
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

export interface MirrorCompileResult {
  readonly plan: EditPlan;
  /** Reference-space shot windows that survived (one per compiled segment). */
  readonly shots: ReadonlyArray<{ start: number; end: number }>;
}

export function compileMirrorPlan(
  report: EngineReferenceReport,
  sources: readonly MirrorSource[],
  fitPolicy: FitPolicy = "trim",
): EditPlan {
  if (sources.length === 0) {
    throw new Error("build_mirror_plan needs at least one source video.");
  }

  const windows = shotWindows(report);
  const targets = fittedShotDurations(report, sources, fitPolicy);
  const usable = sources.filter((source) => numberOr(source.durationSec, 0) > MIN_SHOT_SEC);
  if (usable.length === 0) {
    throw new Error("build_mirror_plan: every source video has zero duration.");
  }

  const segments: PlannedSegment[] = [];
  const achieved: number[] = [];
  let sourceIndex = 0;
  let offset = 0;
  let looped = false;
  let timeline = 0;

  // Moves to the next source (or back to the first, under "wrap"). Returns
  // false only when the source list is exhausted under "trim".
  const advance = (): boolean => {
    if (sourceIndex + 1 < usable.length) {
      sourceIndex += 1;
      offset = 0;
      return true;
    }
    if (fitPolicy === "wrap") {
      sourceIndex = 0;
      offset = 0;
      looped = true;
      return true;
    }
    return false;
  };

  targets.forEach((want, index) => {
    let available = numberOr(usable[sourceIndex]?.durationSec, 0) - offset;
    if (available <= MIN_SHOT_SEC || available < want) {
      // Shot durations are the thing being reproduced, so a shot that cannot
      // fit in the rest of this source moves to the next one whole rather
      // than being truncated by it.
      if (advance()) available = numberOr(usable[sourceIndex]?.durationSec, 0) - offset;
      // trim: the source ran out, so this shot and the rest are dropped.
      else if (available <= MIN_SHOT_SEC) return;
    }
    if (available <= MIN_SHOT_SEC) return;

    const source = usable[sourceIndex]!;
    // A shot maps to one contiguous span: it is never stitched across a
    // source boundary, so `wrap` loops instead of splicing.
    const take = Math.min(want, available);
    const reference = windows[index];
    segments.push({
      sourceVideoId: source.videoId,
      sourceStartTime: round(offset),
      sourceEndTime: round(offset + take),
      targetPosition: round(timeline),
      effects: [],
      rationale:
        `Shot ${index + 1}/${targets.length} mirrors reference ${report.videoId ?? "?"} ` +
        `${reference ? `${reference.start.toFixed(2)}-${reference.end.toFixed(2)}s` : "?"}` +
        `${looped ? " (looped source span)" : ""}`,
    });
    achieved.push(take);
    offset += take;
    timeline += take;
  });

  if (segments.length === 0) {
    throw new Error(
      "build_mirror_plan: no shot fits the available sources — try fitPolicy \"scale\".",
    );
  }

  const { transitions, cameraMoves } = mapJunctions(report, segments, windows, achieved);

  const videoId = report.videoId ?? "reference";
  return {
    segments: segments.map((segment, index) => {
      const move = cameraMoves.get(index);
      return move ? { ...segment, cameraMoves: [move] } : segment;
    }),
    // v1 has no OCR: inventing captions from edge-density candidates would be
    // a fabrication, so text stays empty and the rationale says why.
    textElements: [],
    effects: [],
    transitions,
    audioDecisions: [],
    metadata: {
      targetDuration: round(segments.reduce((sum, segment) => sum + (segment.sourceEndTime - segment.sourceStartTime), 0)),
      targetPlatform: "social",
      genre: MIRROR_GENRE,
      pacing: mirrorPacing(report),
      rationale:
        `Deterministic mirror of reference ${videoId}; no LLM in mapping path. ` +
        `fitPolicy=${fitPolicy}, ${segments.length}/${targets.length} reference shot(s) mapped. ` +
        "textElements are empty in v1: the engine reports graphic-or-text candidates but no OCR " +
        "is wired up, so no text was invented.",
    },
  };
}

/**
 * Fixed vocabulary mapping for what happens at (and inside) each shot.
 * Boundary-adjacent motion becomes a whipPan transition; mid-shot motion
 * becomes a camera move on the segment.
 */
function mapJunctions(
  report: EngineReferenceReport,
  segments: readonly PlannedSegment[],
  windows: ReadonlyArray<{ start: number; end: number }>,
  achieved: readonly number[],
): {
  transitions: PlannedTransition[];
  cameraMoves: Map<number, PlannedCameraMove>;
} {
  const transitions = new Map<number, PlannedTransition>();
  const cameraMoves = new Map<number, PlannedCameraMove>();

  // 1. Transition evidence → junctions.
  const junctionCandidates =
    report.editPattern?.transitions ?? report.forensics?.transitions ?? [];
  for (const candidate of junctionCandidates) {
    const type = transitionForType(candidate.type);
    if (!type || !isFiniteNumber(candidate.startTime)) continue;
    const index = nearestBoundaryIndex(windows, candidate.startTime);
    if (index === null || index >= segments.length - 1) continue;
    if (transitions.has(index)) continue;
    transitions.set(index, {
      afterSegmentIndex: index,
      type,
      duration: DEFAULT_TRANSITION_SEC,
      rationale: `Reference transition "${candidate.type}" at ${candidate.startTime.toFixed(2)}s mapped to ${type}.`,
    });
  }

  // 2. Motion candidates → whip pan at a boundary, or a move inside the shot.
  for (const candidate of motionCandidates(report)) {
    if (!isFiniteNumber(candidate.startTime)) continue;
    const index = containingShotIndex(windows, candidate.startTime);
    if (index === null || index >= segments.length) continue;

    const window = windows[index]!;
    const toStart = Math.abs(candidate.startTime - window.start);
    const toEnd = Math.abs(window.end - candidate.startTime);
    const nearBoundary = Math.min(toStart, toEnd) <= WHIP_WINDOW_SEC;

    if (nearBoundary) {
      // A whip at the end of a shot is the transition out of it; at the
      // start it is the transition into it.
      const junction = toEnd <= toStart ? index : index - 1;
      if (junction < 0 || junction >= segments.length - 1) continue;
      if (transitions.has(junction)) continue;
      transitions.set(junction, {
        afterSegmentIndex: junction,
        type: "whipPan",
        duration: DEFAULT_TRANSITION_SEC,
        rationale:
          `Camera-motion/whip-pan candidate at ${candidate.startTime.toFixed(2)}s is within ` +
          `${WHIP_WINDOW_SEC}s of a shot boundary (mean optical flow ${flowOf(candidate).toFixed(2)}).`,
      });
      continue;
    }

    if (cameraMoves.has(index)) continue;
    const segmentLength = achieved[index] ?? 0;
    const startInShot = Math.max(0, candidate.startTime - window.start);
    const duration =
      isFiniteNumber(candidate.endTime) && isFiniteNumber(candidate.startTime)
        ? Math.max(0, candidate.endTime - candidate.startTime)
        : 0;
    cameraMoves.set(index, {
      move: motionMoveFor(candidate),
      intensity: round(motionIntensityFor(candidate), 3),
      startTime: round(Math.min(startInShot, Math.max(0, segmentLength - MIN_SHOT_SEC))),
      ...(duration > MIN_SHOT_SEC
        ? { duration: round(Math.min(duration, Math.max(0, segmentLength - startInShot))) }
        : {}),
    } as PlannedCameraMove);
  }

  return {
    transitions: [...transitions.values()].sort(
      (a, b) => a.afterSegmentIndex - b.afterSegmentIndex,
    ),
    cameraMoves,
  };
}

/** Shot whose reference window contains `time` (nearest window as fallback). */
function containingShotIndex(
  windows: ReadonlyArray<{ start: number; end: number }>,
  time: number,
): number | null {
  if (windows.length === 0) return null;
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  windows.forEach((window, index) => {
    const inside = time >= window.start && time < window.end;
    const distance = inside
      ? 0
      : Math.min(Math.abs(time - window.start), Math.abs(time - window.end));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

/** Shot that *ends* nearest `time` — a cut point sits on a shot boundary. */
function nearestBoundaryIndex(
  windows: ReadonlyArray<{ start: number; end: number }>,
  time: number,
): number | null {
  if (windows.length === 0) return null;
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  windows.forEach((window, index) => {
    const distance = Math.abs(window.end - time);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function mirrorPacing(report: EngineReferenceReport): "fast" | "medium" | "slow" {
  const pacing = report.styleProfile?.pacing ?? report.summary?.pacing ?? "medium";
  if (pacing === "fast") return "fast";
  if (pacing === "slow") return "slow";
  return "medium";
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// Structural diff — replaces the plan self-check (F8)
// ---------------------------------------------------------------------------

/**
 * Compares a compiled plan against the engine report it came from. This is a
 * check against evidence, not against the plan's own description of itself.
 *
 * Pass `fit` to measure drift against the fit-scaled targets; without it the
 * raw reference shot durations are used (exact for wrap/trim, which never
 * rescale).
 */
export function structuralDiff(
  plan: EditPlan,
  report: EngineReferenceReport,
  fit: MirrorFitContext = {},
): StructuralDiff {
  const expectedShotCount = (report.editPattern?.cutEvidence ?? []).length;
  const reference = fit.sources
    ? fittedShotDurations(report, fit.sources, fit.fitPolicy ?? "trim")
    : shotWindows(report).map((window) => window.end - window.start);

  let maxShotDriftSec = 0;
  plan.segments.forEach((segment, index) => {
    const actual = Math.max(0, segment.sourceEndTime - segment.sourceStartTime);
    const expected = reference[index];
    if (expected === undefined) return;
    maxShotDriftSec = Math.max(maxShotDriftSec, Math.abs(actual - expected));
  });

  return {
    cutCountMatch: plan.segments.length === expectedShotCount,
    maxShotDriftSec: round(maxShotDriftSec),
  };
}
