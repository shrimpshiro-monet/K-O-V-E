import type { EditPlan } from "@kove-advanced/creation-schema";
import type { EditingHost } from "../host";

/** Hard budget: 8 frames total (4 cut points × before/after). Kill criterion. */
export const MAX_CUT_POINT_FRAMES = 8;
const EDGE_EPSILON_SEC = 0.05;
const FRAME_MAX_WIDTH = 320;

export interface PlannedCutPoint {
  readonly cutIndex: number;
  /** Timeline seconds of the cut (cumulative duration through the outgoing segment). */
  readonly plannedCutTime: number;
  readonly before: { readonly mediaId: string; readonly timeSeconds: number };
  readonly after: { readonly mediaId: string; readonly timeSeconds: number };
}

export interface CutPointFrame {
  readonly cutIndex: number;
  readonly role: "before" | "after";
  readonly plannedCutTime: number;
  readonly mediaId: string;
  readonly timeSeconds: number;
  readonly imageDataBase64: string;
  readonly width: number;
  readonly height: number;
}

export interface CutPointFrameSamplingResult {
  readonly frames: readonly CutPointFrame[];
  readonly plannedCutCount: number;
  readonly requestedCount: number;
  readonly extractionFailed: boolean;
}

function clampEdge(time: number, start: number, end: number): number {
  return Math.max(start, Math.min(end, time));
}

function isFrameData(
  data: unknown,
): data is { imageDataBase64: string; width: number; height: number } {
  if (!data || typeof data !== "object") return false;
  const candidate = data as Record<string, unknown>;
  return (
    typeof candidate.imageDataBase64 === "string" &&
    candidate.imageDataBase64.length > 0 &&
    typeof candidate.width === "number" &&
    Number.isFinite(candidate.width) &&
    candidate.width > 0 &&
    typeof candidate.height === "number" &&
    Number.isFinite(candidate.height) &&
    candidate.height > 0
  );
}

/** Cut points sit at plan.transitions — one before/after frame pair per transition. */
export function planCutPoints(plan: EditPlan): PlannedCutPoint[] {
  const cuts: PlannedCutPoint[] = [];
  let timelineCursor = 0;
  for (let index = 0; index < plan.segments.length; index++) {
    const segment = plan.segments[index]!;
    const duration = Math.max(0, segment.sourceEndTime - segment.sourceStartTime);
    const next = plan.segments[index + 1];
    if (next && plan.transitions.some((transition) => transition.afterSegmentIndex === index)) {
      cuts.push({
        cutIndex: cuts.length,
        plannedCutTime: timelineCursor + duration,
        before: {
          mediaId: segment.sourceVideoId,
          timeSeconds: clampEdge(
            segment.sourceEndTime - EDGE_EPSILON_SEC,
            segment.sourceStartTime,
            segment.sourceEndTime,
          ),
        },
        after: {
          mediaId: next.sourceVideoId,
          timeSeconds: clampEdge(
            next.sourceStartTime + EDGE_EPSILON_SEC,
            next.sourceStartTime,
            next.sourceEndTime,
          ),
        },
      });
    }
    timelineCursor += duration;
  }
  return cuts;
}

/**
 * Sample one frame before and one after each planned transition, extracted
 * from the source media at the cut's source in/out points via the host's
 * extractVideoFrame job. Capped at MAX_CUT_POINT_FRAMES; never fabricates
 * frame data when extraction fails.
 */
export async function sampleCutPointFrames(
  plan: EditPlan,
  host: EditingHost,
): Promise<CutPointFrameSamplingResult> {
  const cuts = planCutPoints(plan);
  const frames: CutPointFrame[] = [];
  let requestedCount = 0;
  let extractionFailed = false;

  for (const cut of cuts) {
    if (frames.length + 2 > MAX_CUT_POINT_FRAMES) break;
    for (const role of ["before", "after"] as const) {
      const target = cut[role];
      requestedCount++;
      try {
        const result = await host.runJob("extractVideoFrame", {
          mediaId: target.mediaId,
          timeSeconds: target.timeSeconds,
          maxWidth: FRAME_MAX_WIDTH,
        });
        if (result.ok && isFrameData(result.data)) {
          frames.push({
            cutIndex: cut.cutIndex,
            role,
            plannedCutTime: cut.plannedCutTime,
            mediaId: target.mediaId,
            timeSeconds: target.timeSeconds,
            imageDataBase64: result.data.imageDataBase64,
            width: result.data.width,
            height: result.data.height,
          });
        } else {
          extractionFailed = true;
        }
      } catch {
        extractionFailed = true;
      }
    }
  }

  return { frames, plannedCutCount: cuts.length, requestedCount, extractionFailed };
}
