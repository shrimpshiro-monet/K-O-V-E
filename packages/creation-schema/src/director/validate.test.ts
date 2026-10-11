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

// ---------------------------------------------------------------------------
// Audio media membership gate. materializeEditPlan resolves a music/sfx
// decision's sourceVideoId against the media library and throws (with full
// apply compensation) on an unresolvable ref — validation must catch it first,
// with the available media in the message so the repair pass can re-key.
// ---------------------------------------------------------------------------

describe("audio media membership gate", () => {
  const catalog = [
    { id: "video-1", name: "podcast #1.mp4", type: "video" as const },
    { id: "video-2", name: "podcast 2.mp4", type: "video" as const },
    { id: "audio-1", name: "audio/Dave - Raindance (ft. Tems).mp3", type: "audio" as const },
  ];
  const map: SegmentMap = {
    videos: [{ videoId: "video-1", duration: 12, segments: [] }],
  };
  const cleanPlan = (audioDecisions: EditPlan["audioDecisions"]): EditPlan => ({
    ...plan,
    segments: [
      { ...plan.segments[0]!, sourceVideoId: "video-1", sourceStartTime: 0, sourceEndTime: 4 },
    ],
    audioDecisions,
    metadata: { ...plan.metadata, targetDuration: 4 },
  });
  const music = (sourceVideoId: string): EditPlan["audioDecisions"][number] =>
    ({
      type: "music",
      sourceVideoId,
      startTime: 0,
      duration: 4,
      volume: 0.7,
      rationale: "bed",
    }) as EditPlan["audioDecisions"][number];

  it("rejects a hallucinated audio id with unknown_audio_media and lists the real media", () => {
    const issues = validateEditPlan(cleanPlan([music("music_1")]), map, catalog);
    const audio = issues.filter((issue) => issue.code === "unknown_audio_media");
    expect(audio).toHaveLength(1);
    expect(audio[0]!.severity).toBe("error");
    expect(audio[0]!.path).toBe("audioDecisions.0.sourceVideoId");
    // The message carries the hallucinated ref AND the available media, so the
    // bounded repair pass can re-key without a second discovery round-trip.
    expect(audio[0]!.message).toContain('"music_1"');
    expect(audio[0]!.message).toContain("audio-1 (audio/Dave - Raindance (ft. Tems).mp3)");
    expect(audio[0]!.message).toContain("video-1 (podcast #1.mp4)");
  });

  it("accepts refs that resolve by id or exact name, video sources included", () => {
    const issues = validateEditPlan(
      cleanPlan([music("audio-1"), music("audio/Dave - Raindance (ft. Tems).mp3"), music("video-1")]),
      map,
      catalog,
    );
    expect(issues.filter((issue) => issue.code === "unknown_audio_media")).toEqual([]);
  });

  it("checks sfx decisions and reports each offending index", () => {
    const issues = validateEditPlan(
      cleanPlan([
        { type: "sfx", sourceVideoId: "audio_raindance", startTime: 0, duration: 0.3, volume: 1, rationale: "hit" } as EditPlan["audioDecisions"][number],
        music("music_id"),
      ]),
      map,
      catalog,
    );
    const audio = issues.filter((issue) => issue.code === "unknown_audio_media");
    expect(audio.map((issue) => issue.path)).toEqual([
      "audioDecisions.0.sourceVideoId",
      "audioDecisions.1.sourceVideoId",
    ]);
  });

  it("skips silence decisions, empty refs, and applies no gate without a catalog", () => {
    const withSilence = cleanPlan([
      {
        type: "silence",
        sourceVideoId: "music_1", // ignored entirely: silence never resolves media
        startTime: 0,
        duration: 4,
        rationale: "no music",
      } as EditPlan["audioDecisions"][number],
      music("music_1"),
      music(""),
    ]);
    const gated = validateEditPlan(withSilence, map, catalog);
    // Only the non-empty, non-silence ref is flagged; silence and "" pass.
    expect(gated.filter((issue) => issue.code === "unknown_audio_media")).toHaveLength(1);
    // Legacy callers (no catalog plumbed in) get no audio gate at all —
    // membership is unknowable from the video-only segment map.
    expect(validateEditPlan(withSilence, map).filter((issue) => issue.code === "unknown_audio_media")).toEqual([]);
    expect(validateEditPlan(withSilence, map, []).filter((issue) => issue.code === "unknown_audio_media")).toEqual([]);
  });
});
