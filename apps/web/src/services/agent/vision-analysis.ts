/**
 * Browser implementation of the agent's vision analysis seam.
 *
 * Decodes sampled video frames from a media blob, runs the core face /
 * segmentation engines, and reduces mattes to tracked mask keyframes. The
 * orchestration functions take their engines as injected dependencies so the
 * pipeline is testable without MediaPipe, WASM or a live decoder.
 */

import {
  FaceDetectionEngine,
  alphaFromRgba,
  createMediaPipeFaceBackend,
  getFaceDetectionEngine,
  getPersonSegmentationEngine,
  initializeAutoReframeEngine,
  planMatteEdgeRefinement,
  planRotoscope,
  reframePlanToTransformKeyframes,
  sampleFrameTimes,
  setFaceDetectionEngine,
  setVisionAssets,
  sourceTimeToTimelineSeconds,
  visionAssetsFromBaseUrl,
  type AlphaMask,
  type AutoReframeEngine,
  type BezierPath,
  type ClipTimeMapping,
  type FaceDetectionBackend,
  type Keyframe,
  type Mask,
  type MaskKeyframe,
  type MatteEdgeSettings,
  type ReframeCropKeyframe,
  type ReframeFitMode,
  type ReframeSettings,
  type RotoscopePlan,
  type SegmentationResult,
} from "@kove-advanced/core";
import type {
  FaceAnalysisResult,
  SubjectMatteKeyframeSummary,
  SubjectMatteResult,
  VisionSamplingRequest,
} from "@kove-advanced/agent";

/**
 * Deployments that self-host the MediaPipe runtime and models (offline or
 * air-gapped installs, e2e harnesses) set `VITE_VISION_ASSET_BASE_URL` to a
 * base directory laid out as documented in docs/AGENT-VISION.md. Unset means
 * the public CDN defaults from core.
 */
const visionAssetBaseUrl = import.meta.env.VITE_VISION_ASSET_BASE_URL as string | undefined;
if (visionAssetBaseUrl) {
  setVisionAssets(visionAssetsFromBaseUrl(visionAssetBaseUrl));
}

/**
 * Optional face model selection, for mirrors that only carry one of them.
 * "face-landmarker" switches the default backend to the landmarker task, which
 * also yields landmarks and blendshapes (see `MediaPipeFaceBackendOptions`).
 * Unset keeps the default BlazeFace short-range detector.
 */
const visionFaceModel = import.meta.env.VITE_VISION_FACE_MODEL as
  | "blaze-face"
  | "face-landmarker"
  | undefined;
if (visionFaceModel === "face-landmarker") {
  setFaceDetectionEngine(
    new FaceDetectionEngine(() => createMediaPipeFaceBackend({ model: "face-landmarker" })),
  );
}

export interface DecodedFrame {
  bitmap: ImageBitmap;
  timeMs: number;
}

/** Decodes frames at the requested source times. */
export type VideoFrameDecoder = (
  blob: Blob,
  timesMs: readonly number[],
  options?: { maxDimension?: number; onProgress?: (done: number, total: number) => void },
) => Promise<DecodedFrame[]>;

/** Runs the person segmentation matte for one frame. */
export type SubjectMaskSampler = (
  bitmap: ImageBitmap,
  timeMs: number,
  streamId: string,
) => Promise<AlphaMask | null>;

export interface FaceAnalysisDeps {
  blob: Blob;
  durationSeconds: number;
  request: VisionSamplingRequest;
  faceEngine?: Pick<FaceDetectionEngine, "analyzeFrames">;
  decode?: VideoFrameDecoder;
  onProgress?: (done: number, total: number) => void;
}

export interface SubjectMatteDeps {
  blob: Blob;
  durationSeconds: number;
  streamId: string;
  request: VisionSamplingRequest & {
    threshold?: number;
    simplifyTolerance?: number;
    maxKeyframes?: number;
    minCoverage?: number;
  };
  sampleMask?: SubjectMaskSampler;
  decode?: VideoFrameDecoder;
  onProgress?: (done: number, total: number) => void;
}

const DEFAULT_INTERVAL_MS = 500;
const DEFAULT_MAX_FRAMES = 60;
const ANALYSIS_MAX_DIMENSION = 960;

/** Share of the frame budget held back for motion-adaptive refinement. */
export const ADAPTIVE_REFINEMENT_RATIO = 0.5;
/** Refinement never splits an interval narrower than this (ms). */
export const ADAPTIVE_MIN_INTERVAL_MS = 90;

/**
 * One score per interval between consecutive base samples, in any consistent
 * unit — only the *relative* shape matters, so a raw pixel-difference sum works.
 */
export type FrameMotionMeasurer = (frames: readonly DecodedFrame[]) => number[];

export interface AdaptiveSamplingOptions {
  /** Total decode budget, base grid included. Defaults to `DEFAULT_MAX_FRAMES`. */
  maxFrames?: number;
  /** Never split an interval narrower than this (ms). */
  minIntervalMs?: number;
}

export interface AdaptiveSamplingPlan {
  /** Base grid plus refinement, ascending and de-duplicated. */
  timesMs: number[];
  /** Times added by refinement — the ones still needing a decode. */
  refinedTimesMs: number[];
}

/**
 * Spends the spare decode budget where the picture actually moves.
 *
 * The engine sees one crop decision per sampled frame, so a fixed grid has to
 * pick between wasting decodes on a locked-off shot and under-sampling a fast
 * one. This bisects the busiest intervals instead: motion is treated as
 * spread evenly across an interval, so splitting halves each child's score and
 * leaves its density unchanged — the greedy pass therefore keeps subdividing
 * the same busy region until it hits `minIntervalMs` or the budget runs out,
 * and leaves quiet stretches on the coarse grid.
 *
 * Pure: no decoding, no canvas.
 */
export function planAdaptiveSampleTimes(
  baseTimesMs: readonly number[],
  motion: readonly number[],
  options: AdaptiveSamplingOptions = {},
): AdaptiveSamplingPlan {
  if (baseTimesMs.length < 2) {
    return { timesMs: [...baseTimesMs], refinedTimesMs: [] };
  }

  const maxFrames = Math.max(2, Math.floor(options.maxFrames ?? DEFAULT_MAX_FRAMES));
  const minIntervalMs = Math.max(1, options.minIntervalMs ?? ADAPTIVE_MIN_INTERVAL_MS);

  // Normalize so the caller's units cannot skew the split order.
  const peak = motion.reduce((max, value) => Math.max(max, Number.isFinite(value) ? value : 0), 0);
  const normalized =
    peak > 0 ? motion.map((value) => (Number.isFinite(value) ? Math.max(0, value) / peak : 0)) : motion.map(() => 0);

  const segments = baseTimesMs.slice(0, -1).map((start, index) => ({
    start,
    score: normalized[index] ?? 0,
  }));
  const end = baseTimesMs[baseTimesMs.length - 1];

  let budget = maxFrames - baseTimesMs.length;
  while (budget > 0) {
    let best = -1;
    let bestDensity = -1;
    for (let index = 0; index < segments.length; index += 1) {
      const segmentStart = segments[index].start;
      const segmentEnd = segments[index + 1]?.start ?? end;
      const length = segmentEnd - segmentStart;
      // Halving would drop below the floor; this interval is done.
      if (length / 2 < minIntervalMs) continue;
      const density = length > 0 ? segments[index].score / length : 0;
      if (density > bestDensity) {
        bestDensity = density;
        best = index;
      }
    }
    // Everything is either already at the floor or motionless.
    if (best < 0 || bestDensity <= 0) break;

    const split = segments[best];
    const segmentEnd = segments[best + 1]?.start ?? end;
    const midpoint = (split.start + segmentEnd) / 2;
    segments.splice(best + 1, 0, { start: midpoint, score: split.score / 2 });
    split.score /= 2;
    budget -= 1;
  }

  const timesMs = [...segments.map((segment) => segment.start), end];
  const base = new Set(baseTimesMs);
  return {
    timesMs,
    refinedTimesMs: timesMs.filter((time) => !base.has(time)),
  };
}

/**
 * Mean luma change between consecutive frames, one score per interval.
 *
 * Frames are drawn into a thumbnail first: the motion that should drive
 * sampling is the subject crossing the frame, not sensor noise at full
 * resolution. Returns an empty array when pixels cannot be read (no DOM, or a
 * decoder that handed back placeholder bitmaps), which leaves the caller on its
 * base grid rather than failing the analysis.
 */
export const measureFrameMotion: FrameMotionMeasurer = (frames) => {
  if (typeof document === "undefined" || frames.length < 2) return [];
  const width = 48;
  const height = 27;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return [];

  const thumbnails: Uint8ClampedArray[] = [];
  for (const frame of frames) {
    context.clearRect(0, 0, width, height);
    try {
      context.drawImage(frame.bitmap, 0, 0, width, height);
    } catch {
      return [];
    }
    let data: Uint8ClampedArray;
    try {
      data = context.getImageData(0, 0, width, height).data;
    } catch {
      return [];
    }
    thumbnails.push(data);
  }

  const scores: number[] = [];
  for (let index = 1; index < thumbnails.length; index += 1) {
    const previous = thumbnails[index - 1];
    const current = thumbnails[index];
    let total = 0;
    for (let pixel = 0; pixel < current.length; pixel += 4) {
      total +=
        Math.abs(current[pixel] - previous[pixel]) +
        Math.abs(current[pixel + 1] - previous[pixel + 1]) +
        Math.abs(current[pixel + 2] - previous[pixel + 2]);
    }
    scores.push(total / (width * height * 3));
  }
  return scores;
};

/** Resolves the sampling window in milliseconds, clamped to the media. */
export function resolveSamplingWindow(
  durationSeconds: number,
  request: Pick<VisionSamplingRequest, "startTime" | "endTime" | "intervalMs" | "maxFrames">,
): { timesMs: number[]; startMs: number; endMs: number } {
  const durationMs = Math.max(0, durationSeconds * 1000);
  const startMs = Math.max(0, Math.min(request.startTime !== undefined ? request.startTime * 1000 : 0, durationMs));
  const requestedEnd = request.endTime !== undefined ? request.endTime * 1000 : durationMs;
  const endMs = Math.max(startMs, Math.min(requestedEnd, durationMs));
  const timesMs = sampleFrameTimes(
    startMs,
    endMs,
    request.intervalMs ?? DEFAULT_INTERVAL_MS,
    request.maxFrames ?? DEFAULT_MAX_FRAMES,
  );
  return { timesMs, startMs, endMs };
}

/**
 * Decodes frames by seeking a detached `<video>` and scaling each frame down
 * before it becomes an ImageBitmap: detection and segmentation do not need
 * full resolution, and the smaller transfer keeps the main thread responsive.
 */
export const decodeVideoFrames: VideoFrameDecoder = async (blob, timesMs, options = {}) => {
  if (typeof document === "undefined") return [];
  const maxDimension = options.maxDimension ?? ANALYSIS_MAX_DIMENSION;
  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  video.src = url;

  const waitFor = (event: "loadedmetadata" | "seeked" | "loadeddata"): Promise<void> =>
    new Promise((resolve, reject) => {
      const cleanup = () => {
        video.removeEventListener(event, complete);
        video.removeEventListener("error", failed);
      };
      const complete = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new Error("Could not decode this video for analysis."));
      };
      video.addEventListener(event, complete, { once: true });
      video.addEventListener("error", failed, { once: true });
    });

  const frames: DecodedFrame[] = [];
  try {
    await waitFor("loadedmetadata");
    const scale = Math.min(1, maxDimension / Math.max(video.videoWidth, video.videoHeight, 1));
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return [];

    for (let index = 0; index < timesMs.length; index += 1) {
      const timeSeconds = Math.max(0, Math.min(timesMs[index] / 1000, Math.max(0, (video.duration || 0) - 0.001)));
      video.currentTime = timeSeconds;
      await waitFor("seeked");
      context.drawImage(video, 0, 0, width, height);
      frames.push({ bitmap: await createImageBitmap(canvas), timeMs: timesMs[index] });
      options.onProgress?.(index + 1, timesMs.length);
    }
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
  return frames;
};

/** Reads a video blob's intrinsic size (metadata is not always available). */
export const probeVideoSize: (blob: Blob) => Promise<{ width: number; height: number }> = (
  blob,
) =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "metadata";
    video.src = url;
    const cleanup = () => {
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    };
    video.addEventListener(
      "loadedmetadata",
      () => {
        const size = { width: video.videoWidth, height: video.videoHeight };
        cleanup();
        resolve(size);
      },
      { once: true },
    );
    video.addEventListener(
      "error",
      () => {
        cleanup();
        reject(new Error("Could not read this video's dimensions."));
      },
      { once: true },
    );
  });

/** Segmentation-backed matte sampler (streams through the shared worker). */
export const sampleSubjectMask: SubjectMaskSampler = async (bitmap, timeMs, streamId) => {
  const engine = getPersonSegmentationEngine();
  await engine.initialize();
  const result: SegmentationResult | null = await engine.getPersonMask(bitmap, {
    streamId,
    timestampMs: timeMs,
  });
  if (!result) return null;
  return alphaFromRgba(result.mask);
};

export async function analyzeFacesInMedia(deps: FaceAnalysisDeps): Promise<FaceAnalysisResult> {
  const decode = deps.decode ?? decodeVideoFrames;
  const engine = deps.faceEngine ?? getFaceDetectionEngine();
  const { timesMs } = resolveSamplingWindow(deps.durationSeconds, deps.request);
  const frames = await decode(deps.blob, timesMs, { onProgress: deps.onProgress });
  const analysis = await engine.analyzeFrames(
    frames.map((frame) => ({ bitmap: frame.bitmap, timeMs: frame.timeMs })),
  );
  return {
    width: analysis.width,
    height: analysis.height,
    sampledFrames: analysis.frames.length,
    sampledTimesMs: analysis.sampledTimesMs,
    tracks: analysis.tracks.map((track) => ({
      id: track.id,
      firstTimeMs: track.firstTimeMs,
      lastTimeMs: track.lastTimeMs,
      framesDetected: track.framesDetected,
      averageConfidence: track.averageConfidence,
      averageBox: track.averageBox,
      score: track.score,
    })),
    primaryTrackId: analysis.primaryTrackId,
    warnings: analysis.warnings,
  };
}

export interface SubjectMatteAnalysis {
  result: SubjectMatteResult;
  /** Full plan, including paths, for callers that will write the matte. */
  plan: RotoscopePlan;
  maskWidth: number;
  maskHeight: number;
}

export async function analyzeSubjectMatte(deps: SubjectMatteDeps): Promise<SubjectMatteAnalysis> {
  const decode = deps.decode ?? decodeVideoFrames;
  const sampleMask = deps.sampleMask ?? sampleSubjectMask;
  const { timesMs } = resolveSamplingWindow(deps.durationSeconds, deps.request);
  const frames = await decode(deps.blob, timesMs, { onProgress: deps.onProgress });

  const samples: Array<{ timeMs: number; mask: AlphaMask }> = [];
  for (const frame of frames) {
    const mask = await sampleMask(frame.bitmap, frame.timeMs, deps.streamId);
    if (mask) samples.push({ timeMs: frame.timeMs, mask });
    frame.bitmap.close();
  }
  if (samples.length === 0) {
    return {
      result: {
        width: 0,
        height: 0,
        sampledFrames: frames.length,
        missedFrames: frames.length,
        keyframeCount: 0,
        keyframes: [],
        averageCoverage: 0,
        boundingBox: { x: 0, y: 0, width: 0, height: 0 },
        warnings: ["The subject model produced no matte for any sampled frame."],
      },
      plan: {
        keyframes: [],
        sampledFrames: frames.length,
        missedFrames: frames.length,
        averageCoverage: 0,
        boundingBox: { x: 0, y: 0, width: 0, height: 0 },
        warnings: ["No mattes were produced."],
      },
      maskWidth: 0,
      maskHeight: 0,
    };
  }

  // The matte can be lower resolution than the frame; RotoscopePlan normalizes
  // paths, so the mask's own dimensions are the ones that matter.
  const plan = planRotoscope(samples, {
    ...(deps.request.threshold !== undefined ? { threshold: Math.round(deps.request.threshold * 255) } : {}),
    ...(deps.request.simplifyTolerance !== undefined ? { simplifyTolerance: deps.request.simplifyTolerance } : {}),
    ...(deps.request.maxKeyframes !== undefined ? { maxKeyframes: deps.request.maxKeyframes } : {}),
    ...(deps.request.minCoverage !== undefined ? { minCoverage: deps.request.minCoverage } : {}),
  });
  const first = samples[0].mask;
  const keyframes: SubjectMatteKeyframeSummary[] = plan.keyframes.map((keyframe) => ({
    timeMs: keyframe.timeMs,
    coverage: keyframe.coverage,
    pointCount: keyframe.pointCount,
    centroid: keyframe.centroid,
  }));

  return {
    result: {
      width: first.width,
      height: first.height,
      sampledFrames: plan.sampledFrames,
      missedFrames: plan.missedFrames,
      keyframeCount: plan.keyframes.length,
      keyframes,
      averageCoverage: plan.averageCoverage,
      boundingBox: plan.boundingBox,
      warnings: plan.warnings,
    },
    plan,
    maskWidth: first.width,
    maskHeight: first.height,
  };
}

export interface WriteMatteRequest {
  masks: readonly Mask[];
  clipId: string;
  /** Existing mask to extend; omitted creates one. */
  maskId?: string;
  plan: RotoscopePlan;
  /** Source→timeline mapping for the sampled times (clip speed/reverse aware). */
  timeMapping: ClipTimeMapping;
  featherPx?: number;
  expansionPx?: number;
  invertMask?: boolean;
  /**
   * Edge refinement. When set, feather/expansion are written *per keyframe*
   * (widening where the subject moves) and the mask-level values become the
   * defaults a keyframe inherits. Omitting it keeps the legacy uniform edge.
   */
  edge?: MatteEdgeSettings;
  createId: () => string;
}

export interface WriteMatteResult {
  masks: Mask[];
  maskId: string;
  keyframeCount: number;
  firstTimeSeconds: number | null;
  lastTimeSeconds: number | null;
  warnings: string[];
  /**
   * Per-keyframe motion scores (0..1) and the feather range actually written,
   * present only when edge refinement ran. Surfaced so the UI and the agent can
   * report what the edge does instead of leaving it invisible.
   */
  edge?: {
    motion: number[];
    minFeatherPx: number;
    maxFeatherPx: number;
  };
}

/**
 * Pure mask-writing step: merges a rotoscope plan into the project's mask list
 * as timeline-keyframed paths. The caller commits the returned array with one
 * `mask/setAll` action so the whole matte is a single undo step.
 *
 * Core's `applyRotoscopePlan` writes into a live `RotoscopeKeyframeSink`
 * (MaskEngine); this variant produces a new immutable mask array because agent
 * and inspector writes must go through the undoable action system instead.
 */
export function writeMatteToMasks(request: WriteMatteRequest): WriteMatteResult {
  const existing = request.maskId
    ? request.masks.find((mask) => mask.id === request.maskId)
    : undefined;
  if (request.maskId && !existing) {
    throw new Error(`Mask not found: ${request.maskId}`);
  }

  const warnings: string[] = [];
  const keyframes = [...(existing?.keyframes ?? [])];
  let written = 0;
  let first: number | null = null;
  let last: number | null = null;

  // Edge refinement is derived from the same plan the paths come from, so the
  // per-keyframe feather lines up with the keyframe it describes (same order).
  const edgePlan = request.edge
    ? planMatteEdgeRefinement(request.plan.keyframes, request.edge)
    : null;
  if (edgePlan) warnings.push(...edgePlan.warnings);

  const originMs = 0;
  for (const [index, keyframe] of request.plan.keyframes.entries()) {
    const timeSeconds = applyRotoscopeKeyframeTime(keyframe.timeMs - originMs, request.timeMapping);
    const path: BezierPath = keyframe.path;
    // Replace any keyframe at the same instant so re-running the tool does not
    // stack duplicates on the same clip.
    const duplicateIndex = keyframes.findIndex(
      (entry) => Math.abs(entry.time - timeSeconds) < 1e-3,
    );
    const edgeValues = edgePlan?.keyframes[index];
    const entry: MaskKeyframe = {
      id: request.createId(),
      time: timeSeconds,
      path,
      easing: "linear" as const,
      // Per-keyframe overrides; the renderer blends these between keyframes.
      ...(edgeValues
        ? { feathering: edgeValues.featherPx, expansion: edgeValues.expansionPx }
        : {}),
    };
    if (duplicateIndex >= 0) keyframes[duplicateIndex] = entry;
    else keyframes.push(entry);
    written += 1;
    if (first === null || timeSeconds < first) first = timeSeconds;
    if (last === null || timeSeconds > last) last = timeSeconds;
  }
  keyframes.sort((a, b) => a.time - b.time);

  const fallbackPath: BezierPath = request.plan.keyframes[0]?.path ?? {
    closed: true,
    points: [
      { x: 0.25, y: 0.25 },
      { x: 0.75, y: 0.25 },
      { x: 0.75, y: 0.75 },
      { x: 0.25, y: 0.75 },
    ],
  };

  // With edge refinement the mask-level values are the *defaults* a keyframe
  // inherits; the per-keyframe overrides above are what the renderer blends.
  // Without it, the legacy flat feather/expansion behaviour is preserved.
  // An existing mask only has its edge overwritten where the caller actually
  // asked, so re-writing paths never silently resets a hand-tuned feather.
  const edgeDefaults: Partial<Pick<Mask, "feathering" | "expansion" | "inverted" | "opacity">> =
    request.edge
      ? {
          feathering: Math.max(0, request.edge.featherPx),
          expansion: Math.max(-100, Math.min(100, request.edge.expansionPx)),
          inverted: request.edge.invert ?? false,
          opacity: Math.max(0, Math.min(1, request.edge.opacity ?? 1)),
        }
      : {
          ...(request.featherPx !== undefined ? { feathering: request.featherPx } : {}),
          ...(request.expansionPx !== undefined ? { expansion: request.expansionPx } : {}),
          ...(request.invertMask !== undefined ? { inverted: request.invertMask } : {}),
        };

  const freshEdge = request.edge
    ? {
        feathering: Math.max(0, request.edge.featherPx),
        expansion: Math.max(-100, Math.min(100, request.edge.expansionPx)),
        inverted: request.edge.invert ?? false,
        opacity: Math.max(0, Math.min(1, request.edge.opacity ?? 1)),
      }
    : {
        feathering: request.featherPx ?? 4,
        expansion: request.expansionPx ?? 0,
        inverted: request.invertMask ?? false,
        opacity: 1,
      };

  const mask: Mask = existing
    ? {
        ...existing,
        path: keyframes[0]?.path ?? existing.path,
        keyframes,
        ...edgeDefaults,
      }
    : {
        id: request.createId(),
        clipId: request.clipId,
        type: "drawn",
        path: fallbackPath,
        ...freshEdge,
        keyframes,
      };

  if (request.plan.missedFrames > 0) {
    warnings.push(
      `${request.plan.missedFrames} frame(s) had no subject; the matte holds its last shape there.`,
    );
  }

  const masks = existing
    ? request.masks.map((entry) => (entry.id === mask.id ? mask : entry))
    : [...request.masks, mask];

  const feathers = edgePlan?.keyframes.map((keyframe) => keyframe.featherPx) ?? [];

  return {
    masks,
    maskId: mask.id,
    keyframeCount: written,
    firstTimeSeconds: first,
    lastTimeSeconds: last,
    warnings,
    ...(edgePlan && feathers.length > 0
      ? {
          edge: {
            motion: edgePlan.motion,
            minFeatherPx: Math.min(...feathers),
            maxFeatherPx: Math.max(...feathers),
          },
        }
      : {}),
  };
}

/**
 * Maps a source timestamp (ms) onto the mask keyframe clock (timeline
 * seconds). Thin wrapper over core's mapping so clip speed/reverse stay in one
 * place; exported so tests can pin that behavior.
 */
export function applyRotoscopeKeyframeTime(
  timeMs: number,
  mapping: ClipTimeMapping,
): number {
  return sourceTimeToTimelineSeconds(timeMs / 1000, mapping);
}

export interface AutoReframeDeps {
  blob: Blob;
  durationSeconds: number;
  /** Source sampling window (source seconds) and density. */
  request: VisionSamplingRequest;
  settings: ReframeSettings;
  /** Source media dimensions — the crop plan is normalized to these. */
  mediaWidth: number;
  mediaHeight: number;
  /** Project canvas the clip is reframed into. */
  canvasWidth: number;
  canvasHeight: number;
  fitMode?: ReframeFitMode;
  /** Source→timeline mapping so keyframes land on the clip-local clock. */
  timeMapping?: ClipTimeMapping;
  decode?: VideoFrameDecoder;
  /**
   * Scores the motion between consecutive base samples. Defaults to
   * `measureFrameMotion`; inject it to drive refinement from a known curve.
   */
  measureMotion?: FrameMotionMeasurer;
  /** Floor for motion-adaptive refinement, in ms. */
  minIntervalMs?: number;
  /** Engine used for the crop plan. Defaults to the shared auto-reframe engine. */
  engine?: AutoReframeEngine;
  onProgress?: (progress: number, message: string) => void;
}

export interface AutoReframeAnalysis {
  /** Every animated property keyframe the renderer needs. */
  keyframes: Keyframe[];
  /** Sampled frames that drove the decision. */
  sampledFrames: number;
  /**
   * Samples added on top of the base grid because the picture moved there.
   * Present only when motion-adaptive sampling ran and had something to add.
   */
  refinedFrames?: number;
  keyframeSamples: number;
  outputWidth: number;
  outputHeight: number;
  /** True when the real face detector (not the skin-tone fallback) steered it. */
  usedFaceBackend: boolean;
  /**
   * Largest gap between the fitted camera curve and the polyline the renderer
   * draws, in source pixels — how closely the emitted keyframes follow the
   * smooth path they were fitted to.
   */
  pathDeviationPx?: number;
  /** Fastest camera motion, in crop-widths per second. */
  peakSpeedCropRatios?: number;
  warnings: string[];
}

/**
 * Reframe a clip for a target aspect ratio.
 *
 * Decodes frames across the requested window, lets the auto-reframe engine pick
 * a crop per frame (steered by the real face detector when one is attached, and
 * falling back to the built-in detector if it fails), then converts the crop
 * plan into clip transform keyframes. Read-only: the caller decides how to
 * commit them.
 */
export async function analyzeAutoReframe(deps: AutoReframeDeps): Promise<AutoReframeAnalysis> {
  const decode = deps.decode ?? decodeVideoFrames;
  const engine = deps.engine ?? initializeAutoReframeEngine();
  const warnings: string[] = [];

  // An explicit interval or frame cap is a request for exactly that grid, so
  // only the default (unspecified) sampling is allowed to adapt.
  const explicitGrid =
    deps.request.adaptive === false ||
    deps.request.intervalMs !== undefined ||
    deps.request.maxFrames !== undefined;
  const baseBudget = explicitGrid
    ? undefined
    : Math.max(2, Math.ceil(DEFAULT_MAX_FRAMES * (1 - ADAPTIVE_REFINEMENT_RATIO)));

  const { timesMs, startMs, endMs } = resolveSamplingWindow(deps.durationSeconds, {
    ...deps.request,
    ...(baseBudget !== undefined ? { maxFrames: baseBudget } : {}),
  });
  if (timesMs.length === 0) {
    throw new Error("No frames to analyze in this range.");
  }

  const frames = await decode(deps.blob, timesMs);
  if (frames.length === 0) {
    throw new Error("Could not decode this video for reframing.");
  }

  // Second pass: spend what is left of the budget where the picture moves.
  let analyzedFrames = frames;
  let refinedFrames: number | undefined;
  let sampleTimes: number[] | undefined;
  if (!explicitGrid && frames.length >= 2) {
    const motion = (deps.measureMotion ?? measureFrameMotion)(frames);
    const plan = planAdaptiveSampleTimes(
      frames.map((frame) => frame.timeMs),
      motion,
      {
        maxFrames: DEFAULT_MAX_FRAMES,
        ...(deps.minIntervalMs !== undefined ? { minIntervalMs: deps.minIntervalMs } : {}),
      },
    );
    if (plan.refinedTimesMs.length > 0) {
      const extra = await decode(deps.blob, plan.refinedTimesMs);
      if (extra.length > 0) {
        analyzedFrames = [...frames, ...extra].sort((a, b) => a.timeMs - b.timeMs);
        refinedFrames = extra.length;
        // The grid is no longer uniform, so stamp every crop with its own time
        // instead of letting the engine derive one from the frame index.
        sampleTimes = analyzedFrames.map((frame) => (frame.timeMs - startMs) / 1000);
      }
    }
  }

  await engine.initialize();

  // Prefer the real detector; the engine degrades to its built-in fallback if
  // this backend fails, so a missing model cannot break reframing.
  if (!engine.getFaceBackend()) {
    engine.setFaceBackend(createConfiguredFaceBackend());
  }

  // Frames are sampled on a fixed grid, so the sampling rate is the frame rate
  // the engine should assume when it stamps crop times. Adaptive sampling hands
  // it explicit times instead and this stays as the uniform-grid fallback.
  const spacingMs =
    analyzedFrames.length > 1
      ? Math.max(1, analyzedFrames[1].timeMs - analyzedFrames[0].timeMs)
      : Math.max(1, endMs - startMs);
  const plan = await engine.analyzeClip(
    analyzedFrames.map((frame) => frame.bitmap),
    1000 / spacingMs,
    deps.settings,
    (progress, message) => deps.onProgress?.(progress, message),
    sampleTimes,
  );

  if (!plan.success) {
    throw new Error(plan.message ?? "Auto reframe failed.");
  }

  // The engine reports crops in the analyzed frame's pixel space (cropWidth =
  // frameHeight * targetRatio), so normalize by that frame before mapping —
  // the result is then resolution-independent, like the transform it feeds.
  const frameWidth = Math.max(1, analyzedFrames[0].bitmap.width);
  const frameHeight = Math.max(1, analyzedFrames[0].bitmap.height);
  const cropKeyframes: ReframeCropKeyframe[] = plan.keyframes.map((keyframe) => ({
    // The engine stamps `time` from frame index / sampling rate: source seconds
    // measured from the start of the analyzed window.
    time: keyframe.time + startMs / 1000,
    cropX: keyframe.cropX / frameWidth,
    cropY: keyframe.cropY / frameHeight,
    cropWidth: keyframe.cropWidth / frameWidth,
    cropHeight: keyframe.cropHeight / frameHeight,
  }));

  const keyframes = reframePlanToTransformKeyframes(
    cropKeyframes,
    {
      mediaWidth: deps.mediaWidth,
      mediaHeight: deps.mediaHeight,
      canvasWidth: deps.canvasWidth,
      canvasHeight: deps.canvasHeight,
      ...(deps.fitMode ? { fitMode: deps.fitMode } : {}),
    },
    {
      createId: () => crypto.randomUUID(),
      ...(deps.timeMapping ? { timeMapping: deps.timeMapping } : {}),
    },
  );

  const keyframeSamples = new Set(keyframes.map((keyframe) => keyframe.time)).size;
  if (keyframeSamples <= 1) {
    warnings.push(
      "The subject barely moved, so the reframe is a single static crop rather than a camera move.",
    );
  }
  if (!engine.usesFaceBackend()) {
    warnings.push(
      "The face model was unavailable, so the crop was steered by the built-in subject detector.",
    );
  }
  warnings.push(...(plan.warnings ?? []));

  return {
    keyframes,
    sampledFrames: analyzedFrames.length,
    ...(refinedFrames !== undefined ? { refinedFrames } : {}),
    keyframeSamples,
    outputWidth: plan.outputWidth,
    outputHeight: plan.outputHeight,
    usedFaceBackend: engine.usesFaceBackend(),
    ...(plan.pathDeviationPx !== undefined ? { pathDeviationPx: plan.pathDeviationPx } : {}),
    ...(plan.peakSpeedCropRatios !== undefined
      ? { peakSpeedCropRatios: plan.peakSpeedCropRatios }
      : {}),
    warnings,
  };
}

/** Face backend honouring `VITE_VISION_FACE_MODEL` (see the module header). */
function createConfiguredFaceBackend(): FaceDetectionBackend {
  return createMediaPipeFaceBackend(
    visionFaceModel === "face-landmarker" ? { model: "face-landmarker" } : {},
  );
}
