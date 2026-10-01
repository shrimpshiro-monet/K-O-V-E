import { describe, expect, it } from "vitest";
import type { EditPlan, SegmentMap } from "./index";
import {
  canonicalizePlanTransitions,
  canonicalizeTransitionType,
  isSupportedTransitionType,
  normalizeEditPlan,
  summarizeSegmentMap,
  validateEditPlan,
} from "./index";

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


  it("keeps every advertised transition name in sync with the renderer vocabulary", () => {
    // The prompt tells the model exactly these names; the validator must accept
    // each one or the model would be punished for following instructions.
    const advertised = [
      "crossZoom",
      "zoomBlur",
      "motionSmear",
      "strobeCut",
      "impactShake",
      "lumaWipe",
      "inkBleed",
      "tileFlip",
      "sliceSlide",
      "lightLeak",
      "vhsScan",
      "paperBurn",
      "pixelSort",
      "filmRoll",
    ];
    for (const type of advertised) {
      expect(isSupportedTransitionType(type), type).toBe(true);
      expect(canonicalizeTransitionType(type), type).toBe(type);
    }
    expect(advertised).toHaveLength(14);
  });

  it("canonicalizes second-wave transition aliases instead of rejecting them", () => {
    expect(canonicalizeTransitionType("whip-zoom")).toBe("crossZoom");
    expect(canonicalizeTransitionType("Whip Zoom")).toBe("crossZoom");
    expect(canonicalizeTransitionType("datamosh")).toBe("pixelSort");
    expect(canonicalizeTransitionType("luma-dissolve")).toBe("lumaWipe");
    expect(canonicalizeTransitionType("burn-through")).toBe("paperBurn");
    expect(canonicalizeTransitionType("tape-wipe")).toBe("vhsScan");
    expect(canonicalizeTransitionType("card-flip")).toBe("tileFlip");
    expect(canonicalizeTransitionType("film-roll")).toBe("filmRoll");
  });

  it("drops hard cuts but keeps rendered second-wave transitions", () => {
    const withTransitions: EditPlan = {
      ...plan,
      segments: [plan.segments[0]!, { ...plan.segments[0]!, targetPosition: 4 }],
      transitions: [
        { afterSegmentIndex: 0, type: "hardCut", duration: 0.2, rationale: "cut" },
        { afterSegmentIndex: 0, type: "impactShake", duration: 0.3, rationale: "hit" },
      ],
    };
    const canonical = canonicalizePlanTransitions(withTransitions);
    expect(canonical.transitions.map((transition) => transition.type)).toEqual(["impactShake"]);
  });

  it("accepts second-wave transitions through validation", () => {
    const map: SegmentMap = {
      videos: [{ videoId: "video-1", duration: 12, segments: [] }],
    };
    const result = validateEditPlan(
      {
        ...plan,
        segments: [plan.segments[0]!, { ...plan.segments[0]!, targetPosition: 4 }],
        transitions: [
          { afterSegmentIndex: 0, type: "zoomBlur", duration: 0.3, rationale: "whip" },
          { afterSegmentIndex: 0, type: "not-a-transition", duration: 0.3, rationale: "nope" },
        ],
      },
      map,
    );
    const unsupported = result.filter((issue) => issue.code === "unsupported_transition");
    // Exactly one rejection: zoomBlur is accepted, only the junk name is flagged.
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]!.message).toContain("not-a-transition");
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
          type: "chromatic-aberration",
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

  it("rejects colorGrade with empty params in seg.effectSpecs", () => {
    const issues = validateEditPlan({
      ...plan,
      metadata: { ...plan.metadata, targetDuration: 4 },
      segments: [{
        ...plan.segments[0],
        sourceStartTime: 0,
        sourceEndTime: 4,
        effectSpecs: [{
          type: "colorGrade",
          params: {},
          rationale: "test",
        }],
      }],
    }, { videos: [{ videoId: "video-1", duration: 4, segments: [] }] });
    expect(issues.map((i) => i.code)).toContain("empty_color_grade_params");
  });

  it("warns on non-colorGrade effect specs with no params and no intensity", () => {
    const segment = {
      ...plan.segments[0],
      sourceStartTime: 0,
      sourceEndTime: 4,
      effectSpecs: [{ type: "chromatic-aberration", rationale: "test" }],
    };
    const map = { videos: [{ videoId: "video-1", duration: 4, segments: [] }] };
    const missing = validateEditPlan(
      // Cast: PlannedEffectSpec marks `params` required, but LLM-supplied JSON
      // routinely omits it — that is exactly the case under test.
      { ...plan, metadata: { ...plan.metadata, targetDuration: 4 }, segments: [segment] } as unknown as EditPlan,
      map,
    ).filter((issue) => issue.code === "effect_spec_missing_params");
    expect(missing).toHaveLength(1);
    expect(missing[0]!.severity).toBe("warning");

    const withIntensity = validateEditPlan(
      {
        ...plan,
        metadata: { ...plan.metadata, targetDuration: 4 },
        segments: [
          { ...segment, effectSpecs: [{ type: "chromatic-aberration", intensity: 0.7, rationale: "test" }] },
        ],
      } as unknown as EditPlan,
      map,
    );
    expect(withIntensity.map((issue) => issue.code)).not.toContain("effect_spec_missing_params");
  });

  it("rejects colorGrade with empty params in plan.effects", () => {
    const issues = validateEditPlan({
      ...plan,
      metadata: { ...plan.metadata, targetDuration: 4 },
      effects: [{
        type: "colorGrade",
        params: {},
        targetSegmentIndex: 0,
        rationale: "test",
      }],
    }, { videos: [{ videoId: "video-1", duration: 4, segments: [] }] });
    expect(issues.map((i) => i.code)).toContain("empty_color_grade_params");
  });

  it("warns about colorGrade in seg.effects string array (implicit empty params)", () => {
    const issues = validateEditPlan({
      ...plan,
      metadata: { ...plan.metadata, targetDuration: 4 },
      segments: [{
        ...plan.segments[0],
        sourceStartTime: 0,
        sourceEndTime: 4,
        effects: ["colorGrade"],
      }],
    }, { videos: [{ videoId: "video-1", duration: 4, segments: [] }] });
    expect(issues.map((i) => i.code)).toContain("implicit_color_grade_params");
  });

  it("accepts colorGrade aliases via isColorGradeType", () => {
    const aliases = ["colorGrade", "color-grade", "color_grading", "colorgrading", "color-grading", "color_grade"];
    for (const alias of aliases) {
      const issues = validateEditPlan({
        ...plan,
        metadata: { ...plan.metadata, targetDuration: 4 },
        effects: [{
          type: alias,
          params: { brightness: 0.5 },
          targetSegmentIndex: 0,
          rationale: "test",
        }],
      }, { videos: [{ videoId: "video-1", duration: 4, segments: [] }] });
      const typeErrors = issues.filter((i) => i.code === "unknown_effect_type");
      expect(typeErrors).toHaveLength(0);
    }
  });

  it("emits a misplaced-feature hint for speed-ramp in effectSpecs", () => {
    const issues = validateEditPlan({
      ...plan,
      metadata: { ...plan.metadata, targetDuration: 4 },
      segments: [{
        ...plan.segments[0],
        sourceStartTime: 0,
        sourceEndTime: 4,
        effectSpecs: [{
          type: "speed-ramp",
          params: {},
          rationale: "match reference energy",
        }],
      }],
    }, { videos: [{ videoId: "video-1", duration: 4, segments: [] }] });

    const speedRampIssue = issues.find((i) => i.path?.endsWith(".type"));
    expect(speedRampIssue).toBeDefined();
    expect(speedRampIssue!.code).toBe("misplaced_feature");
    expect(speedRampIssue!.message).toContain("segment.speedRamp");
  });
});
