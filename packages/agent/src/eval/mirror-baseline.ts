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
  readonly corpusGaps: readonly string[];
}

const CORPUS_GAPS = [
  "No product-ad reference exists in the pool.",
  "Only one collage reference exists (magazine edit); risk 2 stays open.",
  "No independent human shot labels exist for the 10 references; boundary accuracy is unavailable, not estimated.",
] as const;

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
      ],
    },
  };
}

export function aggregateMirrorBaseline(cases: readonly MirrorBaselineCaseReport[]): MirrorBaselineSummary {
  return {
    cases: cases.length,
    refinedCases: cases.filter((entry) => !("status" in entry.refine)).length,
    unavailableRefines: cases.filter((entry) => "status" in entry.refine).length,
    measuredTextCases: cases.filter((entry) => entry.extraction.textStatus === "measured").length,
    unavailableTextCases: cases.filter((entry) => entry.extraction.textStatus === "unavailable").length,
    corpusGaps: CORPUS_GAPS,
  };
}
