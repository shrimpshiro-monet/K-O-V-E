/**
 * Effect-cost budget for plan review.
 *
 * The per-frame costs come from src/video/effect-cost-audit.probe.test.ts
 * (1920×1080, CPU pixel path, effect applied every frame). Per the audit's
 * provenance note these are UPPER BOUNDS measured in this sandbox's CPU:
 * they rank effects and budget plans — they are NOT export-time predictions.
 *
 * Until the WebGPU pipeline is fixed, applyEffects hard-routes every
 * non-CSS effect through the CPU pixel loop, so a 60-minute edit loaded with
 * full-duration sharpen/motion-blur means hours of extra render work. The
 * budget flags such plans at review time, before they are materialized.
 */

/** Upper-bound ms/frame for CPU-path pixel effects (audit table). */
export const CPU_EFFECT_COST_MS_PER_FRAME: Readonly<Record<string, number>> = {
  "motion-blur": 249.3,
  "radial-blur": 163.93,
  sharpen: 161.74,
  grain: 53.5,
  vignette: 39.98,
  tonal: 34.9, // measured range 25.4–34.9 after the luma-LUT fix; bound = worst end
  temperature: 26.51,
  tint: 23.29,
  "chromatic-aberration": 11.96,
};

/**
 * CSS-routed effects are composited by the browser (buildCSSFilter) and cost
 * no per-pixel JS work — they never blow the CPU budget on their own.
 */
export const CSS_EFFECT_TYPES: ReadonlySet<string> = new Set([
  "brightness",
  "contrast",
  "saturation",
  "grayscale",
  "sepia",
  "invert",
  "hue",
  "blur",
  "shadow",
  "glow",
]);

export type EffectCostClass = "cpu" | "css" | "unmeasured" | "unknown";

export interface EffectCostClassification {
  readonly class: EffectCostClass;
  /** Upper-bound ms/frame for cpu class; null otherwise. */
  readonly msPerFrame: number | null;
}

export function classifyEffectCost(effectType: string): EffectCostClassification {
  const ms = CPU_EFFECT_COST_MS_PER_FRAME[effectType];
  if (typeof ms === "number") return { class: "cpu", msPerFrame: ms };
  if (CSS_EFFECT_TYPES.has(effectType)) return { class: "css", msPerFrame: 0 };
  if (effectType === "shader") {
    // The 20 WebGL shader looks are NOT measured yet (audit ran the JS loop
    // path only). Flagged so plans full of them get a visibility warning,
    // but they are not budgeted as free either.
    return { class: "unmeasured", msPerFrame: null };
  }
  return { class: "unknown", msPerFrame: null };
}

export interface EffectCostEntry {
  readonly type: string;
  /** Seconds of footage the effect is active for. */
  readonly durationSec: number;
}

export interface EffectCostEstimate {
  readonly estimatedCpuMs: number;
  /** Seconds of footage carrying at least one CPU-path effect. */
  readonly cpuEffectSeconds: number;
  readonly entries: ReadonlyArray<{
    readonly type: string;
    readonly class: EffectCostClass;
    readonly durationSec: number;
    readonly msPerFrame: number | null;
    readonly estimatedMs: number;
  }>;
  /** Distinct unmeasured shader looks present (flagged, not budgeted). */
  readonly unmeasuredTypes: readonly string[];
}

export interface EffectCostBudgetOptions {
  readonly fps: number;
  /**
   * Budget in units of timeline real time: 1.0 allows effects to add at
   * most one full pass of real-time CPU work over the whole edit. Long-form
   * edits should stay at or under 1 until the GPU path lands.
   */
  readonly budgetRealtimeMultiplier?: number;
}

export interface EffectCostReview extends EffectCostEstimate {
  readonly fps: number;
  readonly timelineDurationSec: number;
  readonly budgetMs: number;
  readonly budgetRealtimeMultiplier: number;
  readonly overBudget: boolean;
  /** estimated / (timelineDuration × 1000): how many real-time passes the effects cost. */
  readonly realtimeRatio: number;
  readonly warnings: readonly string[];
}

/** Sums per-effect cost: durationSec × fps × msPerFrame (upper bound). */
export function estimateEffectCost(
  entries: readonly EffectCostEntry[],
  fps: number,
): EffectCostEstimate {
  const frameCountFor = (durationSec: number) => Math.max(0, durationSec) * fps;
  let estimatedCpuMs = 0;
  let cpuEffectSeconds = 0;
  const unmeasured = new Set<string>();
  const rows = entries.map((entry) => {
    const cost = classifyEffectCost(entry.type);
    const estimatedMs =
      cost.class === "cpu" && cost.msPerFrame !== null
        ? frameCountFor(entry.durationSec) * cost.msPerFrame
        : 0;
    if (cost.class === "cpu") cpuEffectSeconds += Math.max(0, entry.durationSec);
    if (cost.class === "unmeasured") unmeasured.add(entry.type);
    estimatedCpuMs += estimatedMs;
    return {
      type: entry.type,
      class: cost.class,
      durationSec: Math.max(0, entry.durationSec),
      msPerFrame: cost.msPerFrame,
      estimatedMs,
    };
  });
  return {
    estimatedCpuMs,
    cpuEffectSeconds,
    entries: rows,
    unmeasuredTypes: [...unmeasured].sort(),
  };
}

/** Judges an estimate against the budget; emits human-readable warnings. */
export function reviewEffectCost(
  estimate: EffectCostEstimate,
  timelineDurationSec: number,
  options: EffectCostBudgetOptions,
): EffectCostReview {
  const multiplier = options.budgetRealtimeMultiplier ?? 1;
  const budgetMs = Math.max(0, timelineDurationSec) * 1000 * multiplier;
  const realtimeRatio =
    timelineDurationSec > 0 ? estimate.estimatedCpuMs / (timelineDurationSec * 1000) : 0;
  const overBudget = estimate.estimatedCpuMs > budgetMs;

  const warnings: string[] = [];
  if (overBudget) {
    warnings.push(
      `Estimated effect CPU time ${(estimate.estimatedCpuMs / 60000).toFixed(1)} min exceeds the budget of ${(budgetMs / 60000).toFixed(1)} min (${realtimeRatio.toFixed(1)}× real time, upper-bound sandbox numbers). Reduce full-duration CPU effects (sharpen/motion-blur/radial-blur), scope them with startOffset/duration, or accept a long export.`,
    );
  }
  const heavy = estimate.entries
    .filter((row) => row.class === "cpu" && row.durationSec >= 0.75 * Math.max(timelineDurationSec, 0.001))
    .map((row) => row.type);
  if (heavy.length > 0) {
    warnings.push(
      `CPU-path effect(s) ${heavy.join(", ")} run for ~the entire timeline; gate them with startOffset/duration where the look only needs to hit briefly.`,
    );
  }
  if (estimate.unmeasuredTypes.length > 0) {
    warnings.push(
      `Unmeasured shader look(s) present (${estimate.unmeasuredTypes.length} effect instance(s)) — GPU cost unknown until benchmarked in a real browser.`,
    );
  }

  return {
    ...estimate,
    fps: options.fps,
    timelineDurationSec,
    budgetMs,
    budgetRealtimeMultiplier: multiplier,
    overBudget,
    realtimeRatio,
    warnings,
  };
}
