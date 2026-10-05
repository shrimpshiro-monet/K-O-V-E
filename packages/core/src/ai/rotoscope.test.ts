import { describe, expect, it } from "vitest";
import {
  alphaFromRgba,
  alphaToContours,
  applyRotoscopePlan,
  contourToBezierPath,
  maskStats,
  planRotoscope,
  simplifyContour,
  sourceTimeToTimelineSeconds,
  type AlphaMask,
  type RotoscopeKeyframeSink,
  type RotoscopeSample,
} from "./rotoscope";

/** Solid axis-aligned rectangle. */
function rectangleMask(
  width: number,
  height: number,
  rect: { x: number; y: number; width: number; height: number },
  coverage = 255,
): AlphaMask {
  const data = new Uint8ClampedArray(width * height);
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      data[y * width + x] = coverage;
    }
  }
  return { data, width, height };
}

/** Solid disc — a stand-in for a segmented person's silhouette. */
function discMask(
  width: number,
  height: number,
  center: { x: number; y: number },
  radius: number,
): AlphaMask {
  const data = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const distance = Math.hypot(x - center.x, y - center.y);
      if (distance <= radius) data[y * width + x] = 255;
    }
  }
  return { data, width, height };
}

/** Disc with a concentric hole (a hand-on-hip style silhouette). */
function ringMask(
  width: number,
  height: number,
  center: { x: number; y: number },
  outerRadius: number,
  innerRadius: number,
): AlphaMask {
  const data = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const distance = Math.hypot(x - center.x, y - center.y);
      if (distance <= outerRadius && distance > innerRadius) data[y * width + x] = 255;
    }
  }
  return { data, width, height };
}

function emptyMask(width: number, height: number): AlphaMask {
  return { data: new Uint8ClampedArray(width * height), width, height };
}

describe("alphaFromRgba", () => {
  it("extracts the alpha channel used by segmentation engines", () => {
    const rgba = new Uint8ClampedArray([10, 20, 30, 0, 40, 50, 60, 128, 70, 80, 90, 255]);
    const mask = alphaFromRgba({ data: rgba, width: 3, height: 1 });
    expect(Array.from(mask.data)).toEqual([0, 128, 255]);
    expect(mask.width).toBe(3);
    expect(mask.height).toBe(1);
  });
});

describe("maskStats", () => {
  it("reports coverage, centroid and bounding box for a rectangle", () => {
    const mask = rectangleMask(100, 100, { x: 20, y: 30, width: 40, height: 20 });
    const stats = maskStats(mask);
    expect(stats.coverage).toBeCloseTo((40 * 20) / 10_000, 5);
    // Pixel indices 20..59 average to 39.5, so the centroid is 0.395.
    expect(stats.centroid.x).toBeCloseTo(0.395, 3);
    expect(stats.centroid.y).toBeCloseTo(0.395, 3);
    expect(stats.boundingBox).toEqual({ x: 0.2, y: 0.3, width: 0.4, height: 0.2 });
  });

  it("returns an empty report for a blank matte", () => {
    const stats = maskStats(emptyMask(32, 32));
    expect(stats.coverage).toBe(0);
    expect(stats.boundingBox.width).toBe(0);
  });

  it("respects the threshold", () => {
    const mask = rectangleMask(10, 10, { x: 0, y: 0, width: 10, height: 10 }, 100);
    expect(maskStats(mask, 128).coverage).toBe(0);
    expect(maskStats(mask, 50).coverage).toBe(1);
  });
});

describe("alphaToContours", () => {
  it("returns one outer contour whose area matches the shape", () => {
    const mask = rectangleMask(100, 100, { x: 10, y: 10, width: 40, height: 30 });
    const contours = alphaToContours(mask);
    expect(contours).toHaveLength(1);
    expect(contours[0].isHole).toBe(false);
    // Boundary tracing walks the pixel centers, so area is close, not exact.
    expect(contours[0].area).toBeGreaterThan(0.8 * 40 * 30);
    expect(contours[0].area).toBeLessThan(1.3 * 40 * 30);
  });

  it("marks a hole as a separate, negative-area contour", () => {
    const mask = ringMask(120, 120, { x: 60, y: 60 }, 40, 20);
    const contours = alphaToContours(mask, { maxContours: 4 });
    expect(contours.length).toBeGreaterThanOrEqual(2);
    const outer = contours.find((contour) => !contour.isHole);
    const hole = contours.find((contour) => contour.isHole);
    expect(outer).toBeDefined();
    expect(hole).toBeDefined();
    expect(outer!.area).toBeGreaterThan(hole!.area);
    expect(hole!.signedArea).toBeLessThan(0);
  });

  it("drops regions below minAreaRatio and orders by size", () => {
    const data = new Uint8ClampedArray(200 * 200);
    const paint = (x: number, y: number, size: number) => {
      for (let dy = 0; dy < size; dy += 1) {
        for (let dx = 0; dx < size; dx += 1) {
          data[(y + dy) * 200 + x + dx] = 255;
        }
      }
    };
    paint(10, 10, 60);
    paint(100, 100, 20);
    paint(150, 20, 2);
    const contours = alphaToContours({ data, width: 200, height: 200 }, { minAreaRatio: 0.002 });
    expect(contours.length).toBe(2);
    expect(contours[0].area).toBeGreaterThan(contours[1].area);
  });

  it("returns nothing for an empty or undersized mask", () => {
    expect(alphaToContours(emptyMask(50, 50))).toEqual([]);
    expect(alphaToContours({ data: new Uint8ClampedArray(0), width: 0, height: 0 })).toEqual([]);
  });

  it("traces a disc with a plausible circumference", () => {
    const mask = discMask(200, 200, { x: 100, y: 100 }, 50);
    const [contour] = alphaToContours(mask);
    expect(contour.points.length).toBeGreaterThan(100);
    const expectedArea = Math.PI * 50 * 50;
    expect(contour.area).toBeGreaterThan(expectedArea * 0.85);
    expect(contour.area).toBeLessThan(expectedArea * 1.15);
  });
});

describe("simplifyContour", () => {
  it("removes collinear points but keeps corners", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 0, y: 20 },
    ];
    const simplified = simplifyContour(points, 0.5);
    expect(simplified).toHaveLength(4);
    expect(simplified).toContainEqual({ x: 20, y: 0 });
    expect(simplified).toContainEqual({ x: 20, y: 20 });
  });

  it("keeps detail that exceeds the tolerance", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 8 },
      { x: 20, y: 8 },
      { x: 30, y: 0 },
    ];
    expect(simplifyContour(points, 1)).toHaveLength(4);
    // Both interior points sit 8px off the chord, inside a 20px tolerance.
    expect(simplifyContour(points, 20)).toHaveLength(2);
  });

  it("passes tiny rings through untouched", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ];
    expect(simplifyContour(points, 5)).toHaveLength(3);
  });
});

describe("contourToBezierPath", () => {
  it("normalizes points into 0..1 closed paths with smooth handles", () => {
    const path = contourToBezierPath(
      [
        { x: 50, y: 100 },
        { x: 150, y: 100 },
        { x: 150, y: 200 },
      ],
      { width: 200, height: 200 },
    );
    expect(path.closed).toBe(true);
    expect(path.points).toHaveLength(3);
    for (const point of path.points) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(1);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(1);
      expect(point.handleIn).toBeDefined();
      expect(point.handleOut).toBeDefined();
    }
  });

  it("omits handles when smoothing is disabled", () => {
    const path = contourToBezierPath(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      { width: 10, height: 10, smooth: false },
    );
    expect(path.points[0].handleIn).toBeUndefined();
  });

  it("clamps out-of-frame points instead of emitting invalid paths", () => {
    const path = contourToBezierPath(
      [
        { x: -5, y: -5 },
        { x: 40, y: 0 },
        { x: 0, y: 40 },
      ],
      { width: 20, height: 20, smooth: false },
    );
    expect(path.points[0]).toEqual({ x: 0, y: 0 });
    expect(path.points[1].x).toBe(1);
  });
});

describe("planRotoscope", () => {
  const staticSamples = (count: number): RotoscopeSample[] =>
    Array.from({ length: count }, (_, index) => ({
      timeMs: index * 100,
      mask: discMask(160, 160, { x: 80, y: 80 }, 40),
    }));

  it("emits a single keyframe for a static subject", () => {
    const plan = planRotoscope(staticSamples(10));
    expect(plan.keyframes).toHaveLength(1);
    expect(plan.sampledFrames).toBe(10);
    expect(plan.missedFrames).toBe(0);
    expect(plan.keyframes[0].timeMs).toBe(0);
    expect(plan.keyframes[0].coverage).toBeGreaterThan(0.15);
    expect(plan.averageCoverage).toBeGreaterThan(0.15);
  });

  it("adds keyframes as the subject moves, in ascending time", () => {
    const samples: RotoscopeSample[] = Array.from({ length: 6 }, (_, index) => ({
      timeMs: index * 100,
      mask: discMask(200, 100, { x: 30 + index * 25, y: 50 }, 20),
    }));
    const plan = planRotoscope(samples);
    expect(plan.keyframes.length).toBeGreaterThan(1);
    const times = plan.keyframes.map((keyframe) => keyframe.timeMs);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    const centers = plan.keyframes.map((keyframe) => keyframe.centroid.x);
    expect(centers.at(-1)!).toBeGreaterThan(centers[0]);
    expect(plan.boundingBox.width).toBeGreaterThan(0.3);
  });

  it("skips frames with no subject and warns once", () => {
    const samples: RotoscopeSample[] = [
      { timeMs: 0, mask: discMask(100, 100, { x: 50, y: 50 }, 30) },
      { timeMs: 100, mask: emptyMask(100, 100) },
      { timeMs: 200, mask: discMask(100, 100, { x: 50, y: 50 }, 30) },
    ];
    const plan = planRotoscope(samples);
    expect(plan.missedFrames).toBe(1);
    expect(plan.warnings.some((warning) => warning.includes("no subject"))).toBe(true);
  });

  it("reports a fully empty analysis without throwing", () => {
    const plan = planRotoscope([
      { timeMs: 0, mask: emptyMask(50, 50) },
      { timeMs: 100, mask: emptyMask(50, 50) },
    ]);
    expect(plan.keyframes).toEqual([]);
    expect(plan.averageCoverage).toBe(0);
    expect(plan.warnings[0]).toContain("No usable subject");
  });

  it("handles an empty sample list", () => {
    const plan = planRotoscope([]);
    expect(plan.keyframes).toEqual([]);
    expect(plan.warnings[0]).toContain("No frames were sampled");
  });

  it("decimates to maxKeyframes with a warning", () => {
    const samples: RotoscopeSample[] = Array.from({ length: 60 }, (_, index) => ({
      timeMs: index * 50,
      mask: discMask(400, 200, { x: 30 + index * 5, y: 100 + (index % 7) * 4 }, 25),
    }));
    const plan = planRotoscope(samples, { maxKeyframes: 5, centroidDeltaThreshold: 0.0001 });
    expect(plan.keyframes.length).toBeLessThanOrEqual(5);
    expect(plan.warnings.some((warning) => warning.includes("decimated"))).toBe(true);
    expect(plan.keyframes[0].timeMs).toBe(0);
  });

  it("respects maxPointsPerPath", () => {
    const plan = planRotoscope([{ timeMs: 0, mask: discMask(400, 400, { x: 200, y: 200 }, 180) }], {
      maxPointsPerPath: 8,
      simplifyTolerance: 0,
    });
    expect(plan.keyframes[0].pointCount).toBeLessThanOrEqual(8);
  });

  it("warns about interior holes in the matte", () => {
    const plan = planRotoscope([
      { timeMs: 0, mask: ringMask(120, 120, { x: 60, y: 60 }, 45, 20) },
    ]);
    expect(plan.keyframes).toHaveLength(1);
    expect(plan.warnings.some((warning) => warning.includes("hole"))).toBe(true);
  });
});

describe("sourceTimeToTimelineSeconds", () => {
  it("maps a source time inside a clip at 1x", () => {
    expect(
      sourceTimeToTimelineSeconds(12, { startTime: 5, inPoint: 2, speed: 1 }),
    ).toBeCloseTo(15);
  });

  it("accounts for speed", () => {
    expect(sourceTimeToTimelineSeconds(12, { startTime: 5, inPoint: 2, speed: 2 })).toBeCloseTo(10);
  });

  it("accounts for reversed clips", () => {
    expect(
      sourceTimeToTimelineSeconds(12, {
        startTime: 5,
        inPoint: 2,
        outPoint: 22,
        speed: 1,
        reversed: true,
      }),
    ).toBeCloseTo(15);
  });

  it("clamps times before the in-point to the clip start", () => {
    expect(sourceTimeToTimelineSeconds(0, { startTime: 5, inPoint: 2, speed: 1 })).toBe(5);
  });
});

describe("applyRotoscopePlan", () => {
  const sink = (): RotoscopeKeyframeSink & { calls: Array<[string, number, number]> } => {
    const calls: Array<[string, number, number]> = [];
    return {
      calls,
      addMaskKeyframe(maskId: string, timeSeconds: number, path) {
        calls.push([maskId, timeSeconds, path.points.length]);
        return { id: `kf-${calls.length}` };
      },
    };
  };

  it("writes one keyframe per plan keyframe and reports the range", () => {
    const target = sink();
    const plan = planRotoscope([
      { timeMs: 0, mask: discMask(100, 100, { x: 30, y: 50 }, 20) },
      { timeMs: 500, mask: discMask(100, 100, { x: 70, y: 50 }, 20) },
    ]);
    const result = applyRotoscopePlan(plan, target, { maskId: "mask-1" });
    expect(result.written).toBe(plan.keyframes.length);
    expect(result.firstTimeSeconds).toBe(0);
    expect(result.lastTimeSeconds).toBeCloseTo(0.5);
    expect(target.calls.every(([maskId]) => maskId === "mask-1")).toBe(true);
    expect(target.calls.every(([, , points]) => points >= 3)).toBe(true);
  });

  it("maps sample times onto the timeline clock", () => {
    const target = sink();
    const plan = planRotoscope([
      { timeMs: 0, mask: discMask(100, 100, { x: 30, y: 50 }, 20) },
      { timeMs: 1000, mask: discMask(100, 100, { x: 40, y: 50 }, 20) },
    ], { centroidDeltaThreshold: 0.001 });
    applyRotoscopePlan(plan, target, {
      maskId: "mask-1",
      timeMapping: { startTime: 10, inPoint: 0, speed: 1 },
      sampleOriginMs: 0,
    });
    expect(target.calls[0][1]).toBeCloseTo(10);
    expect(target.calls.at(-1)![1]).toBeCloseTo(11);
  });

  it("surfaces a sink that refuses keyframes", () => {
    const plan = planRotoscope([{ timeMs: 0, mask: discMask(60, 60, { x: 30, y: 30 }, 15) }]);
    const result = applyRotoscopePlan(
      plan,
      { addMaskKeyframe: () => null },
      { maskId: "missing-mask" },
    );
    expect(result).toEqual({ written: 0, firstTimeSeconds: null, lastTimeSeconds: null });
  });
});
