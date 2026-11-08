import type { SegmentMap } from "@kove-advanced/creation-schema";

/**
 * Per-turn tool-execution context.
 *
 * A "turn" is one `runTurn` invocation (the main chat turn, a subagent turn, a
 * headless turn). The context is created by runTurn, threaded through the
 * executor, and dies with the turn — nothing here survives across turns, so
 * stale analysis can never be silently reused for a different request.
 */

/** One real sampled frame from the footage, for planning and rendered review. */
export interface DirectorFrameImage {
  /** Source video (media item) the frame belongs to. */
  readonly videoId: string;
  /** Source seconds on that video. */
  readonly timestamp: number;
  /** `data:image/jpeg;base64,...` */
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
}

/** What happened the last time `extract_segments` ran this turn. */
export type TurnExtractionStatus =
  | "not-run"
  | "succeeded"
  | "no-frames"
  | "empty-map"
  | "failed";

/**
 * The frame-backed analysis the executor captured from this turn's
 * successful `extract_segments` call. Everything in here comes from real
 * sampled frames — a metadata-only result can never produce it.
 */
export interface TrustedFootageAnalysis {
  readonly segmentMap: SegmentMap;
  readonly referenceAnalysis?: unknown;
  readonly frameCount: number;
  /** Evenly spread representative frames, capped (see EXTRACT preview selection). */
  readonly images: readonly DirectorFrameImage[];
}

export interface TurnToolContext {
  /**
   * True when this turn is the start of a NEW footage edit on an empty
   * timeline: `plan_edit` in such a turn may only plan from frame-backed
   * analysis. Preserved exceptions (already-applied reference/mirror
   * workflows, edits of an existing timeline) never set this flag — that is
   * runTurn's job, and it derives it from the same conditions the director
   * workflow guard uses.
   */
  readonly footagePlanGate: boolean;
  /** Last extraction outcome this turn (see recordExtractionOutcome). */
  extractionStatus?: TurnExtractionStatus;
  /** Trusted analysis; set only when extraction produced real frames. */
  analysis?: TrustedFootageAnalysis;
}

export function createTurnContext(footagePlanGate: boolean): TurnToolContext {
  return { footagePlanGate };
}

/**
 * Fold an `extract_segments` ToolResult into the turn context.
 *
 * "Extraction ran" is NOT trusted by itself:
 * - a failed call never invalidates an earlier success this turn, but is
 *   recorded so plan_edit can report the real story;
 * - a metadata-only result (frameCount === 0) is rejected — no analysis;
 * - an empty segment map (no videos, or no video with at least one segment)
 *   is rejected — no analysis;
 * - a frame-backed result with representative frames is cached as THE
 *   evidence for plan_edit later in the same turn — the model no longer has
 *   to copy the segmentMap between calls.
 */
export interface ExtractionOutcome {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly images?: readonly DirectorFrameImage[];
  readonly error?: string;
}

export function recordExtractionOutcome(
  context: TurnToolContext,
  outcome: ExtractionOutcome,
): void {
  if (!outcome.ok) {
    context.extractionStatus = "failed";
    return;
  }

  const data = outcome.data as { frameCount?: unknown; segmentMap?: unknown; referenceAnalysis?: unknown } | undefined;
  const frameCount =
    typeof data?.frameCount === "number" && Number.isFinite(data.frameCount)
      ? data.frameCount
      : 0;

  if (frameCount <= 0) {
    // Metadata-only / no frames available. Not plannable evidence.
    context.extractionStatus = "no-frames";
    return;
  }

  const segmentMapRaw = data?.segmentMap;
  const segmentMap =
    segmentMapRaw && typeof segmentMapRaw === "object"
      ? (segmentMapRaw as SegmentMap)
      : undefined;
  const videos = segmentMap && Array.isArray(segmentMap.videos) ? segmentMap.videos : [];
  const hasSegments = videos.some(
    (video) => Array.isArray((video as { segments?: unknown[] }).segments) && ((video as { segments: unknown[] }).segments).length > 0,
  );
  if (videos.length === 0 || !hasSegments) {
    context.extractionStatus = "empty-map";
    return;
  }

  context.extractionStatus = "succeeded";
  context.analysis = {
    segmentMap: segmentMap as SegmentMap,
    ...(data?.referenceAnalysis !== undefined ? { referenceAnalysis: data.referenceAnalysis } : {}),
    frameCount,
    images: outcome.images ?? [],
  };
}

/** The trusted analysis currently cached for this turn, if any. */
export function trustedAnalysis(context?: TurnToolContext): TrustedFootageAnalysis | undefined {
  return context?.analysis;
}
