import { describe, expect, it } from "vitest";
import { searchBestPlan } from "./plan-optimizer";
import { scorePlan } from "./edit-quality-score";
const axes = (v: number) => ({ rhythm: v, colorMatch: v, motionFidelity: v, continuity: v });
describe("adaptive numeric search", () => {
  it("improves a measurable objective and replays with the same seed", () => {
    const params = [{ path: "intensity", min: 0, max: 2, current: 0 }];
    const evaluate = (p: Record<string, number>) => axes(1 - Math.abs(p.intensity - 1.3) / 2);
    const options = { seed: 42, trials: 100, stepDecay: 0.97 };
    const result = searchBestPlan(params, evaluate, options);
    expect(result.bestScore).toBeGreaterThan(scorePlan(evaluate({ intensity: 0 })));
    expect(result.bestValues.intensity).toBeGreaterThan(0.4);
    expect(searchBestPlan(params, evaluate, options)).toEqual(result);
    expect(result.history.every((s, i) => !i || s >= result.history[i-1])).toBe(true);
  });
  it("does not hallucinate gains when the evaluator does not change", () => {
    expect(searchBestPlan([{ path: "x", min: 0, max: 1, current: 0.5 }], () => axes(0.5), { trials: 5, stepDecay: 0.9 }).bestScore).toBe(0.5);
  });
});
