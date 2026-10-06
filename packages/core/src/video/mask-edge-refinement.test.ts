import { describe, expect, it } from "vitest";
import type { BezierPath, Mask, MaskKeyframe } from "./mask-engine";
import { resolveMaskEdgeAtTime } from "./mask-engine";

const square = (inset: number): BezierPath => ({
  closed: true,
  points: [
    { x: inset, y: inset },
    { x: 1 - inset, y: inset },
    { x: 1 - inset, y: 1 - inset },
    { x: inset, y: 1 - inset },
  ],
});

const keyframe = (
  id: string,
  time: number,
  overrides: Partial<MaskKeyframe> = {},
): MaskKeyframe => ({
  id,
  time,
  path: square(0.2 + time * 0.05),
  easing: "linear",
  ...overrides,
});

const mask = (keyframes: MaskKeyframe[], over: Partial<Mask> = {}): Mask => ({
  id: "mask-1",
  clipId: "clip-1",
  type: "drawn",
  path: square(0.1),
  feathering: 4,
  inverted: false,
  expansion: 0,
  opacity: 1,
  keyframes,
  ...over,
});

describe("resolveMaskEdgeAtTime", () => {
  it("returns the mask-level edge when there are no keyframes", () => {
    const resolved = resolveMaskEdgeAtTime(mask([]), 3);

    expect(resolved.feathering).toBe(4);
    expect(resolved.expansion).toBe(0);
    expect(resolved.inverted).toBe(false);
    expect(resolved.opacity).toBe(1);
    expect(resolved.path).toEqual(square(0.1));
  });

  it("leaves legacy mattes untouched: keyframes without overrides inherit the mask edge", () => {
    const subject = mask([keyframe("a", 0), keyframe("b", 2)]);
    const resolved = resolveMaskEdgeAtTime(subject, 1);

    // Path still animates... (square(0.2) -> square(0.3), sampled at t = 0.5)
    expect(resolved.path.points[0].x).toBeCloseTo(0.25, 5);
    // ...but the edge is exactly the mask's own treatment at every instant.
    expect(resolved.feathering).toBe(4);
    expect(resolved.opacity).toBe(1);
    expect(resolved.inverted).toBe(false);
  });

  it("interpolates feathering between two keyframe overrides", () => {
    const subject = mask([
      keyframe("a", 0, { feathering: 0 }),
      keyframe("b", 4, { feathering: 20 }),
    ]);

    expect(resolveMaskEdgeAtTime(subject, 0).feathering).toBe(0);
    expect(resolveMaskEdgeAtTime(subject, 1).feathering).toBeCloseTo(5, 5);
    expect(resolveMaskEdgeAtTime(subject, 2).feathering).toBeCloseTo(10, 5);
    expect(resolveMaskEdgeAtTime(subject, 4).feathering).toBe(20);
  });

  it("blends an override back to the mask default when only one side sets it", () => {
    const subject = mask([keyframe("a", 0, { feathering: 20 }), keyframe("b", 2)]);

    // b inherits the mask's 4, so halfway is (20 + 4) / 2.
    expect(resolveMaskEdgeAtTime(subject, 1).feathering).toBeCloseTo(12, 5);
  });

  it("interpolates expansion and opacity the same way", () => {
    const subject = mask([
      keyframe("a", 0, { expansion: -10, opacity: 1 }),
      keyframe("b", 2, { expansion: 10, opacity: 0.5 }),
    ]);

    const mid = resolveMaskEdgeAtTime(subject, 1);
    expect(mid.expansion).toBeCloseTo(0, 5);
    expect(mid.opacity).toBeCloseTo(0.75, 5);
  });

  it("holds a boolean invert at the preceding keyframe instead of blending it", () => {
    const subject = mask([
      keyframe("a", 0, { inverted: false }),
      keyframe("b", 2, { inverted: true }),
    ]);

    expect(resolveMaskEdgeAtTime(subject, 0).inverted).toBe(false);
    expect(resolveMaskEdgeAtTime(subject, 1).inverted).toBe(false);
    expect(resolveMaskEdgeAtTime(subject, 2).inverted).toBe(true);
    // Past the last keyframe the last one still wins.
    expect(resolveMaskEdgeAtTime(subject, 9).inverted).toBe(true);
  });

  it("honours easing on the edge values, not just the path", () => {
    const linear = mask([
      keyframe("a", 0, { feathering: 0 }),
      keyframe("b", 4, { feathering: 20 }),
    ]);
    const easedIn = mask([
      keyframe("a", 0, { feathering: 0 }),
      { ...keyframe("b", 4, { feathering: 20 }), easing: "ease-in" },
    ]);
    // ease-in is driven by the *preceding* keyframe, so bump `a`.
    const eased = mask([
      { ...keyframe("a", 0, { feathering: 0 }), easing: "ease-in" },
      keyframe("b", 4, { feathering: 20 }),
    ]);

    // t = 0.5 across a 4s span => linear 10, ease-in 5.
    expect(resolveMaskEdgeAtTime(linear, 2).feathering).toBeCloseTo(10, 5);
    expect(resolveMaskEdgeAtTime(easedIn, 2).feathering).toBeCloseTo(10, 5);
    expect(resolveMaskEdgeAtTime(eased, 2).feathering).toBeCloseTo(5, 5);
  });

  it("clamps outside the keyframe range instead of extrapolating", () => {
    const subject = mask([
      keyframe("a", 1, { feathering: 0 }),
      keyframe("b", 3, { feathering: 20 }),
    ]);

    expect(resolveMaskEdgeAtTime(subject, -5).feathering).toBe(0);
    expect(resolveMaskEdgeAtTime(subject, 99).feathering).toBe(20);
  });

  it("uses the single keyframe's values across all time", () => {
    const subject = mask([keyframe("a", 1, { feathering: 12, expansion: -3 })]);

    expect(resolveMaskEdgeAtTime(subject, 0).feathering).toBe(12);
    expect(resolveMaskEdgeAtTime(subject, 50).expansion).toBe(-3);
  });

  it("survives zero-length spans between keyframes", () => {
    const subject = mask([
      keyframe("a", 2, { feathering: 0 }),
      keyframe("b", 2, { feathering: 20 }),
    ]);

    expect(resolveMaskEdgeAtTime(subject, 2).feathering).toBe(20);
  });

  it("treats a missing keyframes array as an unanimated mask", () => {
    const subject = { ...mask([]), keyframes: undefined } as unknown as Mask;

    expect(resolveMaskEdgeAtTime(subject, 1).feathering).toBe(4);
  });
});
