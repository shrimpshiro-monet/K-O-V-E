/**
 * Face detection + tracking engine.
 *
 * Detection runs through a pluggable `FaceDetectionBackend`. The production
 * backend lazy-loads MediaPipe's FaceLandmarker/BlazeFace from a CDN (no API
 * key, models are public); tests and headless hosts inject a deterministic
 * backend so the engine can be exercised with zero network access.
 *
 * Tracking (identity assignment across sampled frames) is pure and lives in
 * this file: greedy IoU association with EMA smoothing, gap tolerance for
 * occlusions, and a primary-face scorer for auto-reframe / subject work.
 */

import { getVisionAssets } from "./vision-assets";

export interface FaceBox {
  /** Pixels in the analyzed frame's coordinate space. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FacePoint {
  /** Normalized 0..1 in frame space. */
  x: number;
  y: number;
  z?: number;
}

export interface DetectedFace {
  box: FaceBox;
  /** Backend confidence, 0..1. Never fabricated: backends that do not report
   * confidence must use the value documented by their model card. */
  confidence: number;
  /** BlazeFace's 6 keypoints (eyes, ears, nose, mouth) when available. */
  keypoints?: FacePoint[];
  /** Dense landmarks (468/478) when the landmark model is used. */
  landmarks?: FacePoint[];
  /** ARKit-style blendshape scores keyed by category name. */
  blendshapes?: Record<string, number>;
}

export interface FaceFrameResult {
  timeMs: number;
  width: number;
  height: number;
  faces: DetectedFace[];
}

/** What a backend must implement. Kept deliberately small so hosts can swap
 * MediaPipe for a native/desktop detector without touching the tracker. */
export interface FaceDetectionBackend {
  initialize(): Promise<void>;
  /** Stateless per-frame detection. Frames may be analyzed out of order, so
   * backends must not depend on call order; `timestampMs` is supplied by the
   * engine for video-mode graphs and may be ignored by stateless ones. */
  detect(frame: ImageBitmap, timestampMs?: number): Promise<DetectedFace[]>;
  dispose(): void;
}

export interface MediaPipeFaceBackendOptions {
  /** Defaults to the BlazeFace short-range detector (fast, no landmarks). */
  model?: "blaze-face" | "face-landmarker";
  numFaces?: number;
  minDetectionConfidence?: number;
  /** Blendshapes are only produced by the landmarker model. */
  outputBlendshapes?: boolean;
  /** Override for self-hosted model/WASM assets. Defaults come from
   * `getVisionAssets()`, so `setVisionAssets()` retargets these too. */
  wasmBaseUrl?: string;
  modelAssetPath?: string;
  /** Inference delegate. Defaults to "GPU" with an automatic one-shot "CPU"
   * retry when the GPU delegate cannot run (no WebGL context: headless
   * browsers, VMs, servers), so face detection works everywhere MediaPipe does. */
  delegate?: "GPU" | "CPU";
}

/**
 * The landmarker returns landmarks and no per-face score, so a synthesized
 * detection carries this neutral confidence instead of an invented one.
 */
const LANDMARK_DETECTION_CONFIDENCE = 0.5;

export interface FaceTrackingOptions {
  /** IoU above which a detection continues an existing track. Default 0.3. */
  iouThreshold?: number;
  /** Frames a track may miss before it is closed. Default 2. */
  maxMissedFrames?: number;
  /** EMA weight for the newest box (0..1, higher = less smoothing). Default 0.5. */
  smoothingAlpha?: number;
  /** Tracks with fewer detected frames than this are dropped. Default 1. */
  minTrackFrames?: number;
  /** Above this fraction of frame width the box is treated as a bad match
   * (prevents a full-frame false positive from absorbing every track). */
  maxPlausibleWidthRatio?: number;
}

export interface FaceTrackPoint {
  timeMs: number;
  /** Smoothed box for this detection (EMA across the track). */
  box: FaceBox;
  confidence: number;
}

export interface FaceTrack {
  /** Stable within one analysis run: "face-1", "face-2", ... */
  id: string;
  points: FaceTrackPoint[];
  firstTimeMs: number;
  lastTimeMs: number;
  /** Frames in which this track had a real detection. */
  framesDetected: number;
  averageConfidence: number;
  /** Mean box across detected frames. */
  averageBox: FaceBox;
  /** Primary-face score: persistence × area × centrality. Higher is better. */
  score: number;
}

export interface FaceAnalysisOptions extends FaceTrackingOptions {
  /** Samples longer than this are evenly decimated before detection. */
  maxFrames?: number;
}

export interface FaceAnalysis {
  /** Frame dimensions the boxes refer to (of the first analyzed frame). */
  width: number;
  height: number;
  frames: FaceFrameResult[];
  tracks: FaceTrack[];
  primaryTrackId: string | null;
  /** Sampling times actually used, in milliseconds. */
  sampledTimesMs: number[];
  warnings: string[];
}

const DEFAULT_TRACKING: Required<FaceTrackingOptions> = {
  iouThreshold: 0.3,
  maxMissedFrames: 2,
  smoothingAlpha: 0.5,
  minTrackFrames: 1,
  maxPlausibleWidthRatio: 0.9,
};

/** Evenly spaced sample times inside [startMs, endMs], inclusive of both ends
 * when they fit. Returns at most `maxSamples` entries; `intervalMs` is the
 * preferred step and is widened when the range would otherwise overflow. */
export function sampleFrameTimes(
  startMs: number,
  endMs: number,
  intervalMs: number,
  maxSamples: number,
): number[] {
  const start = Math.max(0, Math.min(startMs, endMs));
  const end = Math.max(start, endMs);
  const max = Math.max(1, Math.floor(maxSamples));
  const step = Math.max(1, intervalMs);
  if (end - start < step) return [start];
  // A single sample can only be the start; the even-decimation below would
  // otherwise divide by zero.
  if (max === 1) return [start];

  const count = Math.floor((end - start) / step) + 1;
  if (count <= max) {
    return Array.from({ length: count }, (_, index) => start + index * step);
  }
  const widened = (end - start) / (max - 1);
  return Array.from({ length: max }, (_, index) => Math.round(start + index * widened));
}

export function boxIou(a: FaceBox, b: FaceBox): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  if (intersection <= 0) return 0;
  const union = a.width * a.height + b.width * b.height - intersection;
  return union <= 0 ? 0 : intersection / union;
}

export function boxCenter(box: FaceBox): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function smoothBox(previous: FaceBox, next: FaceBox, alpha: number): FaceBox {
  const a = Math.max(0, Math.min(1, alpha));
  return {
    x: previous.x + (next.x - previous.x) * a,
    y: previous.y + (next.y - previous.y) * a,
    width: previous.width + (next.width - previous.width) * a,
    height: previous.height + (next.height - previous.height) * a,
  };
}

function meanBox(points: readonly FaceTrackPoint[]): FaceBox {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const sum = points.reduce(
    (acc, point) => ({
      x: acc.x + point.box.x,
      y: acc.y + point.box.y,
      width: acc.width + point.box.width,
      height: acc.height + point.box.height,
    }),
    { x: 0, y: 0, width: 0, height: 0 },
  );
  return {
    x: sum.x / points.length,
    y: sum.y / points.length,
    width: sum.width / points.length,
    height: sum.height / points.length,
  };
}

function scoreTrack(
  track: FaceTrack,
  frameWidth: number,
  frameHeight: number,
  frameCount: number,
): number {
  const frameArea = Math.max(1, frameWidth * frameHeight);
  const areaRatio = (track.averageBox.width * track.averageBox.height) / frameArea;
  const persistence = frameCount <= 1 ? 1 : track.framesDetected / frameCount;
  const center = boxCenter(track.averageBox);
  const distance = Math.hypot(
    (center.x - frameWidth / 2) / frameWidth,
    (center.y - frameHeight / 2) / frameHeight,
  );
  const centrality = Math.max(0, 1 - distance * 2);
  return (
    track.averageConfidence *
    (0.35 + 0.65 * persistence) *
    (0.35 + 0.65 * Math.min(1, areaRatio * 8)) *
    (0.5 + 0.5 * centrality)
  );
}

interface MutableTrack {
  id: string;
  points: FaceTrackPoint[];
  detectedPoints: FaceTrackPoint[];
  smoothedBox: FaceBox;
  missed: number;
  /** Set once the track is pushed to `closed`, so it is emitted exactly once. */
  closed: boolean;
}

/**
 * Assigns detections across sampled frames to stable identities.
 *
 * Greedy IoU association per frame: each detection continues the track whose
 * last box overlaps it most (above `iouThreshold`); unmatched detections start
 * new tracks, unmatched tracks survive `maxMissedFrames` frames. Boxes are
 * smoothed with an EMA, and closed tracks are scored for primary selection.
 */
export function trackFaces(
  frames: readonly FaceFrameResult[],
  options: FaceTrackingOptions = {},
): FaceTrack[] {
  const config = { ...DEFAULT_TRACKING, ...options };
  if (frames.length === 0) return [];

  const frameWidth = frames[0].width;
  const frameHeight = frames[0].height;
  const tracks: MutableTrack[] = [];
  const closed: MutableTrack[] = [];
  let nextId = 1;

  for (const frame of frames) {
    const detections = frame.faces.filter(
      (face) =>
        face.box.width > 0 &&
        face.box.height > 0 &&
        face.box.width <= frame.width * config.maxPlausibleWidthRatio,
    );

    const consumed = new Set<number>();
    const scored = tracks
      .filter((track) => !track.closed && track.missed <= config.maxMissedFrames)
      .map((track) => {
        let best = -1;
        let bestIou = 0;
        detections.forEach((detection, index) => {
          if (consumed.has(index)) return;
          const iou = boxIou(track.smoothedBox, detection.box);
          if (iou > bestIou) {
            bestIou = iou;
            best = index;
          }
        });
        return { track, best, bestIou };
      })
      .sort((a, b) => b.bestIou - a.bestIou);

    for (const match of scored) {
      if (match.best < 0 || match.bestIou < config.iouThreshold) continue;
      const detection = detections[match.best];
      consumed.add(match.best);
      match.track.smoothedBox = smoothBox(
        match.track.smoothedBox,
        detection.box,
        config.smoothingAlpha,
      );
      const point: FaceTrackPoint = {
        timeMs: frame.timeMs,
        box: match.track.smoothedBox,
        confidence: detection.confidence,
      };
      match.track.points.push(point);
      match.track.detectedPoints.push(point);
      match.track.missed = 0;
    }

    for (const track of tracks) {
      if (track.closed) continue;
      if (track.missed === 0 && track.points.at(-1)?.timeMs === frame.timeMs) {
        continue;
      }
      track.missed += 1;
      if (track.missed > config.maxMissedFrames) {
        track.closed = true;
        closed.push(track);
      }
    }

    detections.forEach((detection, index) => {
      if (consumed.has(index)) return;
      const track: MutableTrack = {
        id: `face-${nextId++}`,
        points: [
          {
            timeMs: frame.timeMs,
            box: detection.box,
            confidence: detection.confidence,
          },
        ],
        detectedPoints: [
          {
            timeMs: frame.timeMs,
            box: detection.box,
            confidence: detection.confidence,
          },
        ],
        smoothedBox: detection.box,
        missed: 0,
        closed: false,
      };
      tracks.push(track);
    });
  }

  // Tracks still active at the end of the window close with the window.
  closed.push(...tracks.filter((track) => !track.closed));

  return closed
    .filter((track) => track.points.length >= config.minTrackFrames)
    .map((track) => {
      const detected = track.detectedPoints;
      const averageConfidence =
        detected.reduce((sum, point) => sum + point.confidence, 0) /
        Math.max(1, detected.length);
      const averageBox = meanBox(detected);
      const result: FaceTrack = {
        id: track.id,
        points: track.points,
        firstTimeMs: track.points[0]?.timeMs ?? 0,
        lastTimeMs: track.points.at(-1)?.timeMs ?? 0,
        framesDetected: detected.length,
        averageConfidence,
        averageBox,
        score: 0,
      };
      result.score = scoreTrack(result, frameWidth, frameHeight, frames.length);
      return result;
    })
    .sort((a, b) => b.score - a.score);
}

/** Highest-scoring track (persistence × size × centrality), or null. */
export function selectPrimaryFaceTrack(tracks: readonly FaceTrack[]): FaceTrack | null {
  let best: FaceTrack | null = null;
  for (const track of tracks) {
    if (!best || track.score > best.score) best = track;
  }
  return best;
}

/** Pixel-space centers of a track over time — directly usable as
 * auto-reframe camera moves. Times are milliseconds on the analysis clock. */
export function faceTrackCenterKeyframes(
  track: FaceTrack,
): Array<{ timeMs: number; x: number; y: number }> {
  return track.points.map((point) => ({ timeMs: point.timeMs, ...boxCenter(point.box) }));
}

/**
 * Bounding box of a landmark set, in pixels. MediaPipe normalizes landmarks to
 * the analyzed image, so out-of-range or degenerate sets return null rather
 * than a bogus box.
 */
function landmarkBox(
  landmarks: readonly { x: number; y: number }[],
  width: number,
  height: number,
): FaceBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of landmarks) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || maxX <= minX || maxY <= minY) {
    return null;
  }
  const box = {
    x: minX * width,
    y: minY * height,
    width: (maxX - minX) * width,
    height: (maxY - minY) * height,
  };
  if (box.width <= 0 || box.height <= 0) return null;
  return box;
}

/**
 * MediaPipe's GPU delegate needs a working WebGL context. Where there is none
 * (headless browsers, VMs, servers) the failure surfaces in different ways — a
 * graph service error ("kGpuService ... was not provided"), a raw wasm call on
 * a missing context ("Cannot read properties of undefined (reading
 * 'activeTexture')"), or a failed graph start — so instead of pattern-matching
 * messages, a GPU failure simply buys the frame one retry on the CPU delegate,
 * which runs the same model wherever MediaPipe runs.
 */
const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** MediaPipe fails like this when the browser cannot create a WebGL context
 * (headless Chromium without SwiftShader, a VM, a blocklisted GPU driver). Even
 * the CPU delegate converts frames through WebGL, so no delegate can recover —
 * the caller deserves to be told that instead of a raw wasm TypeError. */
const WEBGL_REQUIRED_HINT =
  "MediaPipe Tasks needs a WebGL context and this browser could not create one, so face detection cannot run here.";
const withWebglHint = (error: unknown): Error | null =>
  /activeTexture|webgl|getContext/i.test(describeError(error))
    ? new Error(`${describeError(error)} (${WEBGL_REQUIRED_HINT})`)
    : null;

/** Production backend. MediaPipe is imported lazily so the module can be
 * loaded (and tested) in environments without the dependency's WASM assets. */
export function createMediaPipeFaceBackend(
  options: MediaPipeFaceBackendOptions = {},
): FaceDetectionBackend {
  const model = options.model ?? "blaze-face";
  const assets = getVisionAssets();
  const wasmBaseUrl = options.wasmBaseUrl ?? assets.wasmBaseUrl;
  const modelAssetPath =
    options.modelAssetPath ??
    (model === "face-landmarker" ? assets.faceLandmarkerAssetPath : assets.faceModelAssetPath);
  let delegate: "GPU" | "CPU" = options.delegate ?? "GPU";

  // The detector/landmarker instances are structurally different; keep the
  // smallest common surface we actually call.
  interface DetectorLike {
    detect(image: ImageBitmap): {
      detections?: Array<{
        boundingBox?: { originX: number; originY: number; width: number; height: number };
        keypoints?: Array<{ x: number; y: number; z?: number }>;
        categories?: Array<{ score: number; categoryName?: string }>;
      }>;
      faceLandmarks?: Array<Array<{ x: number; y: number; z?: number }>>;
      faceBlendshapes?: Array<{
        categories: Array<{ categoryName: string; score: number }>;
      }>;
    };
    close(): void;
  }

  let detector: DetectorLike | null = null;
  let createDetector: ((withDelegate: "GPU" | "CPU") => Promise<DetectorLike>) | null = null;
  let cpuFallbackUsed = false;

  return {
    async initialize(): Promise<void> {
      const tasksVision = (await import("@mediapipe/tasks-vision")) as unknown as {
        FilesetResolver: {
          forVisionTasks(path: string): Promise<unknown>;
        };
        FaceDetector: {
          createFromOptions(
            fileset: unknown,
            options: Record<string, unknown>,
          ): Promise<DetectorLike>;
        };
        FaceLandmarker: {
          createFromOptions(
            fileset: unknown,
            options: Record<string, unknown>,
          ): Promise<DetectorLike>;
        };
      };
      const fileset = await tasksVision.FilesetResolver.forVisionTasks(wasmBaseUrl);
      createDetector = async (withDelegate) => {
        if (model === "face-landmarker") {
          return tasksVision.FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath, delegate: withDelegate },
            runningMode: "IMAGE",
            numFaces: Math.max(1, options.numFaces ?? 5),
            outputFaceBlendshapes: options.outputBlendshapes ?? true,
          });
        }
        return tasksVision.FaceDetector.createFromOptions(fileset, {
          baseOptions: { modelAssetPath, delegate: withDelegate },
          runningMode: "IMAGE",
          minDetectionConfidence: options.minDetectionConfidence ?? 0.5,
          numFaces: Math.max(1, options.numFaces ?? 5),
        });
      };

      try {
        detector = await createDetector(delegate);
      } catch (error) {
        // Some hosts fail while building the GPU graph rather than at run time.
        if (delegate !== "GPU") throw error;
        delegate = "CPU";
        cpuFallbackUsed = true;
        try {
          detector = await createDetector(delegate);
        } catch (cpuError) {
          throw new Error(
            `Face detector could not initialize on the GPU delegate (${describeError(error)}) ` +
              `or the CPU fallback (${describeError(cpuError)})`,
          );
        }
      }
    },

    async detect(frame: ImageBitmap): Promise<DetectedFace[]> {
      if (!detector) throw new Error("Face backend is not initialized");
      let result: ReturnType<DetectorLike["detect"]>;
      try {
        result = detector.detect(frame);
      } catch (error) {
        if (delegate !== "GPU" || cpuFallbackUsed || !createDetector) {
          throw withWebglHint(error) ?? error;
        }
        // No usable GPU delegate: rebuild on the CPU and retry this frame so
        // detection keeps working instead of failing on every frame.
        cpuFallbackUsed = true;
        delegate = "CPU";
        try {
          detector.close();
        } catch {
          // The GPU context may already be gone; rebuilding does not need it.
        }
        try {
          detector = await createDetector(delegate);
          result = detector.detect(frame);
        } catch (cpuError) {
          throw (
            withWebglHint(cpuError) ??
            new Error(
              `Face detection failed on the GPU delegate (${describeError(error)}) ` +
                `and on the CPU fallback (${describeError(cpuError)})`,
            )
          );
        }
      }
      const faces: DetectedFace[] = [];
      if (result.detections) {
        for (const detection of result.detections) {
          const box = detection.boundingBox;
          if (!box) continue;
          const categories = detection.categories ?? [];
          faces.push({
            box: {
              x: box.originX,
              y: box.originY,
              width: box.width,
              height: box.height,
            },
            confidence: categories[0]?.score ?? 0.5,
            ...(detection.keypoints
              ? { keypoints: detection.keypoints.map(({ x, y, z }) => ({ x, y, ...(z !== undefined ? { z } : {}) })) }
              : {}),
          });
        }
      }
      if (result.faceLandmarks) {
        result.faceLandmarks.forEach((landmarks, index) => {
          if (landmarks.length === 0) return;
          const blendshapes: Record<string, number> = {};
          for (const shape of result.faceBlendshapes?.[index]?.categories ?? []) {
            blendshapes[shape.categoryName] = shape.score;
          }
          const mapped = landmarks.map(({ x, y, z }) => ({ x, y, ...(z !== undefined ? { z } : {}) }));
          const existing = faces[index];
          if (existing) {
            existing.landmarks = mapped;
            if (Object.keys(blendshapes).length > 0) existing.blendshapes = blendshapes;
            return;
          }
          // FaceLandmarker reports landmarks only (no `detections`), so derive
          // the box from the landmark extent. Landmarks are normalized to the
          // analyzed frame, hence the width/height multiplication.
          const box = landmarkBox(landmarks, frame.width, frame.height);
          if (!box) return;
          faces.push({
            box,
            confidence: LANDMARK_DETECTION_CONFIDENCE,
            landmarks: mapped,
            ...(Object.keys(blendshapes).length > 0 ? { blendshapes } : {}),
          });
        });
      }
      return faces;
    },

    dispose(): void {
      detector?.close();
      detector = null;
    },
  };
}

/**
 * One engine per document, mirroring `getPersonSegmentationEngine()`. Analysis
 * is batch-oriented (a clip is sampled, not streamed), so `analyze()` owns the
 * sampling loop and reports progress as it goes.
 */
export class FaceDetectionEngine {
  private backend: FaceDetectionBackend | null = null;
  private initializing: Promise<void> | null = null;
  private readonly backendFactory: () => FaceDetectionBackend;

  constructor(backendFactory: () => FaceDetectionBackend = () => createMediaPipeFaceBackend()) {
    this.backendFactory = backendFactory;
  }

  isInitialized(): boolean {
    return this.backend !== null;
  }

  async initialize(): Promise<void> {
    if (this.backend) return;
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      const backend = this.backendFactory();
      await backend.initialize();
      this.backend = backend;
    })();
    try {
      await this.initializing;
    } catch (error) {
      this.initializing = null;
      throw error;
    }
  }

  /** Detect faces in one already-decoded frame. */
  async detectFrame(frame: ImageBitmap, timeMs: number): Promise<FaceFrameResult> {
    await this.initialize();
    const backend = this.backend;
    if (!backend) throw new Error("Face detection engine failed to initialize");
    const faces = await backend.detect(frame, timeMs);
    return { timeMs, width: frame.width, height: frame.height, faces };
  }

  /**
   * Runs detection over a caller-supplied frame list (the host owns decoding),
   * then tracks identities across frames. Frames must be in ascending time
   * order; out-of-order entries are sorted.
   */
  async analyzeFrames(
    frames: ReadonlyArray<{ bitmap: ImageBitmap; timeMs: number }>,
    options: FaceAnalysisOptions & { onProgress?: (completed: number, total: number) => void } = {},
  ): Promise<FaceAnalysis> {
    await this.initialize();
    const ordered = [...frames].sort((a, b) => a.timeMs - b.timeMs);
    const warnings: string[] = [];
    const results: FaceFrameResult[] = [];
    for (let index = 0; index < ordered.length; index += 1) {
      const entry = ordered[index];
      try {
        results.push(await this.detectFrame(entry.bitmap, entry.timeMs));
      } catch (error) {
        // One bad frame must not fail an entire rotoscope/reframe analysis.
        warnings.push(
          `Face detection failed at ${Math.round(entry.timeMs)}ms: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      options.onProgress?.(index + 1, ordered.length);
    }
    const tracks = trackFaces(results, options);
    return {
      width: results[0]?.width ?? 0,
      height: results[0]?.height ?? 0,
      frames: results,
      tracks,
      primaryTrackId: selectPrimaryFaceTrack(tracks)?.id ?? null,
      sampledTimesMs: results.map((frame) => frame.timeMs),
      warnings,
    };
  }

  dispose(): void {
    this.backend?.dispose();
    this.backend = null;
    this.initializing = null;
  }
}

let faceDetectionEngineInstance: FaceDetectionEngine | null = null;

export function getFaceDetectionEngine(): FaceDetectionEngine {
  faceDetectionEngineInstance ??= new FaceDetectionEngine();
  return faceDetectionEngineInstance;
}

/** Test/host seam: replace the singleton (e.g. with a mock backend). */
export function setFaceDetectionEngine(engine: FaceDetectionEngine | null): void {
  faceDetectionEngineInstance = engine;
}
