import { describe, expect, it } from "vitest";
import { dtwDistance, rhythmSimilarity } from "./dtw";
import { normalizeDurationsByTotal, tempoInvariantRhythmSimilarity } from "./tempo-invariant";

describe("total-duration-normalized rhythm (style comparisons only)", () => {
  it("proves uniform 2x retiming has a large raw cost but zero normalized cost", () => {
    const reference = [4, 4, 1, 1];
    const retimed = reference.map((duration) => 2 * duration);
    const rawCost = dtwDistance(reference, retimed).cost;
    const normalizedCost = dtwDistance(normalizeDurationsByTotal(reference), normalizeDurationsByTotal(retimed)).cost;
    expect(rawCost).toBeGreaterThan(2);
    expect(rhythmSimilarity(reference, retimed)).toBeLessThan(0.8);
    expect(normalizedCost).toBe(0);
    expect(tempoInvariantRhythmSimilarity(reference, retimed)).toBe(1);
    expect(normalizeDurationsByTotal(reference).reduce((sum, duration) => sum + duration, 0)).toBe(1);
  });

  it("still penalizes changes to the ordered pacing shape at the same total duration", () => {
    const reference = [4, 4, 1, 1];
    const reordered = [1, 1, 4, 4];
    const uniform = [2.5, 2.5, 2.5, 2.5];
    expect(tempoInvariantRhythmSimilarity(reference, reordered)).toBeLessThan(1);
    expect(tempoInvariantRhythmSimilarity(reference, uniform)).toBeLessThan(1);
  });

  it("aligns different cut counts without making their shapes identical", () => {
    const reference = [4, 4, 1, 1];
    const candidate = [4, 4, 1, 0.5, 0.5];
    const differentShape = [2, 2, 2, 2, 2];
    expect(dtwDistance(normalizeDurationsByTotal(reference), normalizeDurationsByTotal(candidate)).path.length).toBeGreaterThan(reference.length);
    expect(tempoInvariantRhythmSimilarity(reference, candidate)).toBeGreaterThan(tempoInvariantRhythmSimilarity(reference, differentShape));
  });

  it("does not divide by zero or conceal malformed duration inputs", () => {
    expect(tempoInvariantRhythmSimilarity([], [])).toBe(1);
    expect(tempoInvariantRhythmSimilarity([], [1])).toBe(0);
    expect(tempoInvariantRhythmSimilarity([0, 0], [0, 0])).toBe(1);
    expect(tempoInvariantRhythmSimilarity([0, 0], [1, 1])).toBeLessThan(1);
    expect(() => normalizeDurationsByTotal([0, 0])).toThrow(/zero-duration/);
    expect(() => tempoInvariantRhythmSimilarity([1, NaN], [1, 1])).toThrow(/finite/);
  });
});
