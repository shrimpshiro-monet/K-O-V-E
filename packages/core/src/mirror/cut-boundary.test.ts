import { describe, expect, it } from "vitest";
import { InvalidCutDifferenceError, locateCutFrame, refineCutFrameByPeak } from "./cut-boundary";

function harness(values: number[]) {
  return {
    read: async (frame: number): Promise<number> => {
      if (!Number.isSafeInteger(frame) || frame < 0 || frame >= values.length) throw new Error(`Unexpected frame ${frame}`);
      return values[frame]!;
    },
    difference: (a: number, b: number) => Math.abs(a - b),
  };
}

describe("peak refinement on the existing inclusive-frame candidate bracket", () => {
  it("selects the unique hard cut on a half-open bracket", async () => {
    const { read, difference } = harness([0, 0.01, 0.02, 0.9, 0.91]);
    expect(await refineCutFrameByPeak({ startFrame: 0, endFrame: 5, read, difference, threshold: 0.23 }))
      .toMatchObject({ frame: 3, isHardCut: true });
  });

  it("selects the larger later crossing, not the first threshold crossing", async () => {
    const { read, difference } = harness([0, 0.02, 0.27, 0.29, 0.89]);
    expect(await locateCutFrame(0, 4, read, difference, 0.23)).toBe(2);
    const peak = await refineCutFrameByPeak({ startFrame: 0, endFrame: 5, read, difference, threshold: 0.23 });
    expect(peak.frame).toBe(4);
    expect(peak.peakDifference).toBeCloseTo(0.6, 5);
    expect(peak.isHardCut).toBe(true);
  });

  it("flags a gradual transition even when the coarse endpoints differ by more than threshold", async () => {
    const values = Array.from({ length: 21 }, (_, i) => 0.3 * i / 20);
    const { read, difference } = harness(values);
    expect(difference(values[0]!, values[20]!)).toBeGreaterThan(0.23);
    const peak = await refineCutFrameByPeak({ startFrame: 0, endFrame: 21, read, difference, threshold: 0.23 });
    expect(peak.isHardCut).toBe(false);
    expect(peak.peakDifference).toBeLessThan(0.23);
    expect(peak.frame).toBeGreaterThanOrEqual(1);
    expect(peak.frame).toBeLessThanOrEqual(20);
  });

  it("includes the last frame (old currentFrame) and chooses the earliest equal peak", async () => {
    const { read, difference } = harness([0, 0.4, 0.4, 0.8]);
    expect((await refineCutFrameByPeak({ startFrame: 0, endFrame: 4, read, difference, threshold: 0.23 })).frame).toBe(1);
    const last = harness([0, 0.1, 0.8]);
    expect((await refineCutFrameByPeak({ startFrame: 0, endFrame: 3, ...last, threshold: 0.23 })).frame).toBe(2);
  });

  it("rejects invalid brackets and numerical differences rather than manufacturing a peak", async () => {
    const { read, difference } = harness([0, 1]);
    for (const [startFrame, endFrame] of [[0, 1], [-1, 2], [0.5, 2], [0, Number.MAX_SAFE_INTEGER + 1]]) {
      await expect(refineCutFrameByPeak({ startFrame, endFrame, read, difference, threshold: 0.23 })).rejects.toThrow();
    }
    await expect(refineCutFrameByPeak({ startFrame: 0, endFrame: 2, read, difference: () => NaN, threshold: 0.23 })).rejects.toThrow(InvalidCutDifferenceError);
    await expect(refineCutFrameByPeak({ startFrame: 0, endFrame: 2, read, difference: () => -1, threshold: 0.23 })).rejects.toThrow(InvalidCutDifferenceError);
  });
});
