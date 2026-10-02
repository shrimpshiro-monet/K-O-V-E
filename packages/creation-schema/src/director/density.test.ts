import { describe, expect, it } from "vitest";
import type { EditPlan, PlannedSegment } from "./edit-plan";
import type { SegmentMap } from "./segment-map";
import {
  compareEditDensity,
  formatDensityBrief,
  measureEditDensity,
  planDensityBudget,
  resolveDensityTarget,
} from "./density";

function segment(overrides: Partial<PlannedSegment> = {}): PlannedSegment {
  return {
    sourceVideoId: "video-1",
    sourceStartTime: 0,
    sourceEndTime: 1,
    effects: [],
    rationale: "test",
    ...overrides,
  };
}

/** Three splices: the plan shape this whole module exists to reject. */
const thinPlan: EditPlan = {
  segments: [
    segment({ sourceStartTime: 0, sourceEndTime: 2 }),
    segment({ sourceStartTime: 2, sourceEndTime: 4 }),
    segment({ sourceStartTime: 4, sourceEndTime: 6 }),
  ],
  textElements: [],
  effects: [],
  transitions: [],
  audioDecisions: [],
  metadata: { targetDuration: 6, targetPlatform: "tiktok", genre: "social-reel", pacing: "fast", rationale: "thin" },
};

/** A populated short-form edit: 12 shots, moves, hits, texts, sfx, escalation. */
const densePlan: EditPlan = {
  // Shot lengths alternate deliberately (contrast ≈ 5x) and the final third
  // is faster and more heavily treated — the "evolution" the review looks for.
  segments: (() => {
    const durations = [1.6, 0.4, 1.4, 0.5, 1.2, 0.45, 0.9, 0.35, 0.32, 0.3, 0.3, 0.28];
    let cursor = 0;
    return durations.map((duration, index) => {
      const start = cursor;
      cursor += duration;
      const late = index >= 8;
      return segment({
        sourceStartTime: start,
        sourceEndTime: cursor,
        targetPosition: index,
        cameraMoves: [
          {
            move: index % 3 === 0 ? "handheld" : index % 3 === 1 ? "slow-push" : "punch-in",
            intensity: late ? 0.9 : 0.7,
          },
        ],
        effectSpecs: Array.from({ length: late ? 2 : 1 }, (_, hit) => ({
          type:
            (index + hit) % 4 === 0
              ? "chromatic-aberration"
              : (index + hit) % 4 === 1
                ? "glow"
                : (index + hit) % 4 === 2
                  ? "motion-blur"
                  : "grain",
          params: { amount: 20 },
          intensity: late ? 0.9 : 0.7,
          duration: 0.3,
          rationale: "hit",
        })),
        ...(late || index % 4 === 1
          ? { speedRamp: { keyframes: [{ time: 0, speed: 1 }, { time: 0.5, speed: 0.4 }] } }
          : {}),
      });
    });
  })(),
  textElements: [0, 3, 6, 9].map((index) => ({
    content: `TEXT ${index}`,
    style: "caption" as const,
    startTime: index,
    duration: 1.5,
    animation: ["pop", "slide-up", "typewriter", "cascade"][(index / 3) % 4]!,
    rationale: "hook",
  })),
  effects: [],
  transitions: [
    { afterSegmentIndex: 2, type: "flash", duration: 0.2, rationale: "chapter" },
    { afterSegmentIndex: 6, type: "whipPan", duration: 0.2, rationale: "chapter" },
  ],
  audioDecisions: [
    { type: "music", sourceVideoId: "audio-1", startTime: 0, duration: 12, volume: 0.7, rationale: "bed" },
    ...[0, 2, 5, 8, 10].map((index) => ({
      type: "sfx" as const,
      sourceVideoId: "audio-1",
      startTime: index,
      duration: 0.3,
      volume: 1,
      rationale: "hit",
    })),
  ],
  motionMoments: [{ move: "glitch-transition", atTime: 6 }],
  metadata: { targetDuration: 12, targetPlatform: "tiktok", genre: "social-reel", pacing: "fast", rationale: "dense" },
};

const beatMap: SegmentMap = {
  videos: [
    {
      videoId: "video-1",
      duration: 12,
      segments: [
        {
          id: "s1",
          startTime: 0,
          endTime: 12,
          description: "music bed",
          sceneType: "b-roll",
          motionLevel: "medium",
          hasDialogue: false,
          visualContent: "footage",
          confidence: 0.9,
          beatTimestamps: [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6],
        },
      ],
    },
  ],
};

describe("edit density measurement", () => {
  it("measures a spliced timeline as thin", () => {
    const profile = measureEditDensity(thinPlan);
    expect(profile.shotCount).toBe(3);
    expect(profile.shotsPerMinute).toBe(30);
    expect(profile.effectHits).toBe(0);
    expect(profile.treatedShotRatio).toBe(0);
    expect(profile.cameraMoveCount).toBe(0);
    expect(profile.escalation).toBe("flat");
  });

  it("measures a populated edit as dense and evolving", () => {
    const profile = measureEditDensity(densePlan, beatMap);
    expect(profile.shotCount).toBe(12);
    expect(profile.effectHits).toBe(16);
    expect(profile.distinctEffectTypes).toBe(4);
    expect(profile.cameraMoveCount).toBe(12);
    expect(profile.cameraMoveRatio).toBe(1);
    expect(profile.distinctCameraMoves).toBe(3);
    expect(profile.treatedShotRatio).toBe(1);
    expect(profile.shotLengthContrast).toBeGreaterThan(3);
    expect(profile.speedRampCount).toBe(6);
    expect(profile.sfxHits).toBe(5);
    expect(profile.distinctTextAnimations).toBe(4);
    expect(profile.onBeatCutRatio).not.toBeNull();
    expect(profile.escalation).toBe("rising");
  });

  it("returns null beat alignment when the footage has no beat data", () => {
    expect(measureEditDensity(densePlan).onBeatCutRatio).toBeNull();
  });
});

describe("edit density review", () => {
  const fastTarget = resolveDensityTarget("fast");

  it("fails a thin plan with actionable, additive directives", () => {
    const review = compareEditDensity(measureEditDensity(thinPlan), fastTarget);
    expect(review.score).toBeLessThan(0.6);
    const codes = review.deficiencies.map((deficiency) => deficiency.code);
    expect(codes).toContain("effect_density");
    expect(codes).toContain("camera_motion");
    expect(codes).toContain("static_shots");
    expect(codes).toContain("no_evolution");
    // Directives are executable: they name the numeric gap and the fix.
    const camera = review.deficiencies.find((deficiency) => deficiency.code === "camera_motion");
    expect(camera!.directive).toContain("cameraMoves");
    expect(camera!.severity).toBe("major");
  });

  it("passes a populated, evolving plan", () => {
    const review = compareEditDensity(measureEditDensity(densePlan, beatMap), fastTarget);
    expect(review.score).toBeGreaterThan(0.9);
    expect(review.deficiencies).toEqual([]);
    expect(formatDensityBrief(review)).toContain("Density score");
    expect(formatDensityBrief(review)).toContain("populated");
  });

  it("scales its budget to the requested length", () => {
    const short = planDensityBudget(fastTarget, 15);
    const long = planDensityBudget(fastTarget, 60);
    expect(short.shots[0]).toBeLessThan(long.shots[0]);
    expect(short.effectHits[1]).toBeLessThan(long.effectHits[1]);
    expect(long.cameraMoves).toBeGreaterThan(short.cameraMoves);
    expect(long.targetDuration).toBe(60);
  });

  it("lists the highest-severity problems first in the brief", () => {
    const review = compareEditDensity(measureEditDensity(thinPlan), fastTarget);
    const brief = formatDensityBrief(review);
    expect(brief).toContain("The edit is under-built");
    expect(brief.indexOf("major")).toBeLessThanOrEqual(brief.lastIndexOf("major"));
  });
});
