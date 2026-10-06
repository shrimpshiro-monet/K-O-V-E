/**
 * Silence & filler removal: compute proposed cut ranges from VAD speech
 * segments + word-level transcription, then compile them into split/delete
 * action plans against the real Clip model.
 *
 * Input shapes (resolved against the actual codebase, not assumed):
 *  - Words: flat `{text, start, end}` seconds, as produced by
 *    apps/web's whisper worker with `timestamps: "word"`
 *    (multicam-transcription.ts → WhisperWord).
 *  - VAD: packages/core's `analyzeSileroVad` returns FRAME-LEVEL
 *    probabilities (MulticamVadTrack), so `segmentSpeechFromProbabilities`
 *    thresholds + segments them here; nothing upstream produced speech
 *    segments, so there was no existing helper to reuse.
 *
 * Timeline mapping (types/timeline.ts Clip): flat {startTime, inPoint,
 * outPoint, speed}. Cut times computed here are SECONDS INTO THE CLIP'S
 * TRIMMED SOURCE REGION (the [inPoint, outPoint] span the audio analysis
 * covers); mapping to the timeline is
 *   timelineTime = clip.startTime + sourceRegionTime / (clip.speed ?? 1)
 * mirroring AutoCaptionPanel's proven mapping. Clips whose timing is not
 * constant-rate (reversed, speed keyframes, freeze frames) are refused with
 * a warning rather than silently desynced.
 */

import type { Clip } from "../types/timeline";
import type { Project } from "../types/project";
import type { Action, ActionResult } from "../types/actions";
import type { MultiCamGroup } from "../video/multicam-engine";
import type { TranscriptWord } from "./highlight-analyzer";
import type { TimeRange } from "./types";

/**
 * Hardcoded filler lexicon (spec step E: settings-store is the API-keys
 * surface, not a per-project preference system — no trivial reuse, so no
 * settings UI in v1). Vocalized pauses only: these are unambiguous
 * disfluencies. Discourse markers ("like", "so", "well") are deliberately
 * excluded — they are real words and deleting them corrupts sentences.
 */
export const FILLER_LEXICON: readonly string[] = [
  "um",
  "uh",
  "er",
  "ah",
  "hmm",
  "hm",
  "mhm",
  "mm",
  "huh",
  "uh-huh",
  "mm-hmm",
  "umm",
  "uhh",
  "err",
];

export type { TranscriptWord } from "./highlight-analyzer";
export type { TimeRange } from "./types";

export interface VadSegmentationOptions {
  /** Probability at/above which a frame counts as speech. */
  readonly speechThreshold?: number;
  /** Merge speech runs separated by less than this many ms. */
  readonly mergeGapMs?: number;
  /** Drop speech runs shorter than this many ms (noise blips). */
  readonly minSpeechMs?: number;
}

/**
 * Thresholds + segments VAD frame probabilities into speech ranges.
 * `windowMs` is the per-frame duration from MulticamVadTrack.
 */
export function segmentSpeechFromProbabilities(
  probabilities: ArrayLike<number>,
  windowMs: number,
  options: VadSegmentationOptions = {},
): TimeRange[] {
  const threshold = options.speechThreshold ?? 0.5;
  const mergeGapMs = options.mergeGapMs ?? 80;
  const minSpeechMs = options.minSpeechMs ?? 120;
  if (!(windowMs > 0) || probabilities.length === 0) return [];

  const windowSec = windowMs / 1000;
  const segments: TimeRange[] = [];
  let runStart: number | null = null;

  const closeRun = (endSec: number): void => {
    if (runStart === null) return;
    if ((endSec - runStart) * 1000 >= minSpeechMs) {
      segments.push({ start: runStart, end: endSec });
    }
    runStart = null;
  };

  for (let i = 0; i < probabilities.length; i += 1) {
    const isSpeech = (probabilities[i] ?? 0) >= threshold;
    if (isSpeech && runStart === null) {
      runStart = i * windowSec;
    } else if (!isSpeech && runStart !== null) {
      // Lookahead: small gaps stay inside the run (breaths, plosive dips).
      let gapFrames = 0;
      let j = i;
      while (j < probabilities.length && (probabilities[j] ?? 0) < threshold) {
        gapFrames += 1;
        j += 1;
      }
      const gapMs = gapFrames * windowMs;
      if (j < probabilities.length && gapMs < mergeGapMs) {
        i = j - 1; // continue the run past the gap
      } else {
        closeRun(i * windowSec);
      }
    }
  }
  closeRun(probabilities.length * windowSec);
  return segments;
}

/** Gaps between speech ranges (and at the edges) longer than minSilenceSec. */
export function computeSilenceRanges(
  speech: readonly TimeRange[],
  totalDurationSec: number,
  minSilenceSec: number,
): TimeRange[] {
  const silences: TimeRange[] = [];
  let cursor = 0;
  for (const range of speech) {
    const start = Math.max(cursor, Math.min(range.start, totalDurationSec));
    if (start - cursor >= minSilenceSec) {
      silences.push({ start: cursor, end: start });
    }
    cursor = Math.max(cursor, Math.min(range.end, totalDurationSec));
  }
  if (totalDurationSec - cursor >= minSilenceSec) {
    silences.push({ start: cursor, end: totalDurationSec });
  }
  return silences;
}

function normalizeFiller(text: string): string {
  return text.trim().toLowerCase().replace(/[^a-z-]/g, "");
}

/** Exact-match filler words (normalized). Words with neighbors are fine to cut — the ranges stitch. */
export function detectFillerWords(
  words: readonly TranscriptWord[],
  lexicon: readonly string[] = FILLER_LEXICON,
): TranscriptWord[] {
  const known = new Set(lexicon.map((entry) => normalizeFiller(entry)));
  return words.filter((word) => known.has(normalizeFiller(word.text)));
}

export type CutReason = "silence" | "filler";

export interface ProposedCut extends TimeRange {
  readonly id: string;
  readonly reason: CutReason;
  /** Human label for the review UI ("0.8s silence", "filler “um”"). */
  readonly label: string;
}

export interface CutRangeOptions {
  /** Silences longer than this become cuts (seconds). */
  readonly maxSilenceSec?: number;
  /** Never propose cuts shorter than this (seconds). */
  readonly minCutSec?: number;
  /** Natural pause kept at each side of a silence cut (seconds). */
  readonly keepPaddingSec?: number;
  readonly removeFillers?: boolean;
  readonly fillerLexicon?: readonly string[];
}

export const DEFAULT_CUT_OPTIONS: Required<CutRangeOptions> = {
  maxSilenceSec: 0.6,
  minCutSec: 0.15,
  keepPaddingSec: 0.12,
  removeFillers: true,
  fillerLexicon: FILLER_LEXICON,
};

/** Merge overlapping/adjacent cuts, sorted by start. */
function mergeCutRanges(
  cuts: Array<{ start: number; end: number; reason: CutReason; label: string }>,
): Array<{ start: number; end: number; reason: CutReason; label: string }> {
  const sorted = [...cuts].sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number; reason: CutReason; label: string }> = [];
  for (const cut of sorted) {
    const last = merged[merged.length - 1];
    if (last && cut.start <= last.end + 1e-3) {
      const combinedReason: CutReason =
        last.reason !== cut.reason ? "silence" : last.reason;
      merged[merged.length - 1] = {
        start: last.start,
        end: Math.max(last.end, cut.end),
        reason: combinedReason,
        label:
          last.reason === cut.reason
            ? last.label
            : `${last.label} + ${cut.label}`,
      };
    } else {
      merged.push({ ...cut });
    }
  }
  return merged;
}

/**
 * The main computation: speech ranges + optional words → proposed cuts,
 * all in SECONDS INTO THE CLIP'S TRIMMED SOURCE REGION.
 */
export function computeCutRanges(input: {
  speechSegments: readonly TimeRange[];
  totalDurationSec: number;
  words?: readonly TranscriptWord[];
  options?: CutRangeOptions;
}): ProposedCut[] {
  const opts = { ...DEFAULT_CUT_OPTIONS, ...input.options };
  const total = Math.max(0, input.totalDurationSec);
  const raw: Array<{ start: number; end: number; reason: CutReason; label: string }> = [];

  for (const silence of computeSilenceRanges(
    input.speechSegments,
    total,
    opts.maxSilenceSec,
  )) {
    const start = Math.min(silence.start + opts.keepPaddingSec, silence.end);
    const end = Math.max(silence.end - opts.keepPaddingSec, start);
    if (end - start < opts.minCutSec) continue;
    raw.push({
      start,
      end,
      reason: "silence",
      label: `${(end - start).toFixed(1)}s silence`,
    });
  }

  if (opts.removeFillers && input.words) {
    for (const filler of detectFillerWords(input.words, opts.fillerLexicon)) {
      const start = Math.max(0, filler.start);
      const end = Math.min(total, filler.end);
      if (end - start < opts.minCutSec) continue;
      raw.push({
        start,
        end,
        reason: "filler",
        label: `filler “${filler.text.trim()}”`,
      });
    }
  }

  return mergeCutRanges(raw).map((cut, index) => ({
    ...cut,
    id: `cut-${index}-${cut.start.toFixed(3)}`,
  }));
}

// ---- Clip support + action planning ----------------------------------------

export interface CutPlanWarning {
  readonly code:
    | "unsupported-clip"
    | "multicam-sync"
    | "cut-out-of-range"
    | "no-cuts";
  readonly message: string;
}

/** Clip id the rippleDelete should target for one cut. */
export type CutDeleteResolution = "by-bounds";

export interface PlannedCutOps {
  readonly cut: ProposedCut;
  /** Timeline times (absolute) of this cut after mapping through speed. */
  readonly timelineStart: number;
  readonly timelineEnd: number;
  /** Split times to execute in order (absolute timeline seconds). */
  readonly splits: readonly number[];
  /**
   * How to find the isolated piece at execution time. The executor only
   * resolves `__LAST_ADDED__` while replaying UNDO actions, so forward ops
   * must look the piece up by its bounds in the live project after the
   * splits land (see executeCutPlan).
   */
  readonly deleteResolution: CutDeleteResolution;
}

export interface ClipCutPlan {
  readonly clipId: string;
  readonly supported: boolean;
  readonly ops: readonly PlannedCutOps[];
  readonly warnings: readonly CutPlanWarning[];
}

/**
 * Why a clip may not be constant-rate-mapped. Speed keyframes, freeze frames
 * and reversed playback all make `startTime + t/speed` wrong — refuse instead
 * of desyncing.
 */
export function clipTimingLimitation(clip: Clip): string | null {
  if (clip.reversed) return "the clip is reversed";
  if (clip.speedKeyframes && clip.speedKeyframes.length > 0) {
    return "the clip has speed keyframes (variable rate)";
  }
  if (clip.freezeFrames && clip.freezeFrames.length > 0) {
    return "the clip has freeze frames";
  }
  return null;
}

/**
 * Compiles selected cuts into an executable op plan.
 *
 * Ordering: cuts are processed RIGHT-TO-LEFT. For each cut: split at its end
 * boundary (unless it already ends at the clip's edge), split at its start
 * boundary (unless it starts at the clip's edge), then ripple-delete the
 * piece just isolated — found by its bounds in the live timeline (the
 * executor's __LAST_ADDED__ marker only resolves during undo replay, so
 * forward deletes must look the piece up at runtime). Because every delete
 * only ripples clips to its RIGHT and cuts are handled right-to-left, each
 * remaining split time and boundary lookup stays valid.
 */
export function planClipCuts(
  clip: Clip,
  cuts: readonly ProposedCut[],
  selected: ReadonlySet<string> = new Set(cuts.map((cut) => cut.id)),
): ClipCutPlan {
  const warnings: CutPlanWarning[] = [];
  const limitation = clipTimingLimitation(clip);
  if (limitation) {
    return {
      clipId: clip.id,
      supported: false,
      ops: [],
      warnings: [
        {
          code: "unsupported-clip",
          message: `Cuts skipped: ${limitation}; timeline-time mapping would desync.`,
        },
      ],
    };
  }

  const speed = Math.max(clip.speed ?? 1, 0.01);
  const regionDuration = clip.duration * speed; // source seconds covered by the clip
  const selectedCuts = cuts
    .filter((cut) => selected.has(cut.id))
    .filter((cut) => {
      const inRange = cut.start >= -1e-3 && cut.end <= regionDuration + 1e-3 && cut.end > cut.start;
      if (!inRange) {
        warnings.push({
          code: "cut-out-of-range",
          message: `Cut ${cut.label} lies outside the clip's source region and was skipped.`,
        });
      }
      return inRange;
    })
    .sort((a, b) => b.start - a.start); // right-to-left

  const ops: PlannedCutOps[] = [];
  for (const cut of selectedCuts) {
    const startSec = Math.max(0, cut.start);
    const endSec = Math.min(regionDuration, cut.end);
    const timelineStart = clip.startTime + startSec / speed;
    const timelineEnd = clip.startTime + endSec / speed;

    const splits: number[] = [];
    const endsAtEdge = Math.abs(timelineEnd - (clip.startTime + clip.duration)) < 1e-3;
    const startsAtEdge = Math.abs(timelineStart - clip.startTime) < 1e-3;
    if (!endsAtEdge) splits.push(timelineEnd);
    if (!startsAtEdge) splits.push(timelineStart);

    ops.push({
      cut,
      timelineStart,
      timelineEnd,
      splits,
      deleteResolution: "by-bounds",
    });
  }

  if (ops.length === 0 && warnings.length === 0) {
    warnings.push({ code: "no-cuts", message: "No cuts selected." });
  }

  return { clipId: clip.id, supported: true, ops, warnings };
}

/**
 * Multicam guard (spec step D): v1 does NOT ripple cuts across synced angles.
 * Returns the group when the clip's track is a multicam output track or its
 * media belongs to a group angle, so the UI can warn instead of silently
 * desyncing siblings.
 */
export function findMulticamGroupForClip(
  project: Project,
  clip: Clip,
): MultiCamGroup | null {
  const groups = project.multicamGroups ?? [];
  for (const group of groups) {
    const outputTracks = new Set(
      group.outputTrackIds ?? (group.outputTrackId ? [group.outputTrackId] : []),
    );
    if (outputTracks.has(clip.trackId)) return group;
    if (
      group.angles.some(
        (angle) => angle.clipId === clip.id || angle.trackId === clip.trackId,
      )
    ) {
      return group;
    }
  }
  return null;
}

// ---- Execution --------------------------------------------------------------

export interface ActionExecuting {
  execute(action: Action, project: Project): Promise<ActionResult>;
}

export interface CutPlanExecution {
  readonly ok: boolean;
  readonly cutsDeleted: number;
  readonly error?: string;
}

const BOUNDS_EPSILON = 1e-3;

/**
 * Executes a ClipCutPlan against the live project through any ActionExecutor.
 * For every cut (already ordered right-to-left by planClipCuts): run the
 * splits, look the isolated piece up by its timeline bounds, ripple-delete
 * it. Callers wrap this in their history group (beginGroup/endGroup or the
 * host transaction) so the whole removal is ONE undo step.
 */
export async function executeCutPlan(
  executor: ActionExecuting,
  project: Project,
  clipId: string,
  plan: ClipCutPlan,
): Promise<CutPlanExecution> {
  if (!plan.supported) {
    return {
      ok: false,
      cutsDeleted: 0,
      error: plan.warnings[0]?.message ?? "Clip does not support cut mapping.",
    };
  }

  const clip = project.timeline.tracks
    .flatMap((track) => track.clips)
    .find((candidate) => candidate.id === clipId);
  if (!clip) return { ok: false, cutsDeleted: 0, error: "Clip not found." };
  const trackId = clip.trackId;

  let seq = 0;
  const makeAction = (type: string, params: Record<string, unknown>): Action =>
    ({
      id: `silence-removal-${Date.now()}-${seq++}`,
      type,
      params,
      timestamp: Date.now(),
    }) as unknown as Action;

  let deleted = 0;
  for (const op of plan.ops) {
    for (const splitTime of op.splits) {
      const result = await executor.execute(
        makeAction("clip/split", { clipId, time: splitTime }),
        project,
      );
      if (!result.success) {
        return { ok: false, cutsDeleted: deleted, error: result.error?.message ?? "Split failed." };
      }
    }

    const track = project.timeline.tracks.find((candidate) => candidate.id === trackId);
    const piece = track?.clips.find(
      (candidate) =>
        Math.abs(candidate.startTime - op.timelineStart) < BOUNDS_EPSILON &&
        Math.abs(candidate.duration - (op.timelineEnd - op.timelineStart)) < BOUNDS_EPSILON,
    );
    if (!piece) {
      return {
        ok: false,
        cutsDeleted: deleted,
        error: `Lost track of the cut piece at ${op.timelineStart.toFixed(3)}s — aborting before further edits.`,
      };
    }

    const result = await executor.execute(
      makeAction("clip/rippleDelete", { clipId: piece.id }),
      project,
    );
    if (!result.success) {
      return { ok: false, cutsDeleted: deleted, error: result.error?.message ?? "Ripple delete failed." };
    }
    deleted += 1;
  }

  return { ok: true, cutsDeleted: deleted };
}
