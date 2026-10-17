import { describe, expect, it } from "vitest";
import { computeLabStats, applyReinhardTransfer, createReinhardLut } from "../color/reinhard-transfer";
import { compilePresetToGraph, evaluateCraftGraph, toGraph } from "../motion/craft-graph";
import { classifyDominantMove } from "../vision/camera-motion-extractor";
describe("measured mirror primitives", () => {
  it("transfers a solid color to the reference and preserves alpha", () => {
    const ref = computeLabStats(new Uint8ClampedArray([210, 100, 40, 255]));
    const target = computeLabStats(new Uint8ClampedArray([45, 90, 190, 255]));
    const result = applyReinhardTransfer(new Uint8ClampedArray([45, 90, 190, 33]), ref, target);
    expect([...result]).toEqual([210, 100, 40, 33]);
    expect(createReinhardLut(ref, target, 3).data).toHaveLength(81);
  });
  it("evaluates preset and reference graph, rejects cycles", () => {
    expect(evaluateCraftGraph(compilePresetToGraph("slow-push"), 1, () => 0)).toBeCloseTo(1.08);
    const graph = { nodes: [{ id: "a", kind: "reference" as const, params: { key: "audio.rms" } }], output: "a" };
    expect(evaluateCraftGraph(graph, 0, () => 0.5)).toBe(0.5);
    expect(toGraph(graph).getNodesCount()).toBe(1);
    expect(() => toGraph({ nodes: [{ id: "a", kind: "combine", inputs: ["a"], params: {} }], output: "a" })).toThrow(/cycle/);
  });
  it("handles empty motion without NaNs", () => expect(classifyDominantMove([])).toBe("static"));
});
