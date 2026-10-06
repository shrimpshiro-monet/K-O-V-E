import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoReframeEngine, DEFAULT_REFRAME_SETTINGS } from "./auto-reframe-engine";
import type { DetectedFace } from "./face-detection-engine";

const bitmap = (width = 1920, height = 1080): ImageBitmap =>
  ({ width, height, close: vi.fn() }) as unknown as ImageBitmap;

const DETECTED: DetectedFace[] = [
  { box: { x: 1200, y: 200, width: 400, height: 400 }, confidence: 0.95 },
];

const backend = (faces: DetectedFace[] | (() => DetectedFace[])) => ({
  initialize: vi.fn(async () => undefined),
  detect: vi.fn(async () =>
    (typeof faces === "function" ? faces() : faces).map((face) => ({ ...face })),
  ),
  dispose: vi.fn(),
});


/** A backend that, like MediaPipe's, refuses to detect before initialize(). */
const uninitializedSensitiveBackend = () => {
  let ready = false;
  const detect = vi.fn(async () => {
    if (!ready) throw new Error("backing detector is not initialized");
    return DETECTED.map((face) => ({ ...face }));
  });
  return {
    initialize: vi.fn(async () => {
      ready = true;
    }),
    detect,
    dispose: vi.fn(),
  };
};

const blackContext = {
  drawImage: vi.fn(),
  getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => ({
    data: new Uint8ClampedArray(width * height * 4),
    width,
    height,
  })),
  clearRect: vi.fn(),
  fillRect: vi.fn(),
  putImageData: vi.fn(),
  save: vi.fn(),
  restore: vi.fn(),
  scale: vi.fn(),
  translate: vi.fn(),
};

describe("AutoReframeEngine face detection integration", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        width: number;
        height: number;
        constructor(width: number, height: number) {
          this.width = width;
          this.height = height;
        }
        getContext() {
          return blackContext;
        }
      },
    );
    vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap()));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const settings = {
    ...DEFAULT_REFRAME_SETTINGS,
    targetAspectRatio: "9:16" as const,
    followSubject: true,
    padding: 0,
    smoothing: 0.5,
  };

  it("drives the crop with a real detector when one is attached", async () => {
    const engine = new AutoReframeEngine();
    await engine.initialize();
    const detector = backend(DETECTED);
    engine.setFaceBackend(detector);

    const result = await engine.analyzeClip([bitmap(), bitmap()], 30, settings);

    expect(result.success).toBe(true);
    expect(engine.usesFaceBackend()).toBe(true);
    expect(detector.detect).toHaveBeenCalledTimes(2);
    // The face sits on the right; a 9:16 crop must move right of center.
    const keyframe = result.keyframes[0];
    expect(Number.isFinite(keyframe.cropX)).toBe(true);
    expect(Number.isFinite(keyframe.cropY)).toBe(true);
    expect(keyframe.cropX + keyframe.cropWidth / 2).toBeGreaterThan(1920 / 2);
    // The skin-tone fallback must never run while the detector is healthy.
    expect(blackContext.getImageData).not.toHaveBeenCalled();
  });

  it("falls back to skin-tone detection once, then stays on it", async () => {
    const engine = new AutoReframeEngine();
    await engine.initialize();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failing = backend(() => {
      throw new Error("WASM crashed");
    });
    engine.setFaceBackend(failing);

    const result = await engine.analyzeClip([bitmap(), bitmap(), bitmap()], 30, settings);

    expect(result.success).toBe(true);
    expect(engine.usesFaceBackend()).toBe(false);
    // Only the first frame attempted the broken backend.
    expect(failing.detect).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    // Fallback ran on every frame instead.
    expect(blackContext.getImageData).toHaveBeenCalledTimes(3);
  });

  it("uses the fallback when no detector is attached", async () => {
    const engine = new AutoReframeEngine();
    await engine.initialize();
    engine.setFaceBackend(null);

    await engine.analyzeClip([bitmap()], 30, settings);

    expect(engine.usesFaceBackend()).toBe(false);
    expect(engine.getFaceBackend()).toBeNull();
    expect(blackContext.getImageData).toHaveBeenCalledTimes(1);
  });

  it("clears cached detections when the backend changes", async () => {
    const engine = new AutoReframeEngine();
    await engine.initialize();
    const first = backend(DETECTED);
    engine.setFaceBackend(first);
    await engine.analyzeClip([bitmap()], 30, settings);
    expect(first.detect).toHaveBeenCalledTimes(1);

    const second = backend([]);
    engine.setFaceBackend(second);
    await engine.analyzeClip([bitmap()], 30, settings);
    expect(second.detect).toHaveBeenCalledTimes(1);
  });

  it("initializes an attached detector before the first frame", async () => {
    const engine = new AutoReframeEngine();
    const detector = uninitializedSensitiveBackend();
    engine.setFaceBackend(detector);

    await engine.initialize();
    const result = await engine.analyzeClip([bitmap()], 30, settings);

    expect(detector.initialize).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(engine.usesFaceBackend()).toBe(true);
    expect(detector.detect).toHaveBeenCalledTimes(1);
    // If the engine had skipped initialization, the detector would have thrown
    // and the heuristic would have taken over silently.
    expect(blackContext.getImageData).not.toHaveBeenCalled();
  });

  it("initializes a detector attached after the engine was initialized", async () => {
    const engine = new AutoReframeEngine();
    await engine.initialize();

    const detector = uninitializedSensitiveBackend();
    engine.setFaceBackend(detector);
    await engine.analyzeClip([bitmap()], 30, settings);

    expect(detector.initialize).toHaveBeenCalledTimes(1);
    expect(engine.usesFaceBackend()).toBe(true);
  });

  it("degrades to the heuristic when the detector cannot initialize", async () => {
    const engine = new AutoReframeEngine();
    await engine.initialize();
    engine.setFaceBackend({
      initialize: vi.fn(async () => {
        throw new Error("model unavailable");
      }),
      detect: vi.fn(async () => DETECTED.map((face) => ({ ...face }))),
      dispose: vi.fn(),
    });

    const result = await engine.analyzeClip([bitmap()], 30, settings);

    expect(result.success).toBe(true);
    expect(engine.usesFaceBackend()).toBe(false);
    expect(blackContext.getImageData).toHaveBeenCalled();
  });
});
