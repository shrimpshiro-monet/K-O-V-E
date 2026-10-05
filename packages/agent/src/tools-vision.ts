import type {
  ApplySubjectMatteRequest,
  EditingHost,
  SubjectMatteRequest,
  SubjectSeparationRequest,
  VisionSamplingRequest,
} from "./host";
import type { RegisteredTool } from "./registry";
import type { JSONSchema, ToolResult } from "./types";

/**
 * Face detection, subject segmentation and rotoscoping tools.
 *
 * The heavy lifting (decode, MediaPipe, matte contouring) lives behind the
 * host seam — these tools validate arguments, resolve clip/media references,
 * and shape honest results. New-tool conventions: strict schema, errors carry
 * {code, message, suggestedFix}, results never contain fabricated numbers.
 */

const strictObject = (
  properties: Record<string, JSONSchema>,
  required: string[] = [],
): JSONSchema => ({ type: "object", properties, required, additionalProperties: false });

const fail = (code: string, message: string, suggestedFix: string): ToolResult => ({
  ok: false,
  summary: message,
  error: { code, message, suggestedFix },
});

const round = (value: number, digits = 2): number => Number(value.toFixed(digits));

const unsupported = (feature: string, tool: string): ToolResult =>
  fail(
    "UNSUPPORTED_HOST",
    `${tool} is not available on this host (no ${feature}).`,
    `Do not retry. Check get_capabilities → host.${feature}; use a host with video analysis.`,
  );

interface ResolvedVisionTarget {
  mediaId: string;
  startTime?: number;
  endTime?: number;
  clipId?: string;
  warnings: string[];
}

/**
 * Resolves clipId|mediaId into a media item plus sampling window. A clip's
 * inPoint..outPoint is the default window; speed and reverse are reported,
 * never silently applied to the source timestamps.
 */
function resolveVisionTarget(
  host: EditingHost,
  args: {
    clipId?: string;
    mediaId?: string;
    startTime?: number;
    endTime?: number;
  },
): ResolvedVisionTarget | { error: ToolResult } {
  const clipId = args.clipId;
  const mediaId = args.mediaId;
  if ((clipId === undefined) === (mediaId === undefined)) {
    return {
      error: fail(
        "INVALID_PARAMS",
        "Pass exactly one of clipId or mediaId.",
        "Use clipId to analyze what a clip shows, or mediaId to analyze the whole media item.",
      ),
    };
  }

  const project = host.getProject();
  const warnings: string[] = [];
  let resolvedMediaId = mediaId;
  let startTime = args.startTime;
  let endTime = args.endTime;

  if (clipId !== undefined) {
    const clip = project.timeline.tracks.flatMap((track) => track.clips).find((entry) => entry.id === clipId);
    if (!clip) {
      return {
        error: fail("NOT_FOUND", `Clip not found: ${clipId}`, "Call get_timeline or list_clips for valid clip ids."),
      };
    }
    resolvedMediaId = clip.mediaId;
    startTime ??= clip.inPoint;
    endTime ??= clip.outPoint;
    if ((clip.speed ?? 1) !== 1 || clip.reversed) {
      warnings.push(
        "Clip speed/reverse are not applied: these are source timestamps. Timeline keyframe times account for them when applied.",
      );
    }
  } else if (!project.mediaLibrary.items.some((item) => item.id === mediaId)) {
    return {
      error: fail("NOT_FOUND", `Media not found: ${mediaId}`, "Call list_media for valid media ids."),
    };
  }

  if (startTime !== undefined && endTime !== undefined && endTime <= startTime) {
    return {
      error: fail("INVALID_PARAMS", "endTime must be greater than startTime.", "Both are source seconds; check the order."),
    };
  }

  return { mediaId: resolvedMediaId!, startTime, endTime, clipId, warnings };
}

function samplingSchema(): Record<string, JSONSchema> {
  return {
    clipId: { type: "string", description: "Analyze the clip's source range (inPoint..outPoint)." },
    mediaId: { type: "string", description: "Analyze a media item directly." },
    startTime: { type: "number", minimum: 0, description: "Range start in source seconds." },
    endTime: { type: "number", minimum: 0, description: "Range end in source seconds (> startTime)." },
    intervalMs: {
      type: "number",
      minimum: 16,
      maximum: 60_000,
      description: "Preferred spacing between sampled frames. Default 500 ms.",
    },
    maxFrames: {
      type: "integer",
      minimum: 1,
      maximum: 600,
      description: "Hard cap on sampled frames. Default 60.",
    },
  };
}

function samplingRequest(target: ResolvedVisionTarget, args: Record<string, unknown>): VisionSamplingRequest {
  return {
    mediaId: target.mediaId,
    ...(target.startTime !== undefined ? { startTime: target.startTime } : {}),
    ...(target.endTime !== undefined ? { endTime: target.endTime } : {}),
    ...(typeof args.intervalMs === "number" ? { intervalMs: args.intervalMs } : {}),
    ...(typeof args.maxFrames === "number" ? { maxFrames: args.maxFrames } : {}),
  };
}

export const VISION_TOOLS: RegisteredTool[] = [
  {
    name: "detect_faces",
    domain: "ai",
    title: "Detect and track faces",
    description:
      "Sample a video clip or media item and detect faces with the local face model, then associate detections into stable tracks across frames (IoU tracking with EMA smoothing and occlusion gaps). Returns per-track summaries: pixel-space average box, first/last time in source milliseconds, frames detected, average confidence, a primary-face score, and which track is primary. Read-only — nothing is written to the project. Boxes refer to the analyzed frame's pixel space, not the project canvas. Check get_capabilities → host.analyzeFaces first.",
    inputSchema: strictObject(samplingSchema()),
    readOnly: true,
    destructive: false,
    expensive: true,
    strict: true,
    handler: async (args, host: EditingHost): Promise<ToolResult> => {
      host.requireOpenProject();
      if (host.features?.().analyzeFaces === false || typeof host.analyzeFaces !== "function") {
        return unsupported("analyzeFaces", "detect_faces");
      }
      const target = resolveVisionTarget(host, {
        clipId: args.clipId as string | undefined,
        mediaId: args.mediaId as string | undefined,
        startTime: args.startTime as number | undefined,
        endTime: args.endTime as number | undefined,
      });
      if ("error" in target) return target.error;

      const result = await host.analyzeFaces(samplingRequest(target, args));
      if ("code" in result) {
        return fail("UNSUPPORTED_HOST", result.error, "Do not retry. Check get_capabilities → host.analyzeFaces.");
      }
      const warnings = [...target.warnings, ...result.warnings];
      return {
        ok: true,
        summary:
          result.tracks.length === 0
            ? `No faces found in ${result.sampledFrames} sampled frame(s).`
            : `Found ${result.tracks.length} face track(s) across ${result.sampledFrames} frame(s); primary: ${result.primaryTrackId ?? "none"}.`,
        data: {
          width: result.width,
          height: result.height,
          sampledFrames: result.sampledFrames,
          sampledTimesMs: result.sampledTimesMs,
          primaryTrackId: result.primaryTrackId,
          tracks: result.tracks.map((track) => ({
            id: track.id,
            firstTimeMs: round(track.firstTimeMs, 1),
            lastTimeMs: round(track.lastTimeMs, 1),
            framesDetected: track.framesDetected,
            averageConfidence: round(track.averageConfidence, 3),
            averageBox: {
              x: round(track.averageBox.x, 1),
              y: round(track.averageBox.y, 1),
              width: round(track.averageBox.width, 1),
              height: round(track.averageBox.height, 1),
            },
            score: round(track.score, 4),
          })),
          timebase: "source-ms",
        },
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    },
  },
  {
    name: "rotoscope_subject",
    domain: "ai",
    title: "Plan a subject rotoscope",
    description:
      "Segment the main subject across sampled frames and reduce each matte to a simplified, normalized contour path. Returns the keyframe plan: how many keyframes the tracked matte needs, when they fall (source ms), per-keyframe coverage/centroid/point count, and the union bounding box. Frames where segmentation finds no subject are reported, not estimated. Read-only proposal — call apply_subject_matte to write the matte. Check get_capabilities → host.analyzeSubjectMatte first.",
    inputSchema: strictObject({
      ...samplingSchema(),
      threshold: { type: "number", minimum: 0, maximum: 1, description: "Matte threshold. Default 0.5." },
      simplifyTolerance: {
        type: "number",
        minimum: 0,
        maximum: 0.1,
        description: "Contour simplification tolerance in normalized units. Default 0.008.",
      },
      maxKeyframes: {
        type: "integer",
        minimum: 2,
        maximum: 240,
        description: "Cap on emitted keyframes. Default 60.",
      },
      minCoverage: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Coverage below which a frame counts as 'no subject'. Default 0.004.",
      },
    }),
    readOnly: true,
    destructive: false,
    expensive: true,
    strict: true,
    handler: async (args, host: EditingHost): Promise<ToolResult> => {
      host.requireOpenProject();
      if (host.features?.().analyzeSubjectMatte === false || typeof host.analyzeSubjectMatte !== "function") {
        return unsupported("analyzeSubjectMatte", "rotoscope_subject");
      }
      const target = resolveVisionTarget(host, {
        clipId: args.clipId as string | undefined,
        mediaId: args.mediaId as string | undefined,
        startTime: args.startTime as number | undefined,
        endTime: args.endTime as number | undefined,
      });
      if ("error" in target) return target.error;

      const request: SubjectMatteRequest = {
        ...samplingRequest(target, args),
        ...(typeof args.threshold === "number" ? { threshold: args.threshold } : {}),
        ...(typeof args.simplifyTolerance === "number" ? { simplifyTolerance: args.simplifyTolerance } : {}),
        ...(typeof args.maxKeyframes === "number" ? { maxKeyframes: args.maxKeyframes } : {}),
        ...(typeof args.minCoverage === "number" ? { minCoverage: args.minCoverage } : {}),
      };
      const result = await host.analyzeSubjectMatte(request);
      if ("code" in result) {
        return fail("UNSUPPORTED_HOST", result.error, "Do not retry. Check get_capabilities → host.analyzeSubjectMatte.");
      }
      const warnings = [...target.warnings, ...result.warnings];
      const preview = result.keyframes.slice(0, 12);
      return {
        ok: true,
        summary:
          result.keyframeCount === 0
            ? `No usable subject found in ${result.sampledFrames} sampled frame(s).`
            : `Subject matte needs ${result.keyframeCount} keyframe(s) over ${result.sampledFrames} sampled frame(s); average coverage ${(result.averageCoverage * 100).toFixed(1)}%.`,
        data: {
          width: result.width,
          height: result.height,
          sampledFrames: result.sampledFrames,
          missedFrames: result.missedFrames,
          keyframeCount: result.keyframeCount,
          averageCoverage: round(result.averageCoverage, 4),
          boundingBox: {
            x: round(result.boundingBox.x, 4),
            y: round(result.boundingBox.y, 4),
            width: round(result.boundingBox.width, 4),
            height: round(result.boundingBox.height, 4),
          },
          keyframes: preview.map((keyframe) => ({
            timeMs: round(keyframe.timeMs, 1),
            coverage: round(keyframe.coverage, 4),
            centroid: { x: round(keyframe.centroid.x, 4), y: round(keyframe.centroid.y, 4) },
            pointCount: keyframe.pointCount,
          })),
          keyframesTruncated: result.keyframeCount > preview.length,
          timebase: "source-ms",
        },
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    },
  },
  {
    name: "apply_subject_matte",
    domain: "ai",
    title: "Apply a tracked subject matte",
    description:
      "Analyze the subject and write the tracked matte onto a clip as normalized mask keyframes (creating a mask, or extending maskId), in ONE undo step. Optional separation preset also re-composites the subject: cutout/transparent (subject only), blur-background, color-background, image-background, with feather, edge-shift, invert and opacity. Keyframe times are written on the timeline clock, so clip speed/reverse are accounted for. Destructive — requires confirmation. Check get_capabilities → host.applySubjectMatte first.",
    inputSchema: strictObject(
      {
        ...samplingSchema(),
        clipId: { type: "string", description: "Clip that receives the tracked matte." },
        maskId: { type: "string", description: "Existing mask to extend. Omit to create a new mask." },
        featherPx: { type: "number", minimum: 0, maximum: 200, description: "Mask feather in pixels. Default 4." },
        expansionPx: {
          type: "number",
          minimum: -200,
          maximum: 200,
          description: "Mask expansion in pixels (positive grows the matte). Default 0.",
        },
        invertMask: { type: "boolean", description: "Invert the mask (show the background instead)." },
        threshold: { type: "number", minimum: 0, maximum: 1, description: "Matte threshold. Default 0.5." },
        simplifyTolerance: {
          type: "number",
          minimum: 0,
          maximum: 0.1,
          description: "Contour simplification tolerance. Default 0.008.",
        },
        maxKeyframes: { type: "integer", minimum: 2, maximum: 240, description: "Cap on keyframes. Default 60." },
        minCoverage: { type: "number", minimum: 0, maximum: 1, description: "No-subject coverage floor. Default 0.004." },
        separation: {
          type: "object",
          additionalProperties: false,
          description: "Optional separation preset to apply alongside the matte.",
          properties: {
            preset: {
              type: "string",
              enum: ["cutout", "transparent", "blur-background", "color-background", "image-background"],
            },
            blurAmount: { type: "number", minimum: 0, maximum: 64 },
            backgroundColor: { type: "string", description: "#rgb or #rrggbb." },
            backgroundImageUrl: { type: "string" },
            threshold: { type: "number", minimum: 0, maximum: 1 },
            feather: { type: "number", minimum: 0, maximum: 0.5 },
            edgeShift: { type: "number", minimum: -0.5, maximum: 0.5 },
            invert: { type: "boolean" },
            opacity: { type: "number", minimum: 0, maximum: 1 },
          },
          required: ["preset"],
        },
      },
      ["clipId"],
    ),
    readOnly: false,
    destructive: true,
    expensive: true,
    strict: true,
    handler: async (args, host: EditingHost): Promise<ToolResult> => {
      host.requireOpenProject();
      if (host.features?.().applySubjectMatte === false || typeof host.applySubjectMatte !== "function") {
        return unsupported("applySubjectMatte", "apply_subject_matte");
      }
      const clipId = args.clipId as string | undefined;
      if (!clipId) {
        return fail("INVALID_PARAMS", "clipId is required.", "Pick the clip that should receive the matte.");
      }
      const target = resolveVisionTarget(host, {
        clipId,
        startTime: args.startTime as number | undefined,
        endTime: args.endTime as number | undefined,
      });
      if ("error" in target) return target.error;

      const rawSeparation = args.separation as SubjectSeparationRequest | undefined;
      const request: ApplySubjectMatteRequest = {
        ...samplingRequest(target, args),
        clipId,
        ...(typeof args.maskId === "string" ? { maskId: args.maskId } : {}),
        ...(typeof args.featherPx === "number" ? { featherPx: args.featherPx } : {}),
        ...(typeof args.expansionPx === "number" ? { expansionPx: args.expansionPx } : {}),
        ...(args.invertMask === true ? { invertMask: true } : {}),
        ...(typeof args.threshold === "number" ? { threshold: args.threshold } : {}),
        ...(typeof args.simplifyTolerance === "number" ? { simplifyTolerance: args.simplifyTolerance } : {}),
        ...(typeof args.maxKeyframes === "number" ? { maxKeyframes: args.maxKeyframes } : {}),
        ...(typeof args.minCoverage === "number" ? { minCoverage: args.minCoverage } : {}),
        ...(rawSeparation ? { separation: rawSeparation } : {}),
      };

      const result = await host.applySubjectMatte(request);
      if ("code" in result) {
        return fail("UNSUPPORTED_HOST", result.error, "Do not retry. Check get_capabilities → host.applySubjectMatte.");
      }
      if (result.keyframeCount === 0) {
        return fail(
          "NO_SUBJECT",
          "No subject matte could be written for this range.",
          "Widen the range, lower minCoverage, or check the footage actually contains a person.",
        );
      }
      const warnings = [...target.warnings, ...result.warnings];
      return {
        ok: true,
        summary: `Wrote ${result.keyframeCount} matte keyframe(s) to mask ${result.maskId}${
          result.separationApplied ? " with subject separation" : ""
        } (one undo step).`,
        data: {
          maskId: result.maskId,
          keyframeCount: result.keyframeCount,
          firstTimeSeconds: result.firstTimeSeconds,
          lastTimeSeconds: result.lastTimeSeconds,
          separationApplied: result.separationApplied,
          timebase: "timeline-seconds",
        },
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    },
  },
];
