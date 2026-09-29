import { describe, expect, it } from "vitest";
import type { EditPlan } from "@kove-advanced/creation-schema";
import { measureEditPlanStyle, reviewEditPlan, reviewMaterializedDraft } from "./plan-review";

const plan: EditPlan = {
  segments: [
    {
      sourceVideoId: "video-1",
      sourceStartTime: 0,
      sourceEndTime: 2,
      targetPosition: 0,
      effects: ["chromatic-aberration"],
      rationale: "hook",
    },
    {
      sourceVideoId: "video-1",
      sourceStartTime: 2,
      sourceEndTime: 4,
      targetPosition: 2,
      effects: [],
      rationale: "payoff",
    },
  ],
  textElements: [],
  effects: [],
  transitions: [{ afterSegmentIndex: 0, type: "hardCut", duration: 0, rationale: "cut" }],
  audioDecisions: [],
  metadata: {
    targetDuration: 4,
    targetPlatform: "social",
    genre: "highlight-reel",
    pacing: "fast",
    rationale: "test",
  },
};

describe("edit plan review", () => {
  it("measures plan style and accepts a matching target", () => {
    const profile = measureEditPlanStyle(plan);
    expect(profile.cutsPerMinute).toBe(30);
    expect(profile.effectPalette).toEqual(["chromatic-aberration"]);

    const review = reviewEditPlan(plan, {
      id: "highlight-reel",
      name: "Highlight Reel",
      description: "Fast highlight",
      rules: {
        pacing: "fast",
        transitionPreference: ["hardCut"],
        effectPalette: ["chromatic-aberration"],
        textStyle: "minimal",
        cutStyle: "hard",
        musicRole: "rhythmic",
      },
      cutsPerMinuteTarget: [24, 45],
    });

    expect(review.score).toBe(1);
    expect(review.needsRevision).toBe(false);
  });

  it("self-reviews materialization and flags low-confidence footage", () => {
    const styleReview = reviewEditPlan(plan);
    const review = reviewMaterializedDraft(plan, {
      videos: [{
        videoId: "video-1",
        duration: 4,
        segments: [{
          id: "segment-1",
          startTime: 0,
          endTime: 4,
          description: "uncertain shot",
          sceneType: "action",
          motionLevel: "high",
          hasDialogue: false,
          visualContent: "uncertain shot",
          confidence: 0.2,
        }],
      }],
    }, {
      clipIds: ["clip-1", "clip-2"],
      textIds: [],
      effectCount: 0,
      transitionCount: 1,
      audioCount: 0,
    }, styleReview);

    expect(review.lowConfidenceSegments).toEqual(["video-1:segment-1"]);
    expect(review.execution.expectedTransitions).toBe(1);
    expect(review.issues.some((issue) => issue.includes("low analysis confidence"))).toBe(true);
  });
});