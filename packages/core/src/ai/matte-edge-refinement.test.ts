import { describe, expect, it } from "vitest";
import type { RotoscopeKeyframe } from "./rotoscope";
import { matteMotionScores, planMatteEdgeRefinement } from "./matte-edge-refinement";

const frame = (
  timeMs: number,
  centroid: { x: number; y: number },
  coverage: number,
): RotoscopeKeyframe => ({
  timeMs,
  path: { closed: true, points: [{ x: centroid.x, y: centroid.y }] },
  coverage,
  centroid,
  pointCount: 4,
});

const still = [frame(0, { x: 0.5, y: 0.5 }, 0.3), frame(500, { x: 0.5, y: 0.5 }, 0.3)];

const moving = [
  frame(0, { x: 0.2, y: 0.5 }, 0.20),
  frame(500, { x: 0.5, y: 0.5 }, 0.30),
  frame(1000, { x: 0.8, y: 0.5 }, 0.45),
];

describe("matteMotionScores", () => {
  it("reports zero motion for a still subject", () => {
    expect(matteMotionScores(still)).toEqual([0, 0]);
  });

  it("normalizes the busiest keyframe to 1", () => {
    const scores = matteMotionScores(moving);

    expect(scores).toHaveLength(3);
    expect(Math.max(...scores)).toBeCloseTo(1, 5);
    // A keyframe that keeps moving throughout never scores 0 — only a settled
    // one does (see the next test). Raw 0.31 / 0.67 / 0.36.
    expect(scores[0]).toBeCloseTo(0.31 / 0.67, 4);
    expect(scores[1]).toBeCloseTo(1, 5);
    expect(scores[2]).toBeCloseTo(0.36 / 0.67, 4);
  });

  it("scores 0 only where the subject has settled", () => {
    const settlesThenStops = [
      frame(0, { x: 0.2, y: 0.5 }, 0.2),
      frame(500, { x: 0.5, y: 0.5 }, 0.3),
      frame(1000, { x: 0.5, y: 0.5 }, 0.3),
    ];

    const scores = matteMotionScores(settlesThenStops);

    expect(scores[2]).toBeCloseTo(0, 5);
    expect(scores[0]).toBeCloseTo(1, 5);
  });

  it("is scale-free: a small subject moving a little scores like a big one moving a lot", () => {
    const small = [frame(0, { x: 0.5, y: 0.5 }, 0.1), frame(500, { x: 0.6, y: 0.5 }, 0.1)];
    const large = [frame(0, { x: 0.5, y: 0.5 }, 0.4), frame(500, { x: 0.9, y: 0.5 }, 0.4)];

    // Both are pure translation with no competitor, so both peak at 1.
    expect(Math.max(...matteMotionScores(small))).toBeCloseTo(1, 5);
    expect(Math.max(...matteMotionScores(large))).toBeCloseTo(1, 5);
  });

  it("handles empty and single-keyframe plans", () => {
    expect(matteMotionScores([])).toEqual([]);
    expect(matteMotionScores([frame(0, { x: 0.5, y: 0.5 }, 0.2)])).toEqual([0]);
  });

  it("counts area change alone as motion", () => {
    const scores = matteMotionScores([
      frame(0, { x: 0.5, y: 0.5 }, 0.2),
      frame(500, { x: 0.5, y: 0.5 }, 0.6),
    ]);

    expect(Math.max(...scores)).toBeCloseTo(1, 5);
  });
});

describe("planMatteEdgeRefinement", () => {
  it("keeps a still subject on the base feather", () => {
    const plan = planMatteEdgeRefinement(still, { featherPx: 6, expansionPx: 0 });

    expect(plan.keyframes.map((k) => k.featherPx)).toEqual([6, 6]);
    expect(plan.motion).toEqual([0, 0]);
  });

  it("widens the feather where the subject moves", () => {
    const plan = planMatteEdgeRefinement(moving, {
      featherPx: 6,
      expansionPx: 0,
      motionSensitivity: 1,
      maxFeatherPx: 18,
    });

    const feathers = plan.keyframes.map((k) => k.featherPx);
    // The busiest keyframe reaches the cap; every feather sits between base
    // and cap, and tracks the motion ordering (0.46 / 1.00 / 0.54).
    expect(Math.max(...feathers)).toBeCloseTo(18, 5);
    // (Values are rounded to 2dp on the way out — see the rounding test.)
    expect(Math.min(...feathers)).toBeCloseTo(Math.round((6 + 12 * (0.31 / 0.67)) * 100) / 100, 4);
    expect(feathers[1]).toBeGreaterThan(feathers[0]);
    expect(feathers[1]).toBeGreaterThan(feathers[2]);
  });

  it("returns to the base feather once the subject settles", () => {
    const settlesThenStops = [
      frame(0, { x: 0.2, y: 0.5 }, 0.2),
      frame(500, { x: 0.5, y: 0.5 }, 0.3),
      frame(1000, { x: 0.5, y: 0.5 }, 0.3),
    ];
    const plan = planMatteEdgeRefinement(settlesThenStops, {
      featherPx: 6,
      expansionPx: 0,
      motionSensitivity: 1,
      maxFeatherPx: 18,
    });

    const feathers = plan.keyframes.map((k) => k.featherPx);
    expect(feathers[0]).toBeCloseTo(18, 5);
    expect(feathers[1]).toBeCloseTo(18, 5);
    // Settled: back to a crisp edge.
    expect(feathers[2]).toBeCloseTo(6, 5);
  });

  it("honours motionSensitivity 0 as a uniform feather", () => {
    const plan = planMatteEdgeRefinement(moving, {
      featherPx: 6,
      expansionPx: 0,
      motionSensitivity: 0,
      maxFeatherPx: 18,
    });

    expect(plan.keyframes.every((k) => k.featherPx === 6)).toBe(true);
  });

  it("never exceeds the cap, even at full sensitivity", () => {
    const plan = planMatteEdgeRefinement(moving, {
      featherPx: 4,
      expansionPx: 0,
      motionSensitivity: 1,
      maxFeatherPx: 10,
    });

    for (const keyframe of plan.keyframes) {
      expect(keyframe.featherPx).toBeLessThanOrEqual(10);
      expect(keyframe.featherPx).toBeGreaterThanOrEqual(4);
    }
  });

  it("defaults the cap to three times the base feather", () => {
    const plan = planMatteEdgeRefinement(moving, {
      featherPx: 5,
      expansionPx: 0,
      motionSensitivity: 1,
    });

    // No cap given: base 5 -> ceiling 15, reached by the busiest keyframe.
    expect(Math.max(...plan.keyframes.map((k) => k.featherPx))).toBeCloseTo(15, 5);
  });

  it("applies the default sensitivity so full motion does not hit the cap", () => {
    const plan = planMatteEdgeRefinement(moving, { featherPx: 5, expansionPx: 0 });

    // Default sensitivity 0.6: 5 + (15 - 5) * 0.6.
    expect(Math.max(...plan.keyframes.map((k) => k.featherPx))).toBeCloseTo(11, 5);
  });

  it("clamps expansion to the renderer's range", () => {
    const plan = planMatteEdgeRefinement(still, { featherPx: 4, expansionPx: 999 });

    expect(plan.keyframes[0].expansionPx).toBe(100);
  });

  it("carries the source time so callers can line up with the matte keyframes", () => {
    const plan = planMatteEdgeRefinement(moving, { featherPx: 4, expansionPx: 2 });

    expect(plan.keyframes.map((k) => k.timeMs)).toEqual([0, 500, 1000]);
  });

  it("warns when there is nothing to refine", () => {
    const plan = planMatteEdgeRefinement([], { featherPx: 4, expansionPx: 0 });

    expect(plan.keyframes).toEqual([]);
    expect(plan.warnings.join(" ")).toMatch(/no keyframes/i);
  });

  it("warns when an inverted matte is feathered wide", () => {
    const plan = planMatteEdgeRefinement(still, {
      featherPx: 20,
      expansionPx: 0,
      invert: true,
    });

    expect(plan.warnings.join(" ")).toMatch(/inverted/i);
  });

  it("warns when a partially transparent matte has a hard edge", () => {
    const plan = planMatteEdgeRefinement(still, {
      featherPx: 0,
      expansionPx: 0,
      opacity: 0.5,
    });

    expect(plan.warnings.join(" ")).toMatch(/hard edge/i);
  });

  it("rounds feather values so written keyframes stay readable", () => {
    const plan = planMatteEdgeRefinement(moving, { featherPx: 1, expansionPx: 0 });

    for (const keyframe of plan.keyframes) {
      expect(keyframe.featherPx * 100).toBeCloseTo(Math.round(keyframe.featherPx * 100), 6);
    }
  });
});
