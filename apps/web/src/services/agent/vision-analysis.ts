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
  planRotoscope,
  sampleFrameTimes,
  setFaceDetectionEngine,
  setVisionAssets,
  sourceTimeToTimelineSeconds,
  visionAssetsFromBaseUrl,
  type AlphaMask,
  type BezierPath,
  type ClipTimeMapping,
  type Mask,
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
  createId: () => string;
}

export interface WriteMatteResult {
  masks: Mask[];
  maskId: string;
  keyframeCount: number;
  firstTimeSeconds: number | null;
  lastTimeSeconds: number | null;
  warnings: string[];
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

  const originMs = 0;
  for (const keyframe of request.plan.keyframes) {
    const timeSeconds = applyRotoscopeKeyframeTime(keyframe.timeMs - originMs, request.timeMapping);
    const path: BezierPath = keyframe.path;
    // Replace any keyframe at the same instant so re-running the tool does not
    // stack duplicates on the same clip.
    const duplicateIndex = keyframes.findIndex(
      (entry) => Math.abs(entry.time - timeSeconds) < 1e-3,
    );
    const entry = { id: request.createId(), time: timeSeconds, path, easing: "linear" as const };
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

  const mask: Mask = existing
    ? {
        ...existing,
        path: keyframes[0]?.path ?? existing.path,
        keyframes,
        ...(request.featherPx !== undefined ? { feathering: request.featherPx } : {}),
        ...(request.expansionPx !== undefined ? { expansion: request.expansionPx } : {}),
        ...(request.invertMask !== undefined ? { inverted: request.invertMask } : {}),
      }
    : {
        id: request.createId(),
        clipId: request.clipId,
        type: "drawn",
        path: fallbackPath,
        feathering: request.featherPx ?? 4,
        inverted: request.invertMask ?? false,
        expansion: request.expansionPx ?? 0,
        opacity: 1,
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

  return {
    masks,
    maskId: mask.id,
    keyframeCount: written,
    firstTimeSeconds: first,
    lastTimeSeconds: last,
    warnings,
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
