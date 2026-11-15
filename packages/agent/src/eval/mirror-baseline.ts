import type { Project } from "@kove-advanced/core/types/project";
import type { RefineKnobs } from "../director/mirror/refine-mirror";

export type MirrorMetricStatus = "measured" | "unavailable";

export interface MirrorBaselineDecodePath {
  readonly kind: "native" | "h264-proxy";
  readonly codec: string;
  readonly proxy?: string;
  readonly proxySha256?: string;
  readonly reason?: string;
}

export interface MirrorBaselineMedia {
  readonly width: number;
  readonly height: number;
  readonly fps: { readonly num: number; readonly den: number };
  readonly durationFrames: number;
  readonly streamStartSeconds?: number;
}

export interface MirrorBaselineExtraction {
  readonly backend: string;
  readonly shotCount: number;
  readonly boundariesFrames: readonly number[];
  readonly cameraClasses: Readonly<Record<string, number>>;
  readonly transitionCount: number;
  readonly eventCount: number;
  readonly cameraShotCount: number;
  readonly elapsedMs: number;
  readonly warnings: readonly string[];
  readonly textStatus: MirrorMetricStatus;
  readonly textReason: string;
  readonly watermarkMasking: "applied" | "unknown";
  readonly endCardTrimmedFrames?: number;
}

export interface MirrorBaselineCompile {
  readonly shotItemIds: readonly string[];
  readonly rhythmScore: number;
  readonly colorApplied: boolean;
  readonly text: {
    readonly clipIds: readonly string[];
    readonly skippedLowConfidence: number;
    readonly skippedEmpty: number;
    readonly skippedWatermarkRegions: number;
    readonly unsupportedHost: boolean;
    readonly warnings: readonly string[];
  };
}

export interface MirrorBaselineRefine {
  readonly bestKnobs: RefineKnobs;
  readonly bestScore: number;
  readonly bestSsim: number;
  readonly rhythmScore: number;
  readonly trials: number;
  readonly history: readonly number[];
  readonly sampleFrames: readonly number[];
  readonly fps: { readonly num: number; readonly den: number };
}

export interface MirrorBeatAlignment {
  readonly status: MirrorMetricStatus;
  readonly cutCount: number;
  readonly beatCount: number;
  readonly meanAbsoluteErrorMs?: number;
  readonly medianAbsoluteErrorMs?: number;
  readonly maxAbsoluteErrorMs?: number;
  readonly reason?: string;
}

export interface MirrorCrossRestyleReport {
  readonly id: string;
  readonly styleProfileId: string;
  readonly styleSource: string;
  readonly styleSourceSha256: string;
  readonly heldOutProfileId: string;
  readonly heldOutSource: string;
  readonly heldOutSourceSha256: string;
  readonly compile: MirrorBaselineCompile;
  readonly beatAlignment: MirrorBeatAlignment;
  readonly basis: {
    readonly compile: "held-out-cross-restyle";
    readonly refine: "not-scored";
    readonly notes: readonly string[];
  };
}

export interface MirrorBaselineInput {
  readonly id: string;
  readonly styleFamily: string;
  readonly source: string;
  readonly sourceSha256: string;
  readonly decodePath: MirrorBaselineDecodePath;
  readonly media: MirrorBaselineMedia;
  readonly clockProvenance: "external-ffprobe-manifest";
  readonly extraction: MirrorBaselineExtraction;
  readonly compile: MirrorBaselineCompile;
  readonly beatAlignment: MirrorBeatAlignment;
  readonly refine: MirrorBaselineRefine | { readonly status: "unavailable"; readonly reason: string };
}

export interface MirrorBaselineCaseReport extends MirrorBaselineInput {
  readonly basis: {
    readonly compile: "reference-self-reconstruction";
    readonly refine: "64x64-luma-ssim-plus-duration-dtw";
    readonly fidelity: MirrorMetricStatus;
    readonly lpips: MirrorMetricStatus;
    readonly textWindows: MirrorMetricStatus;
    readonly notes: readonly string[];
  };
}

export interface MirrorBaselineSummary {
  readonly cases: number;
  readonly refinedCases: number;
  readonly unavailableRefines: number;
  readonly measuredTextCases: number;
  readonly unavailableTextCases: number;
  readonly measuredBeatAlignmentCases: number;
  readonly meanBeatAlignmentErrorMs?: number;
  readonly corpusGaps: readonly string[];
}

const CORPUS_GAPS = [
  "No product-ad reference exists in the pool.",
  "Only one collage reference exists (magazine edit); risk 2 stays open.",
  "No independent human shot labels exist for the 10 references; boundary accuracy is unavailable, not estimated.",
] as const;

function nearestDistance(value: number, sorted: readonly number[]): number {
  let low = 0;
  let high = sorted.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (sorted[mid]! < value) low = mid + 1;
    else high = mid;
  }
  let distance = Math.abs(value - sorted[low]!);
  if (low > 0) distance = Math.min(distance, Math.abs(value - sorted[low - 1]!));
  return distance;
}

/** Mean distance from each compiled cut to the nearest beat, in milliseconds. */
export function measureBeatAlignment(
  cutTimesMs: readonly number[],
  beatTimesMs: readonly number[],
): MirrorBeatAlignment {
  const cuts = cutTimesMs.filter((value) => Number.isFinite(value));
  const beats = beatTimesMs.filter((value) => Number.isFinite(value)).slice().sort((a, b) => a - b);
  if (cuts.length === 0) {
    return { status: "unavailable", cutCount: 0, beatCount: beats.length, reason: "The compiled timeline has no cuts to align." };
  }
  if (beats.length === 0) {
    return { status: "unavailable", cutCount: cuts.length, beatCount: 0, reason: "The reference beat grid is empty." };
  }
  const errors = cuts.map((cut) => nearestDistance(cut, beats)).sort((a, b) => a - b);
  const middle = Math.floor(errors.length / 2);
  return {
    status: "measured",
    cutCount: cuts.length,
    beatCount: beats.length,
    meanAbsoluteErrorMs: errors.reduce((total, error) => total + error, 0) / errors.length,
    medianAbsoluteErrorMs: errors.length % 2 === 0
      ? (errors[middle - 1]! + errors[middle]!) / 2
      : errors[middle]!,
    maxAbsoluteErrorMs: errors[errors.length - 1]!,
  };
}

/** Start times of the compiled shot clips, excluding the opening clip. */
export function compiledCutTimesMs(
  project: Pick<Project, "timeline">,
  shotItemIds: readonly string[],
): number[] {
  const ids = new Set(shotItemIds);
  const clips = project.timeline.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => ids.has(clip.id))
    .sort((a, b) => a.startTime - b.startTime);
  return clips.slice(1).map((clip) => clip.startTime * 1000);
}

export function assembleMirrorBaselineReport(input: MirrorBaselineInput): MirrorBaselineCaseReport {
  const refined = "status" in input.refine ? false : true;
  const measuredCamera = input.extraction.cameraShotCount > 0;
  return {
    ...input,
    basis: {
      compile: "reference-self-reconstruction",
      refine: "64x64-luma-ssim-plus-duration-dtw",
      fidelity: "unavailable",
      lpips: "unavailable",
      textWindows: input.extraction.textStatus,
      notes: [
        "The reference is compiled onto itself to measure how much of the measured edit the current pipeline can rebuild; this is not a cross-footage generalization score.",
        refined
          ? "Refine scores are real 64x64 luma SSIM and duration-pattern DTW from rendered frames; LPIPS has no model and is labeled unavailable."
          : "Refine is unavailable because the host did not provide a reference decoder and timeline compositor.",
        measuredCamera
          ? "Camera classes come from the extraction's measured motion samples."
          : "No camera evidence was measured for this reference.",
        input.extraction.textStatus === "measured"
          ? "Text windows were measured."
          : `Text windows are unavailable: ${input.extraction.textReason}`,
        "Boundary and camera accuracy against human labels are unavailable: only the synthetic corpus case carries verified labels.",
        "The beat grid was measured from the reference audio by the baseline's local beat-detection pass.",
        input.beatAlignment.status === "measured"
          ? `Beat-alignment error is the mean distance from each compiled cut to the nearest reference beat (${Math.round(input.beatAlignment.meanAbsoluteErrorMs!)} ms).`
          : `Beat alignment is unavailable: ${input.beatAlignment.reason}`,
      ],
    },
  };
}

export function aggregateMirrorBaseline(cases: readonly MirrorBaselineCaseReport[]): MirrorBaselineSummary {
  const measuredBeatErrors = cases
    .map((entry) => entry.beatAlignment)
    .filter((entry) => entry?.status === "measured" && entry.meanAbsoluteErrorMs !== undefined)
    .map((entry) => entry.meanAbsoluteErrorMs!);
  return {
    cases: cases.length,
    refinedCases: cases.filter((entry) => !("status" in entry.refine)).length,
    unavailableRefines: cases.filter((entry) => "status" in entry.refine).length,
    measuredTextCases: cases.filter((entry) => entry.extraction.textStatus === "measured").length,
    unavailableTextCases: cases.filter((entry) => entry.extraction.textStatus === "unavailable").length,
    measuredBeatAlignmentCases: measuredBeatErrors.length,
    ...(measuredBeatErrors.length > 0 && {
      meanBeatAlignmentErrorMs: measuredBeatErrors.reduce((total, error) => total + error, 0) / measuredBeatErrors.length,
    }),
    corpusGaps: CORPUS_GAPS,
  };
}
