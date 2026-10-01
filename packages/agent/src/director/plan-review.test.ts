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
    // Style is a perfect match, but this fixture is two splices with one
    // effect — the density gate is what stops that shape from shipping.
    expect(review.density.score).toBeLessThan(0.6);
    expect(review.needsRevision).toBe(true);
    expect(review.revisionBrief).toContain("Density score");
    expect(review.revisionBrief).toContain("cameraMoves");
  });

  it("accepts a populated plan whose density matches its pacing", () => {
    const dense: EditPlan = {
      ...plan,
      segments: Array.from({ length: 10 }, (_, index) => ({
        sourceVideoId: "video-1",
        sourceStartTime: index * 0.4,
        sourceEndTime: index * 0.4 + (index % 3 === 0 ? 0.35 : 0.9),
        targetPosition: index,
        effects: [],
        cameraMoves: [{ move: index % 3 === 0 ? "handheld" : index % 3 === 1 ? "slow-push" : "punch-in" }],
        effectSpecs: [
          { type: "chromatic-aberration", params: { amount: 20 }, intensity: 0.8, duration: 0.3, rationale: "hit" },
        ],
        ...(index > 6 ? { speedRamp: { keyframes: [{ time: 0, speed: 1 }, { time: 0.4, speed: 0.4 }] } } : {}),
        rationale: `shot ${index}`,
      })),
      textElements: [0, 2, 4, 6].map((index) => ({
        content: `caption ${index}`,
        style: "caption" as const,
        startTime: index,
        duration: 1,
        animation: ["pop", "slide-up", "typewriter", "cascade"][index % 4]!,
        rationale: "caption",
      })),
      transitions: [
        { afterSegmentIndex: 2, type: "flash", duration: 0.2, rationale: "chapter" },
        { afterSegmentIndex: 6, type: "whipPan", duration: 0.2, rationale: "chapter" },
      ],
      audioDecisions: [
        { type: "music", sourceVideoId: "audio-1", startTime: 0, duration: 8, volume: 0.7, rationale: "bed" },
        ...[0, 2, 5].map((index) => ({
          type: "sfx" as const,
          sourceVideoId: "audio-1",
          startTime: index,
          duration: 0.2,
          volume: 1,
          rationale: "hit",
        })),
      ],
      metadata: { ...plan.metadata, targetDuration: 8, pacing: "fast" },
    };

    const review = reviewEditPlan(dense, undefined);
    expect(review.density.score).toBeGreaterThan(0.75);
    expect(review.needsRevision).toBe(false);
    expect(review.density.profile.cameraMoveRatio).toBe(1);
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