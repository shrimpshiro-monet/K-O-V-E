import { describe, expect, it } from "vitest";
import type { EditPlan } from "@kove-advanced/creation-schema";
import {
  PLAN_REVIEW_FPS,
  collectPlanEffectEntries,
  planTimelineDurationSec,
  reviewEditPlan,
} from "./plan-review";

function makePlan(overrides: Partial<EditPlan> = {}): EditPlan {
  return {
    segments: [
      {
        sourceVideoId: "video-1",
        sourceStartTime: 0,
        sourceEndTime: 30,
        targetPosition: 0,
        effects: [],
        rationale: "a",
      },
      {
        sourceVideoId: "video-1",
        sourceStartTime: 30,
        sourceEndTime: 60,
        targetPosition: 30,
        effects: [],
        rationale: "b",
      },
    ],
    textElements: [],
    effects: [],
    transitions: [],
    audioDecisions: [],
    metadata: {
      targetDuration: 60,
      targetPlatform: "youtube",
      genre: "longform",
      pacing: "medium",
      rationale: "test",
    },
    ...overrides,
  };
}

describe("plan effect-cost entries", () => {
  it("treats segment-scoped effect names as full-segment duration", () => {
    const plan = makePlan({
      segments: [
        {
          sourceVideoId: "v",
          sourceStartTime: 0,
          sourceEndTime: 20,
          effects: ["sharpen"],
          rationale: "a",
        },
      ],
    });
    expect(planTimelineDurationSec(plan)).toBe(20);
    expect(collectPlanEffectEntries(plan)).toEqual([
      { type: "sharpen", durationSec: 20 },
    ]);
  });

  it("honors startOffset/duration on effect specs (the 0.3s hit)", () => {
    const plan = makePlan({
      segments: [
        {
          sourceVideoId: "v",
          sourceStartTime: 0,
          sourceEndTime: 20,
          effects: [],
          effectSpecs: [
            {
              type: "shader",
              params: { shaderId: "speed-lines" },
              startOffset: 4.5,
              duration: 0.3,
              rationale: "hit",
            },
          ],
          rationale: "a",
        },
      ],
    });
    expect(collectPlanEffectEntries(plan)).toEqual([
      { type: "shader", durationSec: 0.3 },
    ]);
  });

  it("clamps a spec window to its host segment and applies speed", () => {
    const plan = makePlan({
      segments: [
        {
          sourceVideoId: "v",
          sourceStartTime: 0,
          sourceEndTime: 10,
          speed: 2, // 5s on the timeline
          effects: [],
          effectSpecs: [
            {
              type: "grain",
              params: {},
              startOffset: 1,
              duration: 100, // far beyond the host window
              rationale: "texture",
            },
          ],
          rationale: "a",
        },
      ],
    });
    expect(planTimelineDurationSec(plan)).toBe(5);
    expect(collectPlanEffectEntries(plan)).toEqual([
      { type: "grain", durationSec: 4 }, // 5 − 1 offset
    ]);
  });

  it("places top-level plan effects on their target segment or the whole timeline", () => {
    const plan = makePlan({
      effects: [
        { type: "tonal", params: {}, targetSegmentIndex: 0, rationale: "look" },
        { type: "vignette", params: {}, rationale: "global" },
      ],
    });
    expect(collectPlanEffectEntries(plan)).toEqual([
      { type: "tonal", durationSec: 30 },
      { type: "vignette", durationSec: 60 },
    ]);
  });
});

describe("plan review effect-cost budget", () => {
  it("flags a long-form plan that sharpens the entire hour", () => {
    const hourSegment = {
      sourceVideoId: "v",
      sourceStartTime: 0,
      sourceEndTime: 3600,
      effects: ["sharpen", "motion-blur"],
      rationale: "everything",
    };
    const plan = makePlan({
      segments: [hourSegment],
      metadata: { ...makePlan().metadata, targetDuration: 3600 },
    });
    const review = reviewEditPlan(plan);

    expect(review.effectCost.overBudget).toBe(true);
    // (161.74 + 249.3) ms/frame × 30 fps ≈ 12.3× real time.
    expect(review.effectCost.realtimeRatio).toBeGreaterThan(12);
    expect(review.revisionBrief).toContain("Effect-cost review");
    expect(review.revisionBrief).toContain("exceeds the budget");
  });

  it("passes the same look scoped as a 0.3s hit", () => {
    const plan = makePlan({
      segments: [
        {
          sourceVideoId: "v",
          sourceStartTime: 0,
          sourceEndTime: 3600,
          effects: [],
          effectSpecs: [
            {
              type: "sharpen",
              params: {},
              startOffset: 120,
              duration: 0.3,
              rationale: "accent",
            },
          ],
          rationale: "everything",
        },
      ],
      metadata: { ...makePlan().metadata, targetDuration: 3600 },
    });
    const review = reviewEditPlan(plan);
    expect(review.effectCost.overBudget).toBe(false);
    expect(review.revisionBrief).not.toContain("exceeds the budget");
  });

  it("estimates in frames at the review fps", () => {
    const plan = makePlan({
      segments: [
        {
          sourceVideoId: "v",
          sourceStartTime: 0,
          sourceEndTime: 1,
          effects: ["sharpen"],
          rationale: "one second",
        },
      ],
    });
    const review = reviewEditPlan(plan);
    expect(PLAN_REVIEW_FPS).toBe(30);
    expect(review.effectCost.estimatedCpuMs).toBeCloseTo(30 * 161.74, 6);
  });
});
