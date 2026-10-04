import { describe, expect, it } from "vitest";
import {
  CPU_EFFECT_COST_MS_PER_FRAME,
  classifyEffectCost,
  estimateEffectCost,
  reviewEffectCost,
} from "./effect-cost-budget";

describe("effect cost classification", () => {
  it("matches the audit table for CPU-path effects", () => {
    expect(classifyEffectCost("sharpen")).toEqual({ class: "cpu", msPerFrame: 161.74 });
    expect(classifyEffectCost("motion-blur").msPerFrame).toBe(249.3);
    expect(classifyEffectCost("tonal").msPerFrame).toBe(34.9);
  });

  it("routes CSS effects to the composited class at zero cost", () => {
    for (const type of ["brightness", "contrast", "saturation", "grayscale", "glow"]) {
      expect(classifyEffectCost(type)).toEqual({ class: "css", msPerFrame: 0 });
    }
  });

  it("flags shader looks as unmeasured and everything else unknown", () => {
    expect(classifyEffectCost("shader").class).toBe("unmeasured");
    expect(classifyEffectCost("some-future-effect").class).toBe("unknown");
  });
});

describe("estimateEffectCost", () => {
  it("estimates duration × fps × msPerFrame per CPU effect", () => {
    const estimate = estimateEffectCost(
      [{ type: "sharpen", durationSec: 10 }],
      30,
    );
    // 10s × 30fps × 161.74ms = 48,522ms
    expect(estimate.estimatedCpuMs).toBeCloseTo(10 * 30 * 161.74, 6);
    expect(estimate.cpuEffectSeconds).toBe(10);
  });

  it("ignores CSS cost but keeps unmeasured shader looks flagged", () => {
    const estimate = estimateEffectCost(
      [
        { type: "contrast", durationSec: 60 },
        { type: "shader", durationSec: 0.3 },
      ],
      30,
    );
    expect(estimate.estimatedCpuMs).toBe(0);
    expect(estimate.unmeasuredTypes).toEqual(["shader"]);
  });
});

describe("reviewEffectCost", () => {
  it("flags a 60-minute edit carrying full-duration motion-blur", () => {
    const timeline = 60 * 60; // 60 min
    const estimate = estimateEffectCost(
      [{ type: "motion-blur", durationSec: timeline }],
      30,
    );
    const review = reviewEffectCost(estimate, timeline, { fps: 30 });
    // 249.3ms/frame × 30fps ≈ 7.5s CPU per second of footage.
    expect(review.realtimeRatio).toBeCloseTo(7.479, 2);
    expect(review.overBudget).toBe(true);
    expect(review.warnings.join(" ")).toContain("exceeds the budget");
    expect(review.warnings.join(" ")).toContain("startOffset/duration");
  });

  it("accepts a 0.3s speed-lines hit budget-wise (shader = unmeasured, not CPU)", () => {
    const review = reviewEffectCost(
      estimateEffectCost([{ type: "shader", durationSec: 0.3 }], 30),
      90,
      { fps: 30 },
    );
    expect(review.overBudget).toBe(false);
    expect(review.warnings.join(" ")).toContain("Unmeasured shader");
  });

  it("accepts CSS-only grades on a long timeline", () => {
    const timeline = 60 * 60;
    const review = reviewEffectCost(
      estimateEffectCost(
        ["contrast", "saturation", "brightness"].map((type) => ({
          type,
          durationSec: timeline,
        })),
        30,
      ),
      timeline,
      { fps: 30 },
    );
    expect(review.overBudget).toBe(false);
    expect(review.warnings).toEqual([]);
  });

  it("warns when a CPU effect spans nearly the whole timeline", () => {
    const review = reviewEffectCost(
      estimateEffectCost([{ type: "sharpen", durationSec: 9 }], 30),
      10,
      { fps: 30 },
    );
    expect(review.warnings.join(" ")).toContain("~the entire timeline");
  });

  it("honors a custom budget multiplier", () => {
    const estimate = estimateEffectCost([{ type: "sharpen", durationSec: 10 }], 30);
    const tight = reviewEffectCost(estimate, 10, { fps: 30, budgetRealtimeMultiplier: 1 });
    const generous = reviewEffectCost(estimate, 10, { fps: 30, budgetRealtimeMultiplier: 10 });
    expect(tight.overBudget).toBe(true);
    expect(generous.overBudget).toBe(false);
  });

  it("keeps the table anchored to the audit measurements", () => {
    expect(CPU_EFFECT_COST_MS_PER_FRAME["radial-blur"]).toBe(163.93);
    expect(CPU_EFFECT_COST_MS_PER_FRAME["chromatic-aberration"]).toBe(11.96);
    expect(Object.keys(CPU_EFFECT_COST_MS_PER_FRAME)).toHaveLength(9);
  });
});
