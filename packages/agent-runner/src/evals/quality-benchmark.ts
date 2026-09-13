export interface QualityBenchmarkScore {
  readonly momentSelection: number;
  readonly timing: number;
  readonly rhythm: number;
  readonly visualCoherence: number;
  readonly effectRestraint: number;
  readonly overall: number;
}

export interface QualityBenchmarkResult {
  readonly name: string;
  readonly baseline: QualityBenchmarkScore;
  readonly candidate: QualityBenchmarkScore;
  readonly improvement: number;
}

export function scoreQualityBenchmark(
  name: string,
  baseline: QualityBenchmarkScore,
  candidate: QualityBenchmarkScore,
): QualityBenchmarkResult {
  const baselineOverall = averageScore(baseline);
  const candidateOverall = averageScore(candidate);
  return {
    name,
    baseline: { ...baseline, overall: baselineOverall },
    candidate: { ...candidate, overall: candidateOverall },
    improvement: candidateOverall - baselineOverall,
  };
}

function averageScore(score: QualityBenchmarkScore): number {
  return [
    score.momentSelection,
    score.timing,
    score.rhythm,
    score.visualCoherence,
    score.effectRestraint,
  ].reduce((sum, value) => sum + Math.max(0, Math.min(1, value)), 0) / 5;
}