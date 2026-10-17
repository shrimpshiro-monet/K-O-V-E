import { describe, expect, it, vi } from "vitest";
import { extractFrameMotion, fitTrackedPointSimilarity, hasNativeAffineEstimator, type PointPair } from "./opencv-camera-motion";

function syntheticGrid(n = 40): Array<[number, number]> {
  return Array.from({ length: n }, (_, i) => [(i % 8) * 20 - 80, Math.floor(i / 8) * 20 - 40]);
}

function transformed(tx: number, ty: number, scale: number, theta: number): PointPair[] {
  const a = scale * Math.cos(theta), b = scale * Math.sin(theta);
  return syntheticGrid().map(([x, y]) => [x, y, a*x - b*y + tx, b*x + a*y + ty]);
}

function expectFit(pairs: PointPair[], tx: number, ty: number, scale: number, theta: number) {
  const fit = fitTrackedPointSimilarity(pairs);
  expect(fit).not.toBeNull();
  expect(fit!.tx).toBeCloseTo(tx, 1);
  expect(fit!.ty).toBeCloseTo(ty, 1);
  expect(Math.hypot(fit!.a, fit!.b)).toBeCloseTo(scale, 2);
  expect(Math.atan2(fit!.b, fit!.a)).toBeCloseTo(theta, 2);
}

describe("the actual JS fallback's synthetic transform ground truth", () => {
  it("recovers a pure translation", () => expectFit(transformed(12, -5, 1, 0), 12, -5, 1, 0));
  it("recovers a uniform zoom", () => expectFit(transformed(0, 0, 1.08, 0), 0, 0, 1.08, 0));
  it("recovers rotation", () => expectFit(transformed(0, 0, 1, 0.05), 0, 0, 1, 0.05));
  it("recovers combined pan, zoom and rotation", () => expectFit(transformed(8, 2, 1.03, -0.04), 8, 2, 1.03, -0.04));
  it("rejects degenerate or non-finite correspondences", () => {
    expect(fitTrackedPointSimilarity([])).toBeNull();
    expect(fitTrackedPointSimilarity([[0, 0, 1, 1], [0, 0, 2, 2]])).toBeNull();
    expect(fitTrackedPointSimilarity([[0, 0, 1, 1], [10, 0, NaN, 2]])).toBeNull();
  });

  it("checks the runtime capability, then uses the JS RANSAC/refit path despite outliers", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(hasNativeAffineEstimator({ estimateAffinePartial2D: () => null })).toBe(true);
      expect(hasNativeAffineEstimator({})).toBe(false);
      expect(hasNativeAffineEstimator({})).toBe(false);
      expect(warning).toHaveBeenCalledTimes(1);
      const pairs = transformed(12, -5, 1.04, 0.02);
      pairs[0] = [pairs[0]![0], pairs[0]![1], 900, -900];
      class Mat {
        rows = 0;
        cols = 0;
        data = new Uint8Array();
        data32F = new Float32Array();
        delete() {}
      }
      const cv = {
        Mat,
        goodFeaturesToTrack: (_previous: unknown, points: Mat) => {
          points.rows = pairs.length;
          points.cols = 1;
          points.data32F = Float32Array.from(pairs.flatMap((p) => [p[0], p[1]]));
        },
        calcOpticalFlowPyrLK: (_previous: unknown, _current: unknown, _before: Mat, after: Mat, status: Mat, errors: Mat) => {
          after.data32F = Float32Array.from(pairs.flatMap((p) => [p[2], p[3]]));
          status.rows = pairs.length;
          status.cols = 1;
          status.data = new Uint8Array(pairs.length).fill(1);
          errors.data32F = new Float32Array(pairs.length);
        },
      } as unknown as Parameters<typeof extractFrameMotion>[0];
      const frame = extractFrameMotion(cv, new Mat() as never, new Mat() as never, 14);
      expect(frame?.frame).toBe(14);
      expect(frame?.translateX).toBeCloseTo(12, 0);
      expect(frame?.translateY).toBeCloseTo(-5, 0);
      expect(frame?.scale).toBeCloseTo(1.04, 2);
      expect(frame?.rotationRad).toBeCloseTo(0.02, 2);
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });
});
