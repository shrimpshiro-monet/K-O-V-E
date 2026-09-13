import { describe, expect, it } from "vitest";
import type { EditPlan, SegmentMap } from "./index";
import { normalizeEditPlan, summarizeSegmentMap, validateEditPlan } from "./index";

const plan: EditPlan = {
  segments: [
    {
      sourceVideoId: "video-1",
      sourceStartTime: 4,
      sourceEndTime: 4,
      trackIndex: 0,
      targetPosition: 0,
      effects: [],
      rationale: "test",
    },
  ],
  textElements: [],
  effects: [],
  transitions: [],
  audioDecisions: [],
  metadata: {
    targetDuration: 4,
    targetPlatform: "social",
    genre: "test",
    pacing: "medium",
    rationale: "test",
  },
};

describe("director validation helpers", () => {
  it("repairs zero-length plan ranges to the source duration", () => {
    const map: SegmentMap = {
      videos: [{ videoId: "video-1", duration: 12, segments: [] }],
    };
    const normalized = normalizeEditPlan(plan, map);
    expect(normalized.segments[0].sourceStartTime).toBe(0);
    expect(normalized.segments[0].sourceEndTime).toBe(12);
  });

  it("summarizes malformed durations without throwing", () => {
    const map = { videos: [{ videoId: "video-1", duration: undefined, segments: [] }] } as unknown as SegmentMap;
    expect(summarizeSegmentMap(map)).toContain("0.0s total");
  });

  it("repairs non-positive transition durations", () => {
    const planWithTransition: EditPlan = {
      ...plan,
      segments: [
        { ...plan.segments[0], sourceStartTime: 0, sourceEndTime: 4 },
        { ...plan.segments[0], sourceStartTime: 4, sourceEndTime: 8 },
      ],
      transitions: [{ afterSegmentIndex: 0, type: "glitch", duration: 0, rationale: "test" }],
    };
    const normalized = normalizeEditPlan(planWithTransition, {
      videos: [{ videoId: "video-1", duration: 12, segments: [] }],
    });

    expect(normalized.transitions[0].duration).toBe(0.25);
  });

  it("validates speed ramps against source duration and speed limits", () => {
    const issues = validateEditPlan({
      ...plan,
      segments: [{
        ...plan.segments[0],
        sourceStartTime: 0,
        sourceEndTime: 4,
        speedRamp: {
          keyframes: [
            { time: 0, speed: 1 },
            { time: 2, speed: 3 },
          ],
          freezeFrames: [{ sourceTime: 1, startTime: 1, duration: 0.5 }],
        },
      }],
    }, { videos: [{ videoId: "video-1", duration: 4, segments: [] }] });
    expect(issues).toHaveLength(0);
  });

  it("warns about orphaned split layouts and rejects invalid custom rectangles", () => {
    const issues = validateEditPlan({
      ...plan,
      segments: [{
        ...plan.segments[0],
        sourceStartTime: 0,
        sourceEndTime: 4,
        layout: { region: "split-left" },
      }],
      metadata: { ...plan.metadata, targetDuration: 4 },
    }, { videos: [{ videoId: "video-1", duration: 4, segments: [] }] });
    expect(issues.map((issue) => issue.code)).toContain("orphan_split_layout");

    const invalid = validateEditPlan({
      ...plan,
      metadata: { ...plan.metadata, targetDuration: 4 },
      segments: [{ ...plan.segments[0], sourceStartTime: 0, sourceEndTime: 4, layout: { region: "custom", customRect: { x: 0.8, y: 0, width: 0.5, height: 1 } } }],
    }, { videos: [{ videoId: "video-1", duration: 4, segments: [] }] });
    expect(invalid.map((issue) => issue.code)).toContain("invalid_layout_rect");
  });

  it("validates motion moment segment references and timing", () => {
    const issues = validateEditPlan({
      ...plan,
      metadata: { ...plan.metadata, targetDuration: 4 },
      motionMoments: [{ move: "3d-title-card", segmentIndex: 4, atTime: -1, duration: 0 }],
    }, { videos: [{ videoId: "video-1", duration: 4, segments: [] }] });
    expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "invalid_motion_segment",
      "invalid_motion_time",
      "invalid_motion_duration",
    ]));
  });

  it("rejects invalid composable effect controls", () => {
    const issues = validateEditPlan({
      ...plan,
      metadata: { ...plan.metadata, targetDuration: 4 },
      segments: [{
        ...plan.segments[0],
        sourceStartTime: 0,
        sourceEndTime: 4,
        effectSpecs: [{
          type: "zoom-punch",
          params: {},
          intensity: 1.5,
          startOffset: -0.1,
          duration: 0,
          easing: "",
          rationale: "test",
        }],
      }],
    }, { videos: [{ videoId: "video-1", duration: 4, segments: [] }] });
    expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "effect_intensity_out_of_range",
      "effect_offset_out_of_range",
      "effect_duration_invalid",
      "effect_easing_invalid",
    ]));
  });
});
