import { keepRateForActionType } from "./taste-engine";
import { scorePlan, type QualityAxes } from "./edit-quality-score";
export interface TunableParam { path: string; min: number; max: number; current: number; actionType?: string }
export interface OptimizerConfig { trials: number; stepDecay: number; seed?: number; targetScore?: number }
/** Seeded (1+1) evolution strategy. Evaluator MUST measure the candidate; constant axes cannot improve a score. */
export function searchBestPlan(
  params: readonly TunableParam[], evaluate: (values: Record<string, number>) => QualityAxes,
  config: OptimizerConfig = { trials: 120, stepDecay: 0.98 },
): { bestValues: Record<string, number>; bestScore: number; history: number[] } {
  for (const p of params) if (!p.path || ![p.min, p.max, p.current].every(Number.isFinite) || p.min > p.max || p.current < p.min || p.current > p.max) throw new Error(`Invalid tunable ${p.path}`);
  if (!Number.isInteger(config.trials) || config.trials < 0 || config.trials > 10000 || config.stepDecay <= 0 || config.stepDecay > 1) throw new Error("Invalid optimizer config");
  let state = (config.seed ?? 0x6d2b79f5) >>> 0;
  const random = (): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return (state + 1) / 4294967297; };
  const gaussian = () => Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random());
  let best = Object.fromEntries(params.map((p) => [p.path, p.current]));
  let bestScore = scorePlan(evaluate({ ...best }));
  const history = [bestScore];
  let sigma = 0.25;
  for (let i = 0; i < config.trials && bestScore < (config.targetScore ?? 1); i++) {
    const candidate = { ...best };
    for (const p of params) candidate[p.path] = Math.max(p.min, Math.min(p.max, best[p.path] + gaussian() * sigma * (p.max - p.min) * (p.actionType ? 0.5 + keepRateForActionType(p.actionType) : 1)));
    const score = scorePlan(evaluate({ ...candidate }));
    if (score > bestScore) { best = candidate; bestScore = score; }
    sigma *= config.stepDecay;
    history.push(bestScore);
  }
  return { bestValues: best, bestScore, history };
}
