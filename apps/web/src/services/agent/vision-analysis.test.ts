import { describe, expect, it, vi } from "vitest";
import type { AlphaMask, Mask } from "@kove-advanced/core";
import {
  analyzeAutoReframe,
  analyzeFacesInMedia,
  analyzeSubjectMatte,
  applyRotoscopeKeyframeTime,
  measureFrameMotion,
  planAdaptiveSampleTimes,
  resolveSamplingWindow,
  writeMatteToMasks,
  type DecodedFrame,
  type VideoFrameDecoder,
} from "./vision-analysis";

const discMask = (size: number, centerX: number, radius: number): AlphaMask => {
  const data = new Uint8ClampedArray(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (Math.hypot(x - centerX, y - size / 2) <= radius) data[y * size + x] = 255;
    }
  }
  return { data, width: size, height: size };
};

const emptyMask = (size: number): AlphaMask => ({
  data: new Uint8ClampedArray(size * size),
  width: size,
  height: size,
});

const bitmap = (): ImageBitmap =>
  ({ width: 100, height: 100, close: vi.fn() }) as unknown as ImageBitmap;

const decoder = (frames: Array<{ timeMs: number }>): VideoFrameDecoder =>
  vi.fn(
    async (
      _blob: Blob,
      times: readonly number[],
      options?: { onProgress?: (done: number, total: number) => void },
    ): Promise<DecodedFrame[]> => {
      const decoded =
        frames.length > 0
          ? frames.map((frame) => ({ bitmap: bitmap(), timeMs: frame.timeMs }))
          : times.map((timeMs) => ({ bitmap: bitmap(), timeMs }));
      decoded.forEach((_, index) => options?.onProgress?.(index + 1, decoded.length));
      return decoded;
    },
  );

const baseMask: Mask = {
  id: "mask-existing",
  clipId: "c1",
  type: "drawn",
  path: { closed: true, points: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }] },
  feathering: 0,
  inverted: false,
  expansion: 0,
  opacity: 1,
  keyframes: [],
};

describe("resolveSamplingWindow", () => {
  it("clamps the requested window to the media duration", () => {
    const window = resolveSamplingWindow(10, { endTime: 999, intervalMs: 500, maxFrames: 4 });
    expect(window.startMs).toBe(0);
    expect(window.endMs).toBe(10_000);
    expect(window.timesMs).toHaveLength(4);
    expect(window.timesMs[0]).toBe(0);
    expect(window.timesMs.at(-1)).toBe(10_000);
  });

  it("honours an explicit start/end in source seconds", () => {
    const window = resolveSamplingWindow(30, { startTime: 5, endTime: 6, intervalMs: 250, maxFrames: 10 });
    expect(window.timesMs).toEqual([5000, 5250, 5500, 5750, 6000]);
  });

  it("never samples past a zero duration", () => {
    const window = resolveSamplingWindow(0, {});
    expect(window.timesMs).toEqual([0]);
  });
});

describe("analyzeFacesInMedia", () => {
  it("decodes sampled frames, runs the engine, and shapes the result", async () => {
    const engine = {
      analyzeFrames: vi.fn(async (frames: readonly { bitmap: ImageBitmap; timeMs: number }[]) => ({
        width: 1920,
        height: 1080,
        frames: frames.map((frame) => ({ timeMs: frame.timeMs, width: 1920, height: 1080, faces: [] })),
        tracks: [
          {
            id: "face-1",
            points: [],
            firstTimeMs: 0,
            lastTimeMs: 1000,
            framesDetected: 2,
            averageConfidence: 0.9,
            averageBox: { x: 10, y: 10, width: 100, height: 100 },
            score: 0.7,
          },
        ],
        primaryTrackId: "face-1",
        sampledTimesMs: frames.map((frame) => frame.timeMs),
        warnings: [],
      })),
    };
    const decode = decoder([]);
    const progress: number[] = [];

    const result = await analyzeFacesInMedia({
      blob: new Blob(["x"]),
      durationSeconds: 2,
      request: { mediaId: "m1", intervalMs: 1000, maxFrames: 10 },
      faceEngine: engine,
      decode,
      onProgress: (done) => progress.push(done),
    });

    expect(decode).toHaveBeenCalledTimes(1);
    const times = (decode as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as number[];
    expect(times).toEqual([0, 1000, 2000]);
    expect(result.sampledFrames).toBe(3);
    expect(result.primaryTrackId).toBe("face-1");
    expect(result.tracks[0].averageBox.width).toBe(100);
    expect(progress.length).toBeGreaterThan(0);
  });
});

describe("analyzeSubjectMatte", () => {
  it("builds a rotoscope plan from segmentation mattes", async () => {
    const sampleMask = vi.fn(async (_bitmap: ImageBitmap, timeMs: number) =>
      discMask(64, 12 + timeMs / 100, 10),
    );
    const analysis = await analyzeSubjectMatte({
      blob: new Blob(["x"]),
      durationSeconds: 1,
      streamId: "test",
      request: { mediaId: "m1", intervalMs: 250, maxFrames: 10 },
      decode: decoder([]),
      sampleMask,
    });

    expect(sampleMask).toHaveBeenCalledTimes(5);
    expect(analysis.result.keyframeCount).toBeGreaterThan(0);
    expect(analysis.result.keyframes[0].pointCount).toBeGreaterThanOrEqual(3);
    expect(analysis.plan.keyframes[0].path.closed).toBe(true);
    expect(analysis.maskWidth).toBe(64);
    expect(analysis.result.averageCoverage).toBeGreaterThan(0);
  });

  it("reports a clean failure when segmentation yields nothing", async () => {
    const analysis = await analyzeSubjectMatte({
      blob: new Blob(["x"]),
      durationSeconds: 1,
      streamId: "test",
      request: { mediaId: "m1", intervalMs: 500, maxFrames: 4 },
      decode: decoder([]),
      sampleMask: async () => null,
    });

    expect(analysis.result.keyframeCount).toBe(0);
    expect(analysis.result.sampledFrames).toBe(3);
    expect(analysis.result.warnings[0]).toContain("subject model");
    expect(analysis.plan.warnings[0]).toContain("No mattes");
  });

  it("treats an all-empty matte as no subject without throwing", async () => {
    const analysis = await analyzeSubjectMatte({
      blob: new Blob(["x"]),
      durationSeconds: 1,
      streamId: "test",
      request: { mediaId: "m1", intervalMs: 1000, maxFrames: 3 },
      decode: decoder([]),
      sampleMask: async () => emptyMask(32),
    });
    expect(analysis.result.keyframeCount).toBe(0);
    expect(analysis.result.missedFrames).toBeGreaterThan(0);
  });
});

describe("applyRotoscopeKeyframeTime", () => {
  it("maps source ms onto the timeline at 1x", () => {
    expect(applyRotoscopeKeyframeTime(2000, { startTime: 10, inPoint: 1, speed: 1 })).toBeCloseTo(11);
  });

  it("accounts for speed and reverse", () => {
    expect(applyRotoscopeKeyframeTime(2000, { startTime: 0, inPoint: 0, speed: 2 })).toBeCloseTo(1);
    expect(
      applyRotoscopeKeyframeTime(2000, {
        startTime: 0,
        inPoint: 0,
        outPoint: 2,
        speed: 1,
        reversed: true,
      }),
    ).toBeCloseTo(0);
  });
});

describe("writeMatteToMasks", () => {
  const plan = {
    keyframes: [
      {
        timeMs: 0,
        path: { closed: true as const, points: [{ x: 0.2, y: 0.2 }, { x: 0.4, y: 0.2 }, { x: 0.4, y: 0.4 }] },
        coverage: 0.2,
        centroid: { x: 0.3, y: 0.3 },
        pointCount: 3,
      },
      {
        timeMs: 1000,
        path: { closed: true as const, points: [{ x: 0.3, y: 0.2 }, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.4 }] },
        coverage: 0.2,
        centroid: { x: 0.4, y: 0.3 },
        pointCount: 3,
      },
    ],
    sampledFrames: 2,
    missedFrames: 1,
    averageCoverage: 0.2,
    boundingBox: { x: 0.2, y: 0.2, width: 0.3, height: 0.2 },
    warnings: [],
  };

  it("creates a mask with timeline keyframes and one id per keyframe", () => {
    let counter = 0;
    const result = writeMatteToMasks({
      masks: [],
      clipId: "c1",
      plan,
      timeMapping: { startTime: 5, inPoint: 0, speed: 1 },
      createId: () => `id-${++counter}`,
    });

    expect(result.masks).toHaveLength(1);
    const mask = result.masks[0];
    expect(mask.clipId).toBe("c1");
    expect(mask.type).toBe("drawn");
    expect(mask.keyframes.map((keyframe) => keyframe.time)).toEqual([5, 6]);
    expect(result.keyframeCount).toBe(2);
    expect(result.firstTimeSeconds).toBe(5);
    expect(result.lastTimeSeconds).toBe(6);
    // Creates keyframe ids through the injected generator (mask id is id-1).
    expect(new Set(mask.keyframes.map((keyframe) => keyframe.id)).size).toBe(2);
    expect(result.warnings[0]).toContain("no subject");
  });

  it("extends an existing mask and replaces duplicate timestamps", () => {
    const first = writeMatteToMasks({
      masks: [baseMask],
      clipId: "c1",
      maskId: "mask-existing",
      plan,
      timeMapping: { startTime: 0, inPoint: 0, speed: 1 },
      featherPx: 8,
      expansionPx: -2,
      invertMask: true,
      createId: (() => {
        let id = 0;
        return () => `kf-${++id}`;
      })(),
    });

    expect(first.masks).toHaveLength(1);
    expect(first.masks[0].id).toBe("mask-existing");
    expect(first.masks[0].feathering).toBe(8);
    expect(first.masks[0].expansion).toBe(-2);
    expect(first.masks[0].inverted).toBe(true);
    expect(first.masks[0].keyframes).toHaveLength(2);

    // Re-applying the same plan must not stack duplicate keyframes.
    const second = writeMatteToMasks({
      masks: first.masks,
      clipId: "c1",
      maskId: "mask-existing",
      plan,
      timeMapping: { startTime: 0, inPoint: 0, speed: 1 },
      createId: () => "kf-again",
    });
    expect(second.masks[0].keyframes).toHaveLength(2);
    expect(second.keyframeCount).toBe(2);
  });

  it("throws for an unknown mask id", () => {
    expect(() =>
      writeMatteToMasks({
        masks: [],
        clipId: "c1",
        maskId: "nope",
        plan,
        timeMapping: { startTime: 0, inPoint: 0, speed: 1 },
        createId: () => "id",
      }),
    ).toThrow("Mask not found");
  });

  it("leaves other clips' masks untouched", () => {
    const other = { ...baseMask, id: "mask-other" };
    const result = writeMatteToMasks({
      masks: [other],
      clipId: "c1",
      plan,
      timeMapping: { startTime: 0, inPoint: 0, speed: 1 },
      createId: (() => {
        let id = 0;
        return () => `id-${++id}`;
      })(),
    });
    expect(result.masks).toHaveLength(2);
    expect(result.masks[0]).toBe(other);
  });

  it("keeps clip speed and reverse in the keyframe timeline", () => {
    const result = writeMatteToMasks({
      masks: [],
      clipId: "c1",
      plan,
      timeMapping: { startTime: 2, inPoint: 0, speed: 2 },
      createId: (() => {
        let id = 0;
        return () => `id-${++id}`;
      })(),
    });
    // 1000ms of source at 2x is 0.5s of timeline.
    expect(result.masks[0].keyframes.map((keyframe) => keyframe.time)).toEqual([2, 2.5]);
  });
});

/** A plan whose subject moves fast in the middle and settles at the end. */
const movingPlan = {
  keyframes: [
    {
      timeMs: 0,
      path: { closed: true as const, points: [{ x: 0.1, y: 0.1 }] },
      coverage: 0.2,
      centroid: { x: 0.2, y: 0.5 },
      pointCount: 3,
    },
    {
      timeMs: 1000,
      path: { closed: true as const, points: [{ x: 0.5, y: 0.1 }] },
      coverage: 0.3,
      centroid: { x: 0.5, y: 0.5 },
      pointCount: 3,
    },
    {
      timeMs: 2000,
      path: { closed: true as const, points: [{ x: 0.5, y: 0.1 }] },
      coverage: 0.3,
      centroid: { x: 0.5, y: 0.5 },
      pointCount: 3,
    },
  ],
  sampledFrames: 3,
  missedFrames: 0,
  averageCoverage: 0.27,
  boundingBox: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 },
  warnings: [],
};

describe("writeMatteToMasks edge refinement", () => {
  const ids = () => {
    let id = 0;
    return () => `kf-${++id}`;
  };

  it("writes a per-keyframe feather that follows the subject's motion", () => {
    const result = writeMatteToMasks({
      masks: [],
      clipId: "c1",
      plan: movingPlan,
      timeMapping: { startTime: 0, inPoint: 0, speed: 1 },
      edge: { featherPx: 4, expansionPx: 0, motionSensitivity: 1, maxFeatherPx: 12 },
      createId: ids(),
    });

    const feathers = result.masks[0].keyframes.map((keyframe) => keyframe.feathering);
    // The subject moves between the first two keyframes and is still for the
    // last one, so the edge tightens back to base at the end.
    expect(feathers[0]).toBeCloseTo(12, 5);
    expect(feathers[1]).toBeCloseTo(12, 5);
    expect(feathers[2]).toBeCloseTo(4, 5);
  });

  it("uses the mask-level feather as the default a keyframe inherits", () => {
    const result = writeMatteToMasks({
      masks: [],
      clipId: "c1",
      plan: movingPlan,
      timeMapping: { startTime: 0, inPoint: 0, speed: 1 },
      edge: { featherPx: 6, expansionPx: -3, invert: true, opacity: 0.8 },
      createId: ids(),
    });

    const mask = result.masks[0];
    expect(mask.feathering).toBe(6);
    expect(mask.expansion).toBe(-3);
    expect(mask.inverted).toBe(true);
    expect(mask.opacity).toBe(0.8);
  });

  it("reports the feather range it actually wrote", () => {
    const result = writeMatteToMasks({
      masks: [],
      clipId: "c1",
      plan: movingPlan,
      timeMapping: { startTime: 0, inPoint: 0, speed: 1 },
      edge: { featherPx: 4, expansionPx: 0, motionSensitivity: 1, maxFeatherPx: 12 },
      createId: ids(),
    });

    expect(result.edge?.minFeatherPx).toBeCloseTo(4, 5);
    expect(result.edge?.maxFeatherPx).toBeCloseTo(12, 5);
    expect(result.edge?.motion).toHaveLength(3);
    expect(Math.max(...(result.edge?.motion ?? []))).toBeCloseTo(1, 5);
  });

  it("leaves keyframes without overrides when no edge is requested", () => {
    const result = writeMatteToMasks({
      masks: [],
      clipId: "c1",
      plan: movingPlan,
      timeMapping: { startTime: 0, inPoint: 0, speed: 1 },
      featherPx: 8,
      createId: ids(),
    });

    const mask = result.masks[0];
    expect(mask.feathering).toBe(8);
    // Flat edge: the renderer falls back to the mask-level value everywhere.
    expect(mask.keyframes.every((keyframe) => keyframe.feathering === undefined)).toBe(true);
    expect(result.edge).toBeUndefined();
  });

  it("replaces the per-keyframe overrides when re-applied with new settings", () => {
    const first = writeMatteToMasks({
      masks: [],
      clipId: "c1",
      plan: movingPlan,
      timeMapping: { startTime: 0, inPoint: 0, speed: 1 },
      edge: { featherPx: 2, expansionPx: 0, motionSensitivity: 1, maxFeatherPx: 20 },
      createId: ids(),
    });

    const second = writeMatteToMasks({
      masks: first.masks,
      clipId: "c1",
      maskId: first.maskId,
      plan: movingPlan,
      timeMapping: { startTime: 0, inPoint: 0, speed: 1 },
      edge: { featherPx: 2, expansionPx: 0, motionSensitivity: 0 },
      createId: ids(),
    });

    // Sensitivity 0 => uniform feather, so the earlier widening is gone.
    expect(second.masks[0].keyframes.map((keyframe) => keyframe.feathering)).toEqual([2, 2, 2]);
    expect(second.masks[0].keyframes).toHaveLength(3);
  });

  it("keeps the edge aligned with the clip's speed and in-point", () => {
    const result = writeMatteToMasks({
      masks: [],
      clipId: "c1",
      plan: movingPlan,
      timeMapping: { startTime: 10, inPoint: 0, speed: 2 },
      edge: { featherPx: 4, expansionPx: 0, motionSensitivity: 1, maxFeatherPx: 12 },
      createId: ids(),
    });

    const mask = result.masks[0];
    expect(mask.keyframes.map((keyframe) => keyframe.time)).toEqual([10, 10.5, 11]);
    // The feather belongs to the shape at that time, so it travels with it.
    expect(mask.keyframes[2].feathering).toBeCloseTo(4, 5);
  });

  it("surfaces edge-plan warnings alongside the matte's own", () => {
    const result = writeMatteToMasks({
      masks: [],
      clipId: "c1",
      plan: { ...movingPlan, keyframes: [] },
      timeMapping: { startTime: 0, inPoint: 0, speed: 1 },
      edge: { featherPx: 4, expansionPx: 0 },
      createId: ids(),
    });

    expect(result.warnings.join(" ")).toMatch(/no keyframes/i);
  });
});

/** An auto-reframe engine double: no canvas, no model, deterministic plan. */
const reframeEngine = (
  plan: Partial<{
    keyframes: Array<{ time: number; cropX: number; cropY: number; cropWidth: number; cropHeight: number; scale: number }>;
    outputWidth: number;
    outputHeight: number;
    success: boolean;
    message: string;
    pathDeviationPx: number;
    peakSpeedCropRatios: number;
    warnings: string[];
  }> = {},
) => {
  const resolved = {
    keyframes: [
      { time: 0, cropX: 200, cropY: 0, cropWidth: 608, cropHeight: 960, scale: 1 },
      { time: 1, cropX: 500, cropY: 0, cropWidth: 608, cropHeight: 960, scale: 1 },
      { time: 2, cropX: 900, cropY: 0, cropWidth: 608, cropHeight: 960, scale: 1 },
    ],
    outputWidth: 1080,
    outputHeight: 1920,
    success: true,
    ...plan,
  };
  return {
    initialize: vi.fn(async () => undefined),
    getFaceBackend: vi.fn(() => null),
    setFaceBackend: vi.fn(),
    usesFaceBackend: vi.fn(() => true),
    analyzeClip: vi.fn(async () => resolved),
  } as unknown as import("@kove-advanced/core").AutoReframeEngine;
};

describe("analyzeAutoReframe", () => {
  const deps = (engine: ReturnType<typeof reframeEngine>) => ({
    blob: new Blob(["video"]),
    durationSeconds: 4,
    request: { mediaId: "m1" },
    settings: {
      targetAspectRatio: "9:16" as const,
      trackingSpeed: 0.5,
      padding: 0.1,
      smoothing: 0.8,
      followSubject: true,
      centerBias: 0.3,
    },
    mediaWidth: 1920,
    mediaHeight: 1080,
    canvasWidth: 1080,
    canvasHeight: 1920,
    decode: decoder([]) as never,
    engine,
    createId: () => "id",
  });

  it("turns the crop plan into camera keyframes", async () => {
    const engine = reframeEngine();
    const analysis = await analyzeAutoReframe(deps(engine));

    // One sampled frame per plan keyframe, decoded through the injected decoder.
    expect(analysis.sampledFrames).toBeGreaterThan(0);
    expect(analysis.keyframes.length).toBeGreaterThan(0);
    // Every animated camera property is present.
    const properties = new Set(analysis.keyframes.map((keyframe) => keyframe.property));
    expect([...properties].sort()).toEqual([
      "position.x",
      "position.y",
      "scale.x",
      "scale.y",
    ]);
  });

  it("surfaces the path fit and camera speed the engine measured", async () => {
    const engine = reframeEngine({ pathDeviationPx: 2.75, peakSpeedCropRatios: 0.42 });
    const analysis = await analyzeAutoReframe(deps(engine));

    expect(analysis.pathDeviationPx).toBe(2.75);
    expect(analysis.peakSpeedCropRatios).toBe(0.42);
  });

  it("surfaces the engine's own warnings about the camera move", async () => {
    const engine = reframeEngine({
      warnings: ["The crop fills the frame vertically, so the camera has no vertical freedom."],
    });
    const analysis = await analyzeAutoReframe(deps(engine));

    expect(analysis.warnings.join(" ")).toMatch(/no vertical freedom/i);
  });

  it("fails loudly when the engine cannot produce a plan", async () => {
    const engine = reframeEngine({ success: false, message: "Engine not initialized" });

    await expect(analyzeAutoReframe(deps(engine))).rejects.toThrow("Engine not initialized");
  });

  it("warns when the camera ends up static", async () => {
    const engine = reframeEngine({
      keyframes: [{ time: 0, cropX: 500, cropY: 0, cropWidth: 608, cropHeight: 960, scale: 1 }],
    });
    const analysis = await analyzeAutoReframe(deps(engine));

    expect(analysis.warnings.join(" ")).toMatch(/static crop/i);
  });
});

describe("planAdaptiveSampleTimes", () => {
  it("keeps the base grid untouched when nothing moves", () => {
    const plan = planAdaptiveSampleTimes([0, 500, 1000, 1500], [0, 0, 0], { maxFrames: 12 });

    expect(plan.timesMs).toEqual([0, 500, 1000, 1500]);
    expect(plan.refinedTimesMs).toEqual([]);
  });

  it("spends the whole budget inside the busy interval", () => {
    const plan = planAdaptiveSampleTimes([0, 1000, 2000, 3000], [0, 10, 0], { maxFrames: 8 });

    expect(plan.refinedTimesMs).toHaveLength(4);
    for (const time of plan.refinedTimesMs) {
      expect(time).toBeGreaterThan(1000);
      expect(time).toBeLessThan(2000);
    }
  });

  it("ranks by motion density, not by raw score", () => {
    // The long interval moves more in total; the short one moves far more per
    // millisecond. Refinement follows the rate, or a slow drift across a whole
    // clip would eat the budget that a fast cut needs.
    const plan = planAdaptiveSampleTimes([0, 3000, 3200], [1, 0.9], { maxFrames: 4 });

    expect(plan.refinedTimesMs).toEqual([3100]);
  });

  it("never splits below the interval floor", () => {
    // 100ms intervals would halve to 50ms, under the 60ms floor, so the grid
    // stands. One level of splitting *is* allowed when it stays above it.
    expect(planAdaptiveSampleTimes([0, 100, 200], [1, 1], { maxFrames: 60, minIntervalMs: 60 }).refinedTimesMs).toEqual(
      [],
    );
    expect(planAdaptiveSampleTimes([0, 100, 200], [1, 1], { maxFrames: 60, minIntervalMs: 40 }).refinedTimesMs).toEqual([
      50, 150,
    ]);
  });

  it("respects the total frame budget", () => {
    const plan = planAdaptiveSampleTimes([0, 1000, 2000, 3000, 4000], [5, 5, 5, 5], { maxFrames: 9 });

    expect(plan.timesMs).toHaveLength(9);
    expect(plan.timesMs).toEqual([...plan.timesMs].sort((a, b) => a - b));
  });

  it("keeps every base sample, so refinement only ever adds", () => {
    const base = [0, 500, 1000, 1500, 2000];
    const plan = planAdaptiveSampleTimes(base, [1, 0, 0, 4], { maxFrames: 10 });

    for (const time of base) expect(plan.timesMs).toContain(time);
    expect(plan.timesMs.length).toBeGreaterThan(base.length);
  });

  it("ignores non-finite scores instead of refining a broken interval", () => {
    const plan = planAdaptiveSampleTimes([0, 1000, 2000], [Number.NaN, Number.POSITIVE_INFINITY], {
      maxFrames: 10,
    });

    expect(plan.timesMs).toEqual([0, 1000, 2000]);
  });

  it("has nothing to refine on a single sample", () => {
    expect(planAdaptiveSampleTimes([0], [], { maxFrames: 10 })).toEqual({
      timesMs: [0],
      refinedTimesMs: [],
    });
  });
});

describe("measureFrameMotion", () => {
  it("reports no motion for frames it cannot draw, instead of throwing", () => {
    // These bitmaps are plain stubs with no pixels, so every thumbnail is blank
    // and the difference is zero — the point is that an unreadable frame
    // degrades to "no motion" rather than failing the whole analysis.
    expect(measureFrameMotion([{ bitmap: bitmap(), timeMs: 0 }, { bitmap: bitmap(), timeMs: 500 }])).toEqual([0]);
  });

  it("has nothing to compare on a single frame", () => {
    expect(measureFrameMotion([{ bitmap: bitmap(), timeMs: 0 }])).toEqual([]);
  });
});

describe("analyzeAutoReframe motion-adaptive sampling", () => {
  const settings = {
    targetAspectRatio: "9:16" as const,
    trackingSpeed: 0.5,
    padding: 0.1,
    smoothing: 0.8,
    followSubject: true,
    centerBias: 0.3,
  };

  /** 4s at the default 500ms grid is nine base samples. */
  const baseDeps = (
    decode: VideoFrameDecoder,
    engine: ReturnType<typeof reframeEngine>,
    request: Record<string, unknown> = {},
  ) => ({
    blob: new Blob(["video"]),
    durationSeconds: 4,
    request: { mediaId: "m1", ...request },
    settings,
    mediaWidth: 1920,
    mediaHeight: 1080,
    canvasWidth: 1080,
    canvasHeight: 1920,
    decode,
    engine,
  });

  const calls = (decode: VideoFrameDecoder) =>
    (decode as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1] as number[]);

  /** All motion in the 2000–2500ms interval; the rest of the clip is still. */
  const spike = (frames: readonly DecodedFrame[]) =>
    frames.slice(1).map((frame) => (frame.timeMs === 2500 ? 50 : 0));

  it("decodes a second pass only where the picture moved", async () => {
    const engine = reframeEngine();
    const decode = decoder([]);

    const analysis = await analyzeAutoReframe({
      ...baseDeps(decode, engine),
      measureMotion: spike,
    } as never);

    expect(calls(decode)).toHaveLength(2);
    const [first, second] = calls(decode);
    expect(first).toHaveLength(9);
    for (const time of second) {
      expect(time).toBeGreaterThan(2000);
      expect(time).toBeLessThan(2500);
    }
    expect(analysis.refinedFrames).toBe(second.length);
    expect(analysis.sampledFrames).toBe(9 + second.length);
  });

  it("stamps every crop with its own time once the grid is no longer uniform", async () => {
    const engine = reframeEngine();
    const decode = decoder([]);

    await analyzeAutoReframe({
      ...baseDeps(decode, engine),
      measureMotion: spike,
    } as never);

    const analyzeClip = engine.analyzeClip as unknown as ReturnType<typeof vi.fn>;
    const sampleTimes = analyzeClip.mock.calls[0][4] as number[];
    // Window-relative seconds, ascending, one per analyzed frame.
    expect(sampleTimes).toEqual([...sampleTimes].sort((a, b) => a - b));
    expect(sampleTimes).toHaveLength(9 + calls(decode)[1].length);
    expect(sampleTimes.slice(0, 2)).toEqual([0, 0.5]);
  });

  it("adapts on top of an explicit base grid, and inside its budget", async () => {
    // The inspector asks for a 400ms grid and a 90-frame cap. Those describe
    // the base pass and the budget; they are not a veto on refinement.
    const engine = reframeEngine();
    const decode = decoder([]);

    const analysis = await analyzeAutoReframe({
      ...baseDeps(decode, engine),
      measureMotion: () => [0, 0, 0, 8, 0, 0, 0],
      request: { mediaId: "m1", intervalMs: 400, maxFrames: 90 },
    } as never);

    expect(calls(decode)).toHaveLength(2);
    expect(analysis.refinedFrames).toBeGreaterThan(0);
    expect(analysis.sampledFrames).toBeLessThanOrEqual(90);
  });

  it("pins the even grid when adaptive is switched off", async () => {
    const engine = reframeEngine();
    const decode = decoder([]);

    const analysis = await analyzeAutoReframe({
      ...baseDeps(decode, engine),
      measureMotion: spike,
      request: { mediaId: "m1", intervalMs: 1000, adaptive: false },
    } as never);

    expect(calls(decode)).toHaveLength(1);
    expect(calls(decode)[0]).toEqual([0, 1000, 2000, 3000, 4000]);
    expect(analysis.refinedFrames).toBeUndefined();
    const analyzeClip = engine.analyzeClip as unknown as ReturnType<typeof vi.fn>;
    expect(analyzeClip.mock.calls[0][4]).toBeUndefined();
  });

  it("stays on the base grid when motion cannot be measured", async () => {
    const engine = reframeEngine();
    const decode = decoder([]);

    const analysis = await analyzeAutoReframe({
      ...baseDeps(decode, engine),
      measureMotion: () => [],
    } as never);

    expect(calls(decode)).toHaveLength(1);
    expect(analysis.sampledFrames).toBe(9);
    expect(analysis.refinedFrames).toBeUndefined();
  });
});
