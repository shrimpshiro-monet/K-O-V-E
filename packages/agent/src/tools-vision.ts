import type {
  ApplySubjectMatteRequest,
  AutoReframeRequest,
  EditingHost,
  MatteEdgeRequest,
  RefineMatteEdgesRequest,
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

/** Matte edge knobs, shared by apply_subject_matte and refine_matte_edges. */
function matteEdgeSchema(): JSONSchema {
  return {
    type: "object",
    additionalProperties: false,
    description:
      "Per-keyframe edge refinement. featherPx applies where the subject is still; motionSensitivity widens it where the subject moves, up to maxFeatherPx. Set motionSensitivity to 0 for one uniform feather.",
    properties: {
      featherPx: {
        type: "number",
        minimum: 0,
        maximum: 200,
        description: "Base feather in pixels where the subject is still.",
      },
      expansionPx: {
        type: "number",
        minimum: -200,
        maximum: 200,
        description: "Grow (+) or shrink (−) the silhouette, in pixels. Default 0.",
      },
      motionSensitivity: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "How much motion widens the feather, 0..1. Default 0.6.",
      },
      maxFeatherPx: {
        type: "number",
        minimum: 0,
        maximum: 200,
        description: "Cap for the motion-widened feather. Default 3× featherPx.",
      },
      invert: { type: "boolean", description: "Keep the background instead of the subject." },
      opacity: { type: "number", minimum: 0, maximum: 1, description: "Matte opacity. Default 1." },
    },
    required: ["featherPx"],
  };
}

function readMatteEdge(args: Record<string, unknown>): MatteEdgeRequest | undefined {
  const raw = args.edge as Record<string, unknown> | undefined;
  if (!raw || typeof raw.featherPx !== "number") return undefined;
  return {
    featherPx: raw.featherPx,
    ...(typeof raw.expansionPx === "number" ? { expansionPx: raw.expansionPx } : {}),
    ...(typeof raw.motionSensitivity === "number" ? { motionSensitivity: raw.motionSensitivity } : {}),
    ...(typeof raw.maxFeatherPx === "number" ? { maxFeatherPx: raw.maxFeatherPx } : {}),
    ...(raw.invert === true ? { invert: true } : {}),
    ...(typeof raw.opacity === "number" ? { opacity: raw.opacity } : {}),
  };
}

/** Render an edge result as a compact, non-fabricated summary fragment. */
function edgeSummary(edge: { minFeatherPx: number; maxFeatherPx: number; motion: readonly number[] }): string {
  const peakMotion = edge.motion.length > 0 ? Math.max(...edge.motion) : 0;
  const varying = edge.maxFeatherPx - edge.minFeatherPx > 1e-6;
  return varying
    ? ` Edge feather ${round(edge.minFeatherPx, 1)}–${round(edge.maxFeatherPx, 1)}px, keyframed with the subject's motion (peak ${(peakMotion * 100).toFixed(0)}%).`
    : ` Edge feather ${round(edge.minFeatherPx, 1)}px, uniform.`;
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
        edge: matteEdgeSchema(),
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
        ...(readMatteEdge(args) ? { edge: readMatteEdge(args) as MatteEdgeRequest } : {}),
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
        } (one undo step).${result.edge ? edgeSummary(result.edge) : ""}`,
        data: {
          maskId: result.maskId,
          keyframeCount: result.keyframeCount,
          firstTimeSeconds: result.firstTimeSeconds,
          lastTimeSeconds: result.lastTimeSeconds,
          separationApplied: result.separationApplied,
          ...(result.edge
            ? {
                edge: {
                  minFeatherPx: result.edge.minFeatherPx,
                  maxFeatherPx: result.edge.maxFeatherPx,
                  motion: [...result.edge.motion].map((value) => round(value, 3)),
                },
              }
            : {}),
          timebase: "timeline-seconds",
        },
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    },
  },

  {
    name: "auto_reframe_clip",
    domain: "ai",
    title: "Reframe a clip for a target aspect ratio",
    description:
      "Reframe one clip for a different aspect ratio (16:9 → 9:16 and so on). Samples the clip's frames, picks a crop per frame — steered by face tracking when a face detector is available, otherwise by the built-in subject detector. Sampling is motion-adaptive by default: a coarse pass finds where the picture moves and a second pass spends the rest of the frame budget there, so a fast cut is not under-sampled and a locked-off shot is not over-decoded (pass adaptive false to force the even grid). The camera move is fitted as a smooth path and committed as clip transform keyframes (position.x/position.y/scale.x/scale.y) on the clip-local clock, so clip speed and reverse are accounted for. Resizes the project canvas to the target resolution unless setCanvasSize is false. The canvas resize and the camera move are ONE undo step. Destructive — requires confirmation. Check get_capabilities → host.autoReframe first.",
    inputSchema: strictObject(
      {
        ...samplingSchema(),
        clipId: { type: "string", description: "Clip to reframe (required)." },
        targetAspectRatio: {
          type: "string",
          enum: ["16:9", "9:16", "1:1", "4:5", "4:3", "21:9"],
          description: "Target aspect ratio. Default 9:16 (vertical).",
        },
        trackingSpeed: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "How quickly the camera catches up with the subject. Default 0.5.",
        },
        padding: {
          type: "number",
          minimum: 0,
          maximum: 0.4,
          description: "Headroom kept around the subject, as a fraction of the frame. Default 0.1.",
        },
        smoothing: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Temporal smoothing of the camera move. Default 0.8.",
        },
        followSubject: {
          type: "boolean",
          description: "Track the subject instead of keeping the crop centred. Default true.",
        },
        centerBias: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Bias the crop towards the centre of the source. Default 0.3.",
        },
        setCanvasSize: {
          type: "boolean",
          description: "Resize the project canvas to the target resolution. Default true.",
        },
        adaptive: {
          type: "boolean",
          description:
            "Sample more densely where the picture moves instead of on an even grid. Default true. Set false (or pass intervalMs/maxFrames) to force the even grid.",
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
      if (host.features?.().autoReframe === false || typeof host.autoReframe !== "function") {
        return unsupported("autoReframe", "auto_reframe_clip");
      }
      const clipId = args.clipId as string | undefined;
      if (!clipId) {
        return fail("INVALID_PARAMS", "clipId is required.", "Pick the clip to reframe.");
      }
      const target = resolveVisionTarget(host, {
        clipId,
        startTime: args.startTime as number | undefined,
        endTime: args.endTime as number | undefined,
      });
      if ("error" in target) return target.error;

      const request: AutoReframeRequest = {
        clipId,
        ...(typeof args.targetAspectRatio === "string" ? { targetAspectRatio: args.targetAspectRatio } : {}),
        ...(typeof args.trackingSpeed === "number" ? { trackingSpeed: args.trackingSpeed } : {}),
        ...(typeof args.padding === "number" ? { padding: args.padding } : {}),
        ...(typeof args.smoothing === "number" ? { smoothing: args.smoothing } : {}),
        ...(typeof args.followSubject === "boolean" ? { followSubject: args.followSubject } : {}),
        ...(typeof args.centerBias === "number" ? { centerBias: args.centerBias } : {}),
        ...(typeof args.setCanvasSize === "boolean" ? { setCanvasSize: args.setCanvasSize } : {}),
        ...(target.startTime !== undefined ? { startTime: target.startTime } : {}),
        ...(target.endTime !== undefined ? { endTime: target.endTime } : {}),
        ...(typeof args.intervalMs === "number" ? { intervalMs: args.intervalMs } : {}),
        ...(typeof args.maxFrames === "number" ? { maxFrames: args.maxFrames } : {}),
        ...(typeof args.adaptive === "boolean" ? { adaptive: args.adaptive } : {}),
      };

      const result = await host.autoReframe(request);
      if ("code" in result) {
        return fail("UNSUPPORTED_HOST", result.error, "Do not retry. Check get_capabilities → host.autoReframe.");
      }
      if (result.keyframesWritten === 0) {
        return fail(
          "NO_CAMERA_MOVE",
          "Reframing produced no camera keyframes for this clip.",
          "Check the clip has decodable video in its in/out range, then retry.",
        );
      }
      const warnings = [...target.warnings, ...result.warnings];
      return {
        ok: true,
        summary: `Reframed the clip to ${result.outputWidth}x${result.outputHeight}: ${result.keyframeSamples} camera keyframe(s) from ${result.sampledFrames} analyzed frame(s)${
          result.refinedFrames ? ` (${result.refinedFrames} of them added where the picture moved)` : ""
        }${
          result.usedFaceBackend ? " tracking faces" : " using the built-in subject detector"
        } (one undo step).`,
        data: {
          keyframesWritten: result.keyframesWritten,
          keyframeSamples: result.keyframeSamples,
          sampledFrames: result.sampledFrames,
          ...(result.refinedFrames !== undefined ? { refinedFrames: result.refinedFrames } : {}),
          outputWidth: result.outputWidth,
          outputHeight: result.outputHeight,
          usedFaceBackend: result.usedFaceBackend,
          ...(result.pathDeviationPx !== undefined
            ? { pathDeviationPx: round(result.pathDeviationPx, 2) }
            : {}),
          ...(result.peakSpeedCropRatios !== undefined
            ? { peakSpeedCropRatios: round(result.peakSpeedCropRatios, 2) }
            : {}),
          timebase: "clip-local-seconds",
        },
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    },
  },

  {
    name: "refine_matte_edges",
    domain: "ai",
    title: "Refine a matte's edge per keyframe",
    description:
      "Re-cut the edge of a rotoscoped matte that is already on a mask: feather, expansion, invert and opacity, written per keyframe so the edge can vary over time. featherPx is the softness where the subject is still; motionSensitivity (0..1) widens it where the subject moves — where sampled contours lag and motion blur already smears the silhouette — up to maxFeatherPx. Set motionSensitivity to 0 for one uniform feather. Reads the mask's existing keyframes, so it does not re-run segmentation: use apply_subject_matte to create or re-track the matte first. Restrict to a timeline range with startTime/endTime to refine part of a shot. Destructive — requires confirmation. Check get_capabilities → host.refineMatteEdges first.",
    inputSchema: strictObject(
      {
        clipId: { type: "string", description: "Clip the mask is attached to." },
        maskId: { type: "string", description: "Mask whose keyframes get the new edge." },
        edge: matteEdgeSchema(),
        startTime: { type: "number", minimum: 0, description: "Refine from this timeline second." },
        endTime: { type: "number", minimum: 0, description: "Refine up to this timeline second (> startTime)." },
      },
      ["clipId", "maskId", "edge"],
    ),
    readOnly: false,
    destructive: true,
    expensive: false,
    strict: true,
    handler: async (args, host: EditingHost): Promise<ToolResult> => {
      host.requireOpenProject();
      if (host.features?.().refineMatteEdges === false || typeof host.refineMatteEdges !== "function") {
        return unsupported("refineMatteEdges", "refine_matte_edges");
      }
      const clipId = args.clipId as string | undefined;
      const maskId = args.maskId as string | undefined;
      if (!clipId || !maskId) {
        return fail(
          "INVALID_PARAMS",
          "clipId and maskId are required.",
          "Call apply_subject_matte first to create the matte, then refine it.",
        );
      }
      const edge = readMatteEdge(args);
      if (!edge) {
        return fail(
          "INVALID_PARAMS",
          "edge.featherPx is required.",
          "Pass edge: { featherPx: 4 } or similar; featherPx is the edge softness in pixels.",
        );
      }

      const startTime = typeof args.startTime === "number" ? args.startTime : undefined;
      const endTime = typeof args.endTime === "number" ? args.endTime : undefined;
      if (startTime !== undefined && endTime !== undefined && endTime <= startTime) {
        return fail(
          "INVALID_PARAMS",
          `endTime (${endTime}) must be greater than startTime (${startTime}).`,
          "Pass the range in timeline seconds, end after start.",
        );
      }

      const request: RefineMatteEdgesRequest = {
        clipId,
        maskId,
        edge,
        ...(startTime !== undefined ? { startTime } : {}),
        ...(endTime !== undefined ? { endTime } : {}),
      };
      const result = await host.refineMatteEdges(request);
      if ("code" in result) {
        return fail(
          "UNSUPPORTED_HOST",
          result.error,
          "Do not retry. Check get_capabilities → host.refineMatteEdges.",
        );
      }
      if (result.keyframeCount === 0) {
        return fail(
          "NOT_FOUND",
          `Mask ${maskId} has no keyframes in that range.`,
          "Check the mask id, widen startTime/endTime, or re-run apply_subject_matte to build the matte.",
        );
      }

      return {
        ok: true,
        summary: `Refined the edge of ${result.keyframeCount} keyframe(s) on mask ${result.maskId} (one undo step).${edgeSummary(result.edge)}`,
        data: {
          maskId: result.maskId,
          keyframeCount: result.keyframeCount,
          minFeatherPx: result.edge.minFeatherPx,
          maxFeatherPx: result.edge.maxFeatherPx,
          motion: [...result.edge.motion].map((value) => round(value, 3)),
          timebase: "timeline-seconds",
        },
        warnings: result.warnings.length > 0 ? [...result.warnings] : undefined,
      };
    },
  },
];
