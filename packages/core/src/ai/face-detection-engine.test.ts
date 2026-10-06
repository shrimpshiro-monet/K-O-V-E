import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Records how the production backend configures MediaPipe. */
const mpCalls: { options: Record<string, unknown>; kind: string }[] = [];
let mpResult: Record<string, unknown> = {};
/** Errors the next `detect()` calls must throw, oldest first. */
let mpFailures: string[] = [];

vi.mock("@mediapipe/tasks-vision", () => {
  const createFromOptions = (kind: string) => async (_fileset: unknown, options: Record<string, unknown>) => {
    mpCalls.push({ kind, options });
    return {
      detect: () => {
        const failure = mpFailures.shift();
        if (failure) throw new Error(failure);
        return mpResult;
      },
      close: () => undefined,
    };
  };
  return {
    FilesetResolver: { forVisionTasks: async (path: string) => ({ path }) },
    FaceDetector: { createFromOptions: createFromOptions("FaceDetector") },
    FaceLandmarker: { createFromOptions: createFromOptions("FaceLandmarker") },
  };
});

import {
  FaceDetectionEngine,
  boxIou,
  createMediaPipeFaceBackend,
  faceTrackCenterKeyframes,
  sampleFrameTimes,
  selectPrimaryFaceTrack,
  trackFaces,
  type DetectedFace,
  type FaceDetectionBackend,
  type FaceFrameResult,
} from "./face-detection-engine";
import { resetVisionAssets, setVisionAssets } from "./vision-assets";

const FRAME_WIDTH = 1920;
const FRAME_HEIGHT = 1080;

const face = (x: number, y: number, width = 200, height = 200, confidence = 0.9): DetectedFace => ({
  box: { x, y, width, height },
  confidence,
});

const frame = (timeMs: number, faces: DetectedFace[]): FaceFrameResult => ({
  timeMs,
  width: FRAME_WIDTH,
  height: FRAME_HEIGHT,
  faces,
});

const bitmap = (width = FRAME_WIDTH, height = FRAME_HEIGHT): ImageBitmap =>
  ({ width, height, close: vi.fn() }) as unknown as ImageBitmap;

describe("sampleFrameTimes", () => {
  it("steps by the interval inside the range", () => {
    expect(sampleFrameTimes(0, 1000, 250, 100)).toEqual([0, 250, 500, 750, 1000]);
  });

  it("returns a single sample for ranges shorter than one interval", () => {
    expect(sampleFrameTimes(500, 600, 250, 100)).toEqual([500]);
  });

  it("decimates evenly when the interval would overflow maxSamples", () => {
    const times = sampleFrameTimes(0, 10_000, 100, 5);
    expect(times).toHaveLength(5);
    expect(times[0]).toBe(0);
    expect(times.at(-1)).toBe(10_000);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("never returns more than maxSamples even for a huge range", () => {
    expect(sampleFrameTimes(0, 3_600_000, 16, 12)).toHaveLength(12);
  });

  it("normalizes inverted ranges and negative starts", () => {
    expect(sampleFrameTimes(-500, -100, 100, 10)).toEqual([0]);
  });

  it("returns a finite sample when only one sample is allowed", () => {
    expect(sampleFrameTimes(0, 10_000, 100, 1)).toEqual([0]);
  });
});

describe("boxIou", () => {
  it("is 1 for identical boxes and 0 for disjoint boxes", () => {
    const a = { x: 0, y: 0, width: 100, height: 100 };
    expect(boxIou(a, { ...a })).toBeCloseTo(1);
    expect(boxIou(a, { x: 500, y: 500, width: 100, height: 100 })).toBe(0);
  });

  it("computes partial overlap", () => {
    const a = { x: 0, y: 0, width: 100, height: 100 };
    const b = { x: 50, y: 0, width: 100, height: 100 };
    // intersection 50x100 = 5000, union 20000 - 5000 = 15000
    expect(boxIou(a, b)).toBeCloseTo(5000 / 15000, 5);
  });
});

describe("trackFaces", () => {
  it("keeps one stable id for a face moving across frames", () => {
    const frames = [
      frame(0, [face(100, 100)]),
      frame(100, [face(140, 100)]),
      frame(200, [face(180, 100)]),
      frame(300, [face(220, 100)]),
    ];
    const tracks = trackFaces(frames);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].id).toBe("face-1");
    expect(tracks[0].framesDetected).toBe(4);
    // Default EMA alpha 0.5 lags a moving face: 100, 120, 150, 185.
    expect(tracks[0].points.map((point) => Math.round(point.box.x))).toEqual([
      100, 120, 150, 185,
    ]);
  });

  it("passes detection boxes through unsmoothed when smoothingAlpha is 1", () => {
    const frames = [
      frame(0, [face(100, 100)]),
      frame(100, [face(140, 100)]),
      frame(200, [face(180, 100)]),
    ];
    const tracks = trackFaces(frames, { smoothingAlpha: 1 });
    expect(tracks[0].points.map((point) => Math.round(point.box.x))).toEqual([100, 140, 180]);
  });

  it("separates two faces that never overlap", () => {
    const frames = [
      frame(0, [face(100, 100), face(1400, 600)]),
      frame(100, [face(120, 110), face(1390, 610)]),
    ];
    const tracks = trackFaces(frames);
    expect(tracks).toHaveLength(2);
    expect(new Set(tracks.map((track) => track.id)).size).toBe(2);
    const left = tracks.find((track) => track.averageBox.x < 500);
    const right = tracks.find((track) => track.averageBox.x > 1000);
    expect(left?.framesDetected).toBe(2);
    expect(right?.framesDetected).toBe(2);
  });

  it("bridges a one-frame gap instead of starting a new identity", () => {
    const frames = [
      frame(0, [face(100, 100)]),
      frame(100, []),
      frame(200, [face(110, 100)]),
    ];
    const tracks = trackFaces(frames, { maxMissedFrames: 1 });
    expect(tracks).toHaveLength(1);
    expect(tracks[0].framesDetected).toBe(2);
  });

  it("starts a new track once a face jumps beyond the IoU threshold", () => {
    const frames = [
      frame(0, [face(0, 0)]),
      frame(100, [face(900, 800)]),
    ];
    const tracks = trackFaces(frames);
    expect(tracks).toHaveLength(2);
  });

  it("drops implausibly large detections (full-frame false positives)", () => {
    const frames = [frame(0, [face(0, 0, FRAME_WIDTH, FRAME_HEIGHT, 0.99)])];
    expect(trackFaces(frames)).toHaveLength(0);
  });

  it("reports zero tracks for empty input and handles frames without faces", () => {
    expect(trackFaces([])).toEqual([]);
    expect(trackFaces([frame(0, [])])).toEqual([]);
  });

  it("scores a larger, central, persistent face as primary", () => {
    const frames = [
      frame(0, [face(50, 800, 80, 80, 0.9), face(800, 400, 320, 320, 0.9)]),
      frame(100, [face(55, 800, 80, 80, 0.9), face(810, 400, 320, 320, 0.9)]),
      frame(200, [face(60, 800, 80, 80, 0.9), face(820, 400, 320, 320, 0.9)]),
    ];
    const tracks = trackFaces(frames);
    const primary = selectPrimaryFaceTrack(tracks);
    expect(primary).not.toBeNull();
    expect(primary!.averageBox.width).toBeGreaterThan(300);
  });

  it("exposes pixel-space center keyframes for camera moves", () => {
    const tracks = trackFaces(
      [
        frame(0, [face(100, 100, 200, 200)]),
        frame(100, [face(200, 100, 200, 200)]),
      ],
      { smoothingAlpha: 1 },
    );
    const keyframes = faceTrackCenterKeyframes(tracks[0]);
    expect(keyframes).toHaveLength(2);
    expect(keyframes[0]).toEqual({ timeMs: 0, x: 200, y: 200 });
    expect(keyframes[1]).toEqual({ timeMs: 100, x: 300, y: 200 });
  });

  it("honours minTrackFrames", () => {
    const frames = [frame(0, [face(100, 100)]), frame(100, [])];
    expect(trackFaces(frames, { minTrackFrames: 2 })).toHaveLength(0);
  });
});

describe("trackFaces", () => {
  it("emits a track exactly once when it closes after a long gap", () => {
    const frames = [
      frame(0, [face(100, 100)]),
      frame(100, [face(120, 100)]),
      // face disappears: closed after maxMissedFrames (default 2)
      frame(200, []),
      frame(300, []),
      frame(400, []),
      // ...and the window keeps running with other content
      frame(500, [face(900, 300)]),
      frame(600, [face(920, 300)]),
    ];
    const tracks = trackFaces(frames);
    const ids = tracks.map((track) => track.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(tracks.filter((track) => track.points[0].timeMs === 0)).toHaveLength(1);
    expect(tracks).toHaveLength(2);
  });
});

describe("FaceDetectionEngine", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const backendReturning = (
    perFrame: DetectedFace[],
    onInit?: () => void,
  ): FaceDetectionBackend => ({
    initialize: vi.fn(async () => {
      onInit?.();
    }),
    detect: vi.fn(async () => perFrame.map((entry) => ({ ...entry }))),
    dispose: vi.fn(),
  });

  it("initializes lazily and only once", async () => {
    const initialize = vi.fn(async () => undefined);
    const engine = new FaceDetectionEngine(() => ({
      initialize,
      detect: vi.fn(async () => []),
      dispose: vi.fn(),
    }));
    expect(engine.isInitialized()).toBe(false);
    await engine.initialize();
    await engine.initialize();
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(engine.isInitialized()).toBe(true);
  });

  it("returns detections with the frame's own dimensions and timestamp", async () => {
    const engine = new FaceDetectionEngine(() => backendReturning([face(10, 20)]));
    const result = await engine.detectFrame(bitmap(640, 480), 1500);
    expect(result.timeMs).toBe(1500);
    expect(result.width).toBe(640);
    expect(result.height).toBe(480);
    expect(result.faces).toHaveLength(1);
    expect(result.faces[0].box.x).toBe(10);
  });

  it("analyzes a sorted sequence and picks a primary track", async () => {
    const engine = new FaceDetectionEngine(() => backendReturning([face(100, 100)]));
    const analysis = await engine.analyzeFrames([
      { bitmap: bitmap(), timeMs: 200 },
      { bitmap: bitmap(), timeMs: 0 },
      { bitmap: bitmap(), timeMs: 100 },
    ]);
    expect(analysis.sampledTimesMs).toEqual([0, 100, 200]);
    expect(analysis.tracks).toHaveLength(1);
    expect(analysis.primaryTrackId).toBe(analysis.tracks[0].id);
    expect(analysis.warnings).toEqual([]);
  });

  it("keeps going when a single frame fails, recording a warning", async () => {
    let calls = 0;
    const engine = new FaceDetectionEngine(() => ({
      initialize: vi.fn(async () => undefined),
      detect: vi.fn(async () => {
        calls += 1;
        if (calls === 2) throw new Error("decode hiccup");
        return [face(100, 100)];
      }),
      dispose: vi.fn(),
    }));
    const seen: number[] = [];
    const analysis = await engine.analyzeFrames(
      [
        { bitmap: bitmap(), timeMs: 0 },
        { bitmap: bitmap(), timeMs: 100 },
        { bitmap: bitmap(), timeMs: 200 },
      ],
      { onProgress: (completed) => seen.push(completed) },
    );
    expect(analysis.frames).toHaveLength(2);
    expect(analysis.warnings[0]).toContain("decode hiccup");
    expect(seen).toEqual([1, 2, 3]);
  });

  it("reports progress for every frame", async () => {
    const progress: Array<[number, number]> = [];
    const engine = new FaceDetectionEngine(() => backendReturning([]));
    await engine.analyzeFrames(
      [
        { bitmap: bitmap(), timeMs: 0 },
        { bitmap: bitmap(), timeMs: 100 },
      ],
      { onProgress: (completed, total) => progress.push([completed, total]) },
    );
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it("surfaces the backend's initialization failure", async () => {
    const engine = new FaceDetectionEngine(() => ({
      initialize: vi.fn(async () => {
        throw new Error("model unavailable");
      }),
      detect: vi.fn(async () => []),
      dispose: vi.fn(),
    }));
    await expect(engine.initialize()).rejects.toThrow("model unavailable");
    expect(engine.isInitialized()).toBe(false);
  });

  it("disposes the backend and allows re-initialization", async () => {
    const dispose = vi.fn();
    const engine = new FaceDetectionEngine(() => ({
      initialize: vi.fn(async () => undefined),
      detect: vi.fn(async () => []),
      dispose,
    }));
    await engine.initialize();
    engine.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(engine.isInitialized()).toBe(false);
    await engine.initialize();
    expect(engine.isInitialized()).toBe(true);
  });
});

describe("createMediaPipeFaceBackend", () => {
  beforeEach(() => {
    mpCalls.length = 0;
    mpResult = {};
    mpFailures = [];
    resetVisionAssets();
  });

  const landmarksFor = (points: { x: number; y: number }[]) => ({ faceLandmarks: [points] });

  it("synthesizes a pixel box from landmarker landmarks", async () => {
    mpResult = landmarksFor([
      { x: 0.25, y: 0.25 },
      { x: 0.5, y: 0.75 },
    ]);
    const backend = createMediaPipeFaceBackend({ model: "face-landmarker", delegate: "CPU" });
    await backend.initialize();
    const faces = await backend.detect(bitmap(400, 200));
    expect(faces).toHaveLength(1);
    expect(faces[0].box).toEqual({ x: 100, y: 50, width: 100, height: 100 });
    expect(faces[0].confidence).toBe(0.5);
    expect(faces[0].landmarks).toHaveLength(2);
    expect(mpCalls).toHaveLength(1);
    expect(mpCalls[0].kind).toBe("FaceLandmarker");
    expect((mpCalls[0].options.baseOptions as { delegate: string }).delegate).toBe("CPU");
  });

  it("attaches blendshapes without inventing a second face", async () => {
    mpResult = {
      ...landmarksFor([{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }]),
      faceBlendshapes: [{ categories: [{ categoryName: "jawOpen", score: 0.4 }] }],
    };
    const backend = createMediaPipeFaceBackend({ model: "face-landmarker" });
    await backend.initialize();
    const faces = await backend.detect(bitmap(100, 100));
    expect(faces).toHaveLength(1);
    expect(faces[0].blendshapes).toEqual({ jawOpen: 0.4 });
  });

  it("skips degenerate landmark sets instead of emitting a zero-size box", async () => {
    mpResult = landmarksFor([
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 0.5 },
    ]);
    const backend = createMediaPipeFaceBackend({ model: "face-landmarker" });
    await backend.initialize();
    expect(await backend.detect(bitmap(100, 100))).toEqual([]);
  });

  it("ignores non-finite landmarks when sizing the box", async () => {
    mpResult = landmarksFor([
      { x: Number.NaN, y: 0.2 },
      { x: 0.1, y: 0.1 },
      { x: 0.5, y: 0.6 },
    ]);
    const backend = createMediaPipeFaceBackend({ model: "face-landmarker" });
    await backend.initialize();
    const faces = await backend.detect(bitmap(200, 200));
    expect(faces).toHaveLength(1);
    // Box spans only the finite landmarks (0.1..0.5, 0.1..0.6) at 200px.
    expect(faces[0].box).toEqual({ x: 20, y: 20, width: 80, height: 100 });
  });

  it("still prefers detector bounding boxes when the task returns them", async () => {
    mpResult = {
      detections: [
        {
          boundingBox: { originX: 5, originY: 6, width: 7, height: 8 },
          categories: [{ score: 0.9 }],
        },
      ],
    };
    const backend = createMediaPipeFaceBackend({});
    await backend.initialize();
    const faces = await backend.detect(bitmap(100, 100));
    expect(faces).toEqual([{ box: { x: 5, y: 6, width: 7, height: 8 }, confidence: 0.9 }]);
    expect(mpCalls[0].kind).toBe("FaceDetector");
  });

  it("uses self-hosted asset URLs from the vision asset config", async () => {
    setVisionAssets({
      wasmBaseUrl: "http://localhost:8788/wasm",
      faceModelAssetPath: "http://localhost:8788/models/blaze_face_short_range.tflite",
    });
    const backend = createMediaPipeFaceBackend({});
    await backend.initialize();
    const baseOptions = mpCalls[0].options.baseOptions as { modelAssetPath: string };
    expect(baseOptions.modelAssetPath).toBe("http://localhost:8788/models/blaze_face_short_range.tflite");
  });

  it("retries the frame on the CPU delegate when the GPU delegate fails", async () => {
    mpResult = {
      detections: [{ boundingBox: { originX: 1, originY: 2, width: 3, height: 4 }, categories: [{ score: 0.8 }] }],
    };
    // What a machine without a WebGL context reports on every single frame.
    mpFailures = ["Cannot read properties of undefined (reading 'activeTexture')"];
    const backend = createMediaPipeFaceBackend({});
    await backend.initialize();
    const faces = await backend.detect(bitmap(100, 100));

    expect(faces).toEqual([{ box: { x: 1, y: 2, width: 3, height: 4 }, confidence: 0.8 }]);
    expect(mpCalls).toHaveLength(2);
    expect((mpCalls[0].options.baseOptions as { delegate: string }).delegate).toBe("GPU");
    expect((mpCalls[1].options.baseOptions as { delegate: string }).delegate).toBe("CPU");

    // The rebuild happens once: later frames go straight to the CPU detector.
    await backend.detect(bitmap(100, 100));
    expect(mpCalls).toHaveLength(2);
  });

  it("already-CPU backends never rebuild", async () => {
    mpFailures = ["frame is not a valid bitmap"];
    const backend = createMediaPipeFaceBackend({ delegate: "CPU" });
    await backend.initialize();
    await expect(backend.detect(bitmap(100, 100))).rejects.toThrow("frame is not a valid bitmap");
    expect(mpCalls).toHaveLength(1);
  });

  it("explains a WebGL-less browser instead of leaking a wasm TypeError", async () => {
    mpFailures = ["Cannot read properties of undefined (reading 'activeTexture')"];
    const backend = createMediaPipeFaceBackend({ delegate: "CPU" });
    await backend.initialize();
    await expect(backend.detect(bitmap(100, 100))).rejects.toThrow(
      /needs a WebGL context and this browser could not create one/,
    );
  });

  it("reports both delegates when the CPU fallback fails too", async () => {
    mpFailures = ["gpu exploded", "cpu exploded"];
    const backend = createMediaPipeFaceBackend({});
    await backend.initialize();
    await expect(backend.detect(bitmap(100, 100))).rejects.toThrow(
      "Face detection failed on the GPU delegate (gpu exploded) and on the CPU fallback (cpu exploded)",
    );
    expect(mpCalls).toHaveLength(2);
  });

  it("falls back to CPU when the GPU detector cannot even initialize", async () => {
    const failingCreate = async () => {
      throw new Error("emscripten_webgl_create_context() returned error 0");
    };
    const tasksVision = await import("@mediapipe/tasks-vision");
    const spy = vi
      .spyOn(tasksVision.FaceDetector, "createFromOptions")
      .mockImplementationOnce(failingCreate as never);
    try {
      const backend = createMediaPipeFaceBackend({});
      await backend.initialize();
      // Once on the GPU (which failed), then immediately on the CPU.
      expect(spy).toHaveBeenCalledTimes(2);
      const delegates = spy.mock.calls.map(
        (call) => (call[1] as { baseOptions: { delegate: string } }).baseOptions.delegate,
      );
      expect(delegates).toEqual(["GPU", "CPU"]);
      expect(await backend.detect(bitmap(100, 100))).toEqual([]);
      expect(mpCalls).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});
