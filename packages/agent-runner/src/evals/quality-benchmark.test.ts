import { describe, expect, it } from "vitest";
import { scoreQualityBenchmark } from "./quality-benchmark";

describe("quality benchmark", () => {
  it("reports candidate improvement on a shared rubric", () => {
    const result = scoreQualityBenchmark("sports-highlight", {
      momentSelection: 0.4,
      timing: 0.4,
      rhythm: 0.5,
      visualCoherence: 0.6,
      effectRestraint: 0.7,
      overall: 0,
    }, {
      momentSelection: 0.8,
      timing: 0.8,
      rhythm: 0.75,
      visualCoherence: 0.8,
      effectRestraint: 0.85,
      overall: 0,
    });
    expect(result.candidate.overall).toBeGreaterThan(result.baseline.overall);
    expect(result.improvement).toBeGreaterThan(0.2);
  });
});