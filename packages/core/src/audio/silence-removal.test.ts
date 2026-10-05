import { describe, expect, it } from "vitest";
import type { Clip } from "../types/timeline";
import type { Project } from "../types/project";
import {
  DEFAULT_CUT_OPTIONS,
  FILLER_LEXICON,
  clipTimingLimitation,
  computeCutRanges,
  computeSilenceRanges,
  detectFillerWords,
  findMulticamGroupForClip,
  planClipCuts,
  segmentSpeechFromProbabilities,
  type ProposedCut,
  type TranscriptWord,
} from "./silence-removal";

describe("segmentSpeechFromProbabilities (VAD frames → speech ranges)", () => {
  // 32ms frames, as produced by the Silero VAD wrapper (512 samples @ 16kHz).
  const WINDOW_MS = 32;

  it("segments a simple speech run", () => {
    // 10 frames: silence, 6 speech frames, silence…
    const probs = [0.1, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.1, 0.1, 0.1];
    const segments = segmentSpeechFromProbabilities(probs, WINDOW_MS);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.start).toBeCloseTo(1 * 0.032, 5);
    expect(segments[0]!.end).toBeCloseTo(7 * 0.032, 5);
  });

  it("merges runs separated by gaps under mergeGapMs", () => {
    // speech, 1-frame gap (32ms < 80ms default), speech
    const probs = [0.9, 0.9, 0.1, 0.9, 0.9];
    const segments = segmentSpeechFromProbabilities(probs, WINDOW_MS);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.end).toBeCloseTo(5 * 0.032, 5);
  });

  it("splits runs separated by gaps over mergeGapMs", () => {
    // 4-frame speech run, 3-frame gap (96ms ≥ 80ms), 4-frame speech run
    const probs = [
      0.9, 0.9, 0.9, 0.9,
      0.1, 0.1, 0.1,
      0.9, 0.9, 0.9, 0.9,
    ];
    const segments = segmentSpeechFromProbabilities(probs, WINDOW_MS);
    expect(segments).toHaveLength(2);
  });

  it("drops noise blips shorter than minSpeechMs", () => {
    // 2 speech frames = 64ms < 120ms minimum
    const probs = [0.1, 0.9, 0.9, 0.1, 0.1, 0.1];
    expect(segmentSpeechFromProbabilities(probs, WINDOW_MS)).toEqual([]);
  });

  it("handles empty and degenerate input", () => {
    expect(segmentSpeechFromProbabilities([], WINDOW_MS)).toEqual([]);
    expect(segmentSpeechFromProbabilities([0.9], 0)).toEqual([]);
  });
});

describe("computeSilenceRanges", () => {
  it("finds interior and edge silences at or above the minimum", () => {
    const speech = [
      { start: 1, end: 2 },
      { start: 4, end: 5 },
    ];
    const silences = computeSilenceRanges(speech, 7, 0.6);
    expect(silences).toEqual([
      { start: 0, end: 1 }, // lead-in, 1s
      { start: 2, end: 4 }, // interior, 2s
      { start: 5, end: 7 }, // tail, 2s
    ]);
  });

  it("ignores silences below the minimum", () => {
    const speech = [{ start: 0.2, end: 5 }];
    expect(computeSilenceRanges(speech, 5.4, 0.6)).toEqual([]);
  });
});

describe("filler detection", () => {
  const words: TranscriptWord[] = [
    { text: "So", start: 0.1, end: 0.3 },
    { text: "um", start: 0.4, end: 0.7 },
    { text: "we", start: 0.8, end: 0.9 },
    { text: "UM,", start: 1.0, end: 1.3 },
    { text: "like", start: 1.4, end: 1.6 },
  ];

  it("matches case-insensitively with punctuation, and excludes discourse markers", () => {
    const fillers = detectFillerWords(words);
    expect(fillers.map((w) => w.text)).toEqual(["um", "UM,"]);
  });

  it("keeps the lexicon limited to vocalized pauses", () => {
    expect(FILLER_LEXICON).toContain("um");
    expect(FILLER_LEXICON).not.toContain("like");
    expect(FILLER_LEXICON).not.toContain("well");
  });
});

describe("computeCutRanges", () => {
  const speech = [
    { start: 0, end: 1 },
    { start: 3, end: 4 }, // 2s gap → cuttable
  ];

  it("proposes padded silence cuts and drops slivers", () => {
    const cuts = computeCutRanges({
      speechSegments: speech,
      totalDurationSec: 4,
      options: { removeFillers: false },
    });
    const silenceCut = cuts.find((cut) => cut.reason === "silence");
    expect(silenceCut).toBeDefined();
    // gap [1,3] minus 0.12 padding each side → [1.12, 2.88]
    expect(silenceCut!.start).toBeCloseTo(1.12, 5);
    expect(silenceCut!.end).toBeCloseTo(2.88, 5);
  });

  it("adds filler cuts and merges overlaps", () => {
    const cuts = computeCutRanges({
      speechSegments: [{ start: 0, end: 1 }, { start: 2.2, end: 4 }],
      totalDurationSec: 4,
      words: [{ text: "uh", start: 1.2, end: 1.6 }], // inside the 1.2s gap…
      options: { maxSilenceSec: 1.0 },
    });
    // gap [1, 2.2] ≥ 1.0 → silence cut [1.12, 2.08]; filler [1.2,1.6] merges in
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.reason).toBe("silence");
    expect(cuts[0]!.start).toBeCloseTo(1.12, 5);
  });

  it("skips filler cuts shorter than minCutSec", () => {
    const cuts = computeCutRanges({
      speechSegments: [{ start: 0, end: 5 }],
      totalDurationSec: 5,
      words: [{ text: "um", start: 2, end: 2.1 }], // 0.1s < 0.15
    });
    expect(cuts).toEqual([]);
  });

  it("never cuts padding below the minimum", () => {
    // A 0.7s gap pads down to 0.46s — cuttable; a 0.8s min raises the bar.
    const cuts = computeCutRanges({
      speechSegments: [{ start: 0, end: 1 }, { start: 1.7, end: 3 }],
      totalDurationSec: 3,
      options: { removeFillers: false, maxSilenceSec: 0.6 },
    });
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.end - cuts[0]!.start).toBeGreaterThanOrEqual(
      DEFAULT_CUT_OPTIONS.minCutSec,
    );
  });
});

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: "clip-1",
    mediaId: "media-1",
    trackId: "track-1",
    startTime: 10,
    duration: 20,
    inPoint: 5,
    outPoint: 25,
    effects: [],
    audioEffects: [],
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      anchor: { x: 0.5, y: 0.5 },
      rotation: 0,
      opacity: 1,
    },
    volume: 1,
    keyframes: [],
    ...overrides,
  } as unknown as Clip;
}

function cut(id: string, start: number, end: number): ProposedCut {
  return { id, start, end, reason: "silence", label: `${(end - start).toFixed(1)}s silence` };
}

describe("planClipCuts (source seconds → timeline ops)", () => {
  it("maps through clip speed: timelineTime = startTime + t/speed", () => {
    const clip = makeClip({ speed: 2 }); // 20s timeline covers 40 source s
    const plan = planClipCuts(clip, [cut("a", 4, 8)]);
    expect(plan.supported).toBe(true);
    expect(plan.ops).toHaveLength(1);
    expect(plan.ops[0]!.timelineStart).toBeCloseTo(10 + 4 / 2, 6);
    expect(plan.ops[0]!.timelineEnd).toBeCloseTo(10 + 8 / 2, 6);
    // Interior cut: split at end, then at start; delete the isolated piece.
    expect(plan.ops[0]!.splits).toEqual([10 + 8 / 2, 10 + 4 / 2]);
    expect(plan.ops[0]!.deleteResolution).toBe("by-bounds");
  });

  it("orders multiple cuts right-to-left so ripple deletes stay valid", () => {
    const clip = makeClip();
    const plan = planClipCuts(clip, [cut("left", 1, 2), cut("right", 15, 16)]);
    expect(plan.ops.map((op) => op.cut.id)).toEqual(["right", "left"]);
  });

  it("skips the end split when a cut runs to the clip edge", () => {
    const clip = makeClip(); // region 20 source seconds
    const plan = planClipCuts(clip, [cut("tail", 18, 20)]);
    expect(plan.ops[0]!.splits).toEqual([10 + 18]);
    expect(plan.ops[0]!.deleteResolution).toBe("by-bounds");
  });

  it("needs only the end split when a cut starts at the clip head", () => {
    const clip = makeClip();
    const plan = planClipCuts(clip, [cut("head", 0, 2)]);
    expect(plan.ops[0]!.splits).toEqual([10 + 2]);
    expect(plan.ops[0]!.deleteResolution).toBe("by-bounds");
  });

  it("handles a full-clip cut with no splits", () => {
    const clip = makeClip();
    const plan = planClipCuts(clip, [cut("all", 0, 20)]);
    expect(plan.ops[0]!.splits).toEqual([]);
    expect(plan.ops[0]!.deleteResolution).toBe("by-bounds");
  });

  it("respects the selection set", () => {
    const clip = makeClip();
    const cuts = [cut("keep", 1, 2), cut("drop", 5, 6)];
    const plan = planClipCuts(clip, cuts, new Set(["keep"]));
    expect(plan.ops.map((op) => op.cut.id)).toEqual(["keep"]);
  });

  it("refuses reversed / speed-keyframed / freeze-frame clips instead of desyncing", () => {
    for (const bad of [
      makeClip({ reversed: true }),
      makeClip({ speedKeyframes: [{ time: 1, speed: 2 } as never] }),
      makeClip({ freezeFrames: [{ time: 2, duration: 1 } as never] }),
    ]) {
      const plan = planClipCuts(bad, [cut("x", 1, 2)]);
      expect(plan.supported).toBe(false);
      expect(plan.ops).toEqual([]);
      expect(plan.warnings[0]!.code).toBe("unsupported-clip");
    }
    expect(clipTimingLimitation(makeClip())).toBeNull();
  });

  it("drops out-of-range cuts with a warning", () => {
    const clip = makeClip(); // region = duration * speed = 20
    const plan = planClipCuts(clip, [cut("bad", 19, 30)]);
    expect(plan.ops).toEqual([]);
    expect(plan.warnings.some((w) => w.code === "cut-out-of-range")).toBe(true);
  });
});

describe("findMulticamGroupForClip", () => {
  const baseProject = {
    id: "p",
    multicamGroups: [
      {
        id: "group-1",
        name: "Angles",
        angles: [{ id: "a1", name: "A", clipId: "clip-mc", trackId: "track-mc", offset: 0, color: "#fff", isActive: true }],
        activeAngleId: "a1",
        syncPoint: 0,
        duration: 30,
        createdAt: 0,
        outputTrackId: "track-out",
      },
    ],
  } as unknown as Project;

  it("matches by output track, angle clip id, or angle track id", () => {
    expect(findMulticamGroupForClip(baseProject, makeClip({ trackId: "track-out" }))?.id).toBe("group-1");
    expect(findMulticamGroupForClip(baseProject, makeClip({ id: "clip-mc" }))?.id).toBe("group-1");
    expect(findMulticamGroupForClip(baseProject, makeClip({ trackId: "track-mc" }))?.id).toBe("group-1");
    expect(findMulticamGroupForClip(baseProject, makeClip())).toBeNull();
  });
});
