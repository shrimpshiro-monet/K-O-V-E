import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoReframeEngine, DEFAULT_REFRAME_SETTINGS } from "./auto-reframe-engine";
import type { DetectedFace } from "./face-detection-engine";

const bitmap = (width = 1920, height = 1080): ImageBitmap =>
  ({ width, height, close: vi.fn() }) as unknown as ImageBitmap;

/** A subject walking steadily left across the frame, then stopping. */
const walkingFace = (frame: number): DetectedFace[] => {
  // 8 frames: crosses from x=1400 to x=560, then holds still for the last two.
  const x = frame < 6 ? 1400 - frame * 168 : 1400 - 5 * 168;
  return [{ box: { x, y: 340, width: 300, height: 300 }, confidence: 0.9 }];
};

/** The same walk, with the detector wobbling +/-24px from frame to frame. */
const jitteryFace = (frame: number): DetectedFace[] => {
  const x = frame < 6 ? 1400 - frame * 168 : 1400 - 5 * 168;
  return [
    { box: { x: x + (frame % 2 === 0 ? 24 : -24), y: 340, width: 300, height: 300 }, confidence: 0.9 },
  ];
};

const backend = (faces: (frame: number) => DetectedFace[]) => {
  let frame = 0;
  return {
    initialize: vi.fn(async () => undefined),
    detect: vi.fn(async () => {
      const detected = faces(frame);
      frame += 1;
      return detected;
    }),
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

/**
 * Largest single change in the camera's speed, as a fraction of its top speed.
 *
 * The renderer interpolates linearly, so velocity is constant along each
 * segment and can only change *at* a keyframe. A big step there reads as the
 * camera lurching. Normalizing by the path's peak speed (rather than by the
 * slower of the two segments) keeps the metric meaningful when the camera comes
 * to rest, where a relative comparison would report 100% however gentle the
 * approach was.
 */
function worstSpeedJump(keyframes: readonly { time: number; cropX: number; cropY: number }[]): number {
  const velocities: number[] = [];
  for (let index = 1; index < keyframes.length; index += 1) {
    const previous = keyframes[index - 1];
    const current = keyframes[index];
    const dt = Math.max(1e-6, current.time - previous.time);
    velocities.push(Math.hypot(current.cropX - previous.cropX, current.cropY - previous.cropY) / dt);
  }
  const peak = Math.max(...velocities, 0);
  if (peak < 1e-6) return 0;
  let worst = 0;
  for (let index = 1; index < velocities.length; index += 1) {
    worst = Math.max(worst, Math.abs(velocities[index] - velocities[index - 1]) / peak);
  }
  return worst;
}

describe("AutoReframeEngine camera path", () => {
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

  const analyze = async (
    smoothing: number,
    frames = 8,
    subject: (frame: number) => DetectedFace[] = walkingFace,
  ) => {
    const engine = new AutoReframeEngine();
    await engine.initialize();
    engine.setFaceBackend(backend(subject));
    const result = await engine.analyzeClip(
      Array.from({ length: frames }, () => bitmap()),
      4,
      {
        ...DEFAULT_REFRAME_SETTINGS,
        targetAspectRatio: "9:16" as const,
        followSubject: true,
        padding: 0,
        // Camera snaps straight to the subject: the least smoothed input the
        // path fitter can be handed, and where a lurch is most visible.
        trackingSpeed: 1,
        smoothing,
      },
    );
    return result;
  };

  it("keeps smoothing 0 meaning 'use the samples as they are'", async () => {
    const result = await analyze(0);

    expect(result.success).toBe(true);
    // One keyframe per analyzed frame, untouched.
    expect(result.keyframes).toHaveLength(8);
    expect(result.pathDeviationPx).toBe(0);
  });

  it("densifies the path so the camera stops changing speed in steps", async () => {
    const raw = await analyze(0);
    const smoothed = await analyze(0.6);

    expect(smoothed.keyframes.length).toBeGreaterThan(raw.keyframes.length);

    // A 9:16 crop of 16:9 footage can only pan horizontally, so there is no
    // curvature to smooth — the visible artefact is the camera's *speed*
    // stepping at every keyframe, because the renderer interpolates linearly
    // and therefore holds a constant velocity between neighbours. Measuring
    // the jump in velocity across each joint is what "smoother per-frame
    // motion" means for a pan.
    // Measured: the raw path stops dead in a single keyframe step (1.00 of its
    // own top speed); the fitted path eases out of it (~0.25). The margin is
    // tight enough to require the de-jittering pass too — the spline alone only
    // reaches ~0.49 here.
    expect(worstSpeedJump(smoothed.keyframes)).toBeLessThan(worstSpeedJump(raw.keyframes) * 0.35);
  });

  it("absorbs detector jitter instead of reproducing it as camera shake", async () => {
    const raw = await analyze(0, 8, jitteryFace);
    const smoothed = await analyze(0.8, 8, jitteryFace);

    // A wobbling detector makes the camera reverse direction between samples;
    // smoothing should take that out rather than follow it frame by frame.
    expect(worstSpeedJump(smoothed.keyframes)).toBeLessThan(worstSpeedJump(raw.keyframes) * 0.6);
  });

  it("reports the fit error and camera speed instead of hiding them", async () => {
    const result = await analyze(0.6);

    expect(result.pathDeviationPx).toBeGreaterThanOrEqual(0);
    expect(result.peakSpeedCropRatios).toBeGreaterThan(0);
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it("still follows the subject rather than flattening the move away", async () => {
    const smoothed = await analyze(0.8);

    const xs = smoothed.keyframes.map((keyframe) => keyframe.cropX + keyframe.cropWidth / 2);
    const span = Math.max(...xs) - Math.min(...xs);
    // The subject crossed most of the frame; the camera must cross with it.
    // The previous implementation averaged a short clip towards its own mean,
    // which collapsed this span and read as the camera giving up.
    expect(span).toBeGreaterThan(500);
  });

  it("never sends the crop outside the source frame", async () => {
    const smoothed = await analyze(0.5);

    for (const keyframe of smoothed.keyframes) {
      expect(keyframe.cropX).toBeGreaterThanOrEqual(0);
      expect(keyframe.cropY).toBeGreaterThanOrEqual(0);
      expect(keyframe.cropX + keyframe.cropWidth).toBeLessThanOrEqual(1920.001);
      expect(keyframe.cropY + keyframe.cropHeight).toBeLessThanOrEqual(1080.001);
    }
  });

  it("emits ascending keyframe times", async () => {
    const smoothed = await analyze(0.6);
    const times = smoothed.keyframes.map((keyframe) => keyframe.time);

    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times[0]).toBeCloseTo(0, 5);
  });

  it("warns that a 9:16 crop of 16:9 footage has no vertical freedom", async () => {
    const smoothed = await analyze(0.5);

    expect(smoothed.warnings?.join(" ")).toMatch(/no vertical freedom/i);
  });
});
