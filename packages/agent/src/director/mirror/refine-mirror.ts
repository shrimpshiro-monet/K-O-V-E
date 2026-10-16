import { ssim, type GrayImage } from "./ssim";
import { rhythmSimilarity } from "@kove-advanced/core/rhythm/dtw";
export interface ProxySample { timeSeconds: number; reference: GrayImage }
export interface RefineKnobs { motionScale: number; gradeStrength: number }
export interface RefineResult { bestKnobs: RefineKnobs; bestScore: number; bestSsim: number; rhythmScore: number; lpipsDistance?: number; history: number[]; trials: number }
/** Async black-box critic. The caller owns actual proxy rendering and project mutations.
 * Returns no "perceptual" score when a renderer is unavailable; restoration of the
 * best state is guaranteed on successful search or failure after the first render. */
export async function refineMirror(opts: {
  samples: readonly ProxySample[];
  referenceDurations: readonly number[];
  candidateDurations: readonly number[];
  apply: (knobs: RefineKnobs) => Promise<void>;
  render: (timeSeconds: number) => Promise<GrayImage>;
  iterations?: number;
  targetScore?: number;
  seed?: number;
  /** Optional real LPIPS model. Distance 0..1, lower is better; never substitute a proxy. */
  lpips?: (reference: GrayImage, candidate: GrayImage) => Promise<number>;
}): Promise<RefineResult> {
  if (!opts.samples.length || opts.samples.length > 12) throw new Error("Proxy refinement needs 1..12 real reference frames");
  const iterations = opts.iterations ?? 8;
  if (!Number.isInteger(iterations) || iterations < 0 || iterations > 100) throw new Error("Invalid refinement budget");
  const rhythm = rhythmSimilarity(opts.referenceDurations, opts.candidateDurations);
  let state = (opts.seed ?? 0x1234abcd) >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const score = async (knobs: RefineKnobs) => {
    await opts.apply(knobs);
    let similarity = 0, distance = 0;
    for (const { timeSeconds, reference } of opts.samples) {
      const candidate = await opts.render(timeSeconds);
      similarity += Math.max(0, ssim(reference, candidate));
      if (opts.lpips) {
        const measured = await opts.lpips(reference, candidate);
        if (!Number.isFinite(measured) || measured < 0 || measured > 1) throw new Error("Invalid LPIPS model output");
        distance += measured;
      }
    }
    const bestSsim = similarity / opts.samples.length;
    const lpipsDistance = opts.lpips ? distance / opts.samples.length : undefined;
    const visual = lpipsDistance === undefined ? bestSsim : (bestSsim + 1 - lpipsDistance) / 2;
    return { total: Math.min(1, 0.75 * visual + 0.25 * rhythm), bestSsim, lpipsDistance };
  };
  let best: RefineKnobs = { motionScale: 1, gradeStrength: 1 };
  let bestScore = -Infinity;
  let bestMetrics: Awaited<ReturnType<typeof score>> | undefined;
  const history: number[] = [];
  try {
    bestMetrics = await score(best);
    bestScore = bestMetrics.total;
    history.push(bestScore);
    for (let i = 0; i < iterations && bestScore < (opts.targetScore ?? 0.94); i++) {
      const sigma = Math.pow(0.85, i);
      const candidate: RefineKnobs = {
        motionScale: Math.max(0.6, Math.min(1.4, best.motionScale + (random() * 2 - 1) * 0.3 * sigma)),
        gradeStrength: Math.max(0, Math.min(1, best.gradeStrength + (random() * 2 - 1) * 0.4 * sigma)),
      };
      const value = await score(candidate);
      if (value.total > bestScore) { best = candidate; bestScore = value.total; bestMetrics = value; }
      history.push(bestScore);
    }
    return { bestKnobs: best, bestScore, bestSsim: bestMetrics!.bestSsim, rhythmScore: rhythm, ...(bestMetrics!.lpipsDistance !== undefined && { lpipsDistance: bestMetrics!.lpipsDistance }), history, trials: history.length };
  } finally { await opts.apply(best); }
}
