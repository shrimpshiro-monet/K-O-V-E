import { describe, expect, it, vi } from "vitest";
import { drawMatteEdgePreview, previewFeatherAt } from "./matte-edge-preview";

const square = {
  closed: true,
  points: [
    { x: 0.25, y: 0.25 },
    { x: 0.75, y: 0.25 },
    { x: 0.75, y: 0.75 },
    { x: 0.25, y: 0.75 },
  ],
};

/** Minimal recording stand-in for a 2D context. */
const recorder = () => {
  const calls = {
    clearRect: 0,
    fill: 0,
    stroke: 0,
    fillRect: 0,
    moveTo: [] as Array<[number, number]>,
    lineTo: [] as Array<[number, number]>,
    closePath: 0,
    filters: [] as string[],
    composite: [] as string[],
    alphas: [] as number[],
    lineWidths: [] as number[],
  };
  const ctx = {
    filter: "none",
    lineWidth: 0,
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    fillStyle: "",
    strokeStyle: "",
    clearRect: () => {
      calls.clearRect += 1;
    },
    fillRect: () => {
      calls.fillRect += 1;
    },
    beginPath: () => {},
    moveTo: (x: number, y: number) => calls.moveTo.push([x, y]),
    lineTo: (x: number, y: number) => calls.lineTo.push([x, y]),
    closePath: () => {
      calls.closePath += 1;
    },
    fill: () => {
      calls.fill += 1;
      calls.filters.push(ctx.filter);
      calls.alphas.push(ctx.globalAlpha);
      calls.composite.push(ctx.globalCompositeOperation);
    },
    stroke: () => {
      calls.stroke += 1;
      calls.lineWidths.push(ctx.lineWidth);
      calls.composite.push(ctx.globalCompositeOperation);
    },
  };
  return { ctx, calls };
};

describe("drawMatteEdgePreview", () => {
  it("scales the normalized path into the canvas", () => {
    const { ctx, calls } = recorder();
    drawMatteEdgePreview(ctx, {
      path: square,
      featherPx: 0,
      expansionPx: 0,
      width: 200,
      height: 100,
    });

    expect(calls.moveTo).toEqual([[50, 25]]);
    expect(calls.lineTo).toEqual([
      [150, 25],
      [150, 75],
      [50, 75],
    ]);
    expect(calls.closePath).toBeGreaterThanOrEqual(1);
  });

  it("applies the feather as a blur filter, and nothing when it is zero", () => {
    const blurred = recorder();
    const result = drawMatteEdgePreview(blurred.ctx, {
      path: square,
      featherPx: 6,
      expansionPx: 0,
      width: 100,
      height: 100,
    });
    expect(result.filter).toBe("blur(6px)");
    expect(blurred.calls.filters).toContain("blur(6px)");

    const sharp = recorder();
    const sharpResult = drawMatteEdgePreview(sharp.ctx, {
      path: square,
      featherPx: 0,
      expansionPx: 0,
      width: 100,
      height: 100,
    });
    expect(sharpResult.filter).toBe("none");
    expect(sharp.calls.filters).not.toContain("blur(0px)");
  });

  it("grows the silhouette by stroking outward", () => {
    const { ctx, calls } = recorder();
    const result = drawMatteEdgePreview(ctx, {
      path: square,
      featherPx: 0,
      expansionPx: 5,
      width: 100,
      height: 100,
    });

    expect(calls.stroke).toBe(1);
    // The stroke straddles the outline, so twice the radius covers it.
    expect(calls.lineWidths[0]).toBe(10);
    expect(result.compositeOperation).toBe("source-over");
  });

  it("shrinks the silhouette by erasing inward", () => {
    const { ctx } = recorder();
    const result = drawMatteEdgePreview(ctx, {
      path: square,
      featherPx: 0,
      expansionPx: -4,
      width: 100,
      height: 100,
    });

    expect(result.strokeWidth).toBe(8);
    expect(result.compositeOperation).toBe("destination-out");
  });

  it("punches the subject out of a filled frame when inverted", () => {
    const { ctx, calls } = recorder();
    const result = drawMatteEdgePreview(ctx, {
      path: square,
      featherPx: 3,
      expansionPx: 0,
      inverted: true,
      opacity: 0.5,
      width: 100,
      height: 100,
    });

    expect(calls.fillRect).toBe(1);
    expect(result.compositeOperation).toBe("destination-out");
    expect(result.fillAlpha).toBe(0.5);
    expect(result.filter).toBe("blur(3px)");
  });

  it("carries opacity into the fill alpha", () => {
    const { ctx } = recorder();
    const result = drawMatteEdgePreview(ctx, {
      path: square,
      featherPx: 0,
      expansionPx: 0,
      opacity: 0.25,
      width: 100,
      height: 100,
    });

    expect(result.fillAlpha).toBe(0.25);
  });

  it("clamps opacity into 0..1", () => {
    const { ctx } = recorder();
    const result = drawMatteEdgePreview(ctx, {
      path: square,
      featherPx: 0,
      expansionPx: 0,
      opacity: 5,
      width: 100,
      height: 100,
    });

    expect(result.fillAlpha).toBe(1);
  });

  it("resets the context so back-to-back draws do not leak state", () => {
    const { ctx } = recorder();
    drawMatteEdgePreview(ctx, {
      path: square,
      featherPx: 8,
      expansionPx: -3,
      width: 100,
      height: 100,
    });

    expect(ctx.filter).toBe("none");
    expect(ctx.globalAlpha).toBe(1);
    expect(ctx.globalCompositeOperation).toBe("source-over");
  });

  it("leaves an open path open", () => {
    const { ctx, calls } = recorder();
    drawMatteEdgePreview(ctx, {
      path: { closed: false, points: square.points },
      featherPx: 0,
      expansionPx: 0,
      width: 100,
      height: 100,
    });

    expect(calls.closePath).toBe(0);
  });
});

describe("previewFeatherAt", () => {
  it("returns the base feather when there is no motion", () => {
    expect(previewFeatherAt(4, 12, 0, 1)).toBe(4);
  });

  it("reaches the cap at full motion and full sensitivity", () => {
    expect(previewFeatherAt(4, 12, 1, 1)).toBe(12);
  });

  it("scales with sensitivity", () => {
    expect(previewFeatherAt(4, 12, 1, 0.5)).toBeCloseTo(8, 5);
  });

  it("never goes below the base even if the cap is smaller", () => {
    expect(previewFeatherAt(10, 4, 1, 1)).toBe(10);
  });

  it("tracks the planner's own arithmetic", () => {
    // Same formula as core's planMatteEdgeRefinement, so preview and write agree.
    const planner = vi.fn(() => 4 + (12 - 4) * Math.min(1, Math.max(0, 0.75 * 0.6)));
    expect(previewFeatherAt(4, 12, 0.75, 0.6)).toBeCloseTo(planner(), 6);
  });
});
