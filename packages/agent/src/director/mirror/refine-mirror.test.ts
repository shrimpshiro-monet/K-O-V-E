import { describe, expect, it } from "vitest";
import { refineMirror } from "./refine-mirror";
const frame = (n: number) => ({ width: 2, height: 2, data: new Uint8Array([0, 30, 100, n]) });
describe("render-backed critic", () => {
  it("samples real images, keeps a nondecreasing best score and restores the winning knobs", async () => {
    let applied = { motionScale: 1, gradeStrength: 1 };
    let calls = 0;
    const result = await refineMirror({ samples: [{ timeSeconds: 0.5, reference: frame(180) }], referenceDurations: [1, 2], candidateDurations: [1, 2], iterations: 5,
      apply: async (knobs) => { applied = knobs; }, render: async () => { calls++; return frame(Math.round(180 * applied.gradeStrength)); }, targetScore: 1.01 });
    expect(result.history.every((x, i) => !i || x >= result.history[i-1])).toBe(true);
    expect(applied).toEqual(result.bestKnobs);
    expect(calls).toBe(result.trials);
  });
  it("keeps exact Mirror refinement sensitive to a uniform 2x timing error", async () => {
    const result = await refineMirror({ samples: [{ timeSeconds: 0, reference: frame(180) }],
      referenceDurations: [4, 4, 1, 1], candidateDurations: [8, 8, 2, 2], iterations: 0,
      apply: async () => {}, render: async () => frame(180) });
    expect(result.rhythmScore).toBeLessThan(0.8);
  });
  it("reports LPIPS only when a real model callback is configured", async () => {
    let calls = 0;
    const result = await refineMirror({ samples: [{ timeSeconds: 0, reference: frame(180) }], referenceDurations: [30], candidateDurations: [30], iterations: 0,
      apply: async () => {}, render: async () => frame(175), lpips: async () => { calls++; return 0.2; } });
    expect(calls).toBe(1);
    expect(result.lpipsDistance).toBe(0.2);
    expect(result.bestSsim).toBeGreaterThan(0.9);
  });
  it("does not manufacture a score when rendering fails", async () => {
    await expect(refineMirror({ samples: [{ timeSeconds: 0, reference: frame(30) }], referenceDurations: [1], candidateDurations: [1], apply: async () => {}, render: async () => { throw new Error("renderer unavailable"); } })).rejects.toThrow("renderer unavailable");
  });
});
