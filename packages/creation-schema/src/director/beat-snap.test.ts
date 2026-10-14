import { describe, expect, it } from "vitest";
import {
  BEAT_TOLERANCE_SECONDS,
  beatGridPoints,
  inferSubdivisionBeats,
  measureTimelineBeatAlignment,
  resolveTimelineBeatGrid,
  snapPlanToBeatGrid,
} from "./beat-snap";
import type { EditPlan, PlannedSegment } from "./edit-plan";
import type { SegmentMap } from "./segment-map";
import { computePlanPlacement } from "./validate";

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

/** A plan of contiguous shots from one video, starting at 0. */
function chainedPlan(durations: readonly number[], sourceOffset = 0): EditPlan {
  let cursor = 0;
  const segments = durations.map((duration, index) => {
    const start = cursor + sourceOffset;
    cursor += duration;
    return segment({
      sourceStartTime: start,
      sourceEndTime: start + duration,
      rationale: `shot ${index}`,
    });
  });
  return plan(segments);
}

function plan(segments: readonly PlannedSegment[], extra: Partial<EditPlan> = {}): EditPlan {
  return {
    segments,
    textElements: [],
    effects: [],
    transitions: [],
    audioDecisions: [],
    metadata: {
      targetDuration: segments.reduce(
        (sum, item) => sum + (item.sourceEndTime - item.sourceStartTime),
        0,
      ),
      targetPlatform: "tiktok",
      genre: "social-reel",
      pacing: "fast",
      rationale: "test",
    },
    ...extra,
  };
}

/** 120 BPM: a beat every 0.5s. `beats` are in source time. */
function analysis(videoId: string, beats: readonly number[], duration = 60): SegmentMap {
  return {
    videos: [
      {
        videoId,
        duration,
        segments: [
          {
            id: `${videoId}-s1`,
            startTime: 0,
            endTime: duration,
            description: "footage",
            sceneType: "b-roll",
            motionLevel: "medium",
            hasDialogue: false,
            visualContent: "footage",
            confidence: 0.9,
            beatTimestamps: beats,
          },
        ],
      },
    ],
  };
}

const beatsEvery = (step: number, count: number): number[] =>
  Array.from({ length: count }, (_, index) => index * step);

describe("timeline beat grid resolution", () => {
  it("maps a music bed into timeline time through its own placement", () => {
    // The bed starts 1s into the timeline and reads from 0.5s into the track.
    const bed = plan([segment()], {
      audioDecisions: [
        {
          type: "music",
          sourceVideoId: "music-1",
          sourceStartTime: 0.5,
          startTime: 1,
          duration: 8,
          rationale: "bed",
        },
      ],
    });

    const grid = resolveTimelineBeatGrid(bed, analysis("music-1", beatsEvery(0.5, 20)));

    expect(grid?.source).toBe("music-bed");
    // Source beat 0.5 -> timeline 1.0, 1.0 -> 1.5, ...
    expect(grid?.beats.slice(0, 3)).toEqual([1, 1.5, 2]);
    expect(grid?.beatPeriodSeconds).toBe(0.5);
  });

  it("excludes beats outside the bed's span", () => {
    const bed = plan([segment()], {
      audioDecisions: [
        {
          type: "music",
          sourceVideoId: "music-1",
          sourceStartTime: 0,
          startTime: 0,
          duration: 1.5,
          rationale: "bed",
        },
      ],
    });

    const grid = resolveTimelineBeatGrid(bed, analysis("music-1", beatsEvery(0.5, 20)));

    expect(grid?.beats).toEqual([0, 0.5, 1, 1.5]);
  });

  it("falls back to the footage's own beats when there is no music bed", () => {
    const shot = chainedPlan([1, 1]);
    const grid = resolveTimelineBeatGrid(shot, analysis("video-1", beatsEvery(0.5, 20)));

    expect(grid?.source).toBe("source-footage");
    // A cut at 1.0s: source beat 1.0 is heard there because the clip is placed
    // at 0 and reads from 0.
    expect(grid?.beats).toContain(1);
    expect(grid?.beatPeriodSeconds).toBe(0.5);
  });

  it("maps a clip's beats through the clip's own placement", () => {
    // Second shot reads source 10..11 but sits at timeline 1..2.
    const p = plan([
      segment({ sourceStartTime: 0, sourceEndTime: 1 }),
      segment({ sourceStartTime: 10, sourceEndTime: 11 }),
    ]);

    const grid = resolveTimelineBeatGrid(p, analysis("video-1", beatsEvery(0.5, 40)));

    // Source 10.0 lands at timeline 1.0, so mapped beats include 1.0 and 1.5.
    expect(grid?.beats).toContain(1);
    expect(grid?.beats).toContain(1.5);
  });

  it("prefers the music bed over the footage's own beats when both exist", () => {
    const p = plan([segment()], {
      audioDecisions: [
        {
          type: "music",
          sourceVideoId: "music-1",
          sourceStartTime: 0,
          startTime: 0,
          duration: 4,
          rationale: "bed",
        },
      ],
    });

    const grid = resolveTimelineBeatGrid(p, analysis("music-1", beatsEvery(0.25, 20)));

    expect(grid?.source).toBe("music-bed");
    expect(grid?.beatPeriodSeconds).toBe(0.25);
  });

  it("falls back when the bed's track was never analysed for beats", () => {
    const p = plan([segment()], {
      audioDecisions: [
        { type: "music", sourceVideoId: "unknown", startTime: 0, duration: 4, rationale: "bed" },
      ],
    });

    const grid = resolveTimelineBeatGrid(p, analysis("video-1", beatsEvery(0.5, 20)));

    expect(grid?.source).toBe("source-footage");
  });

  it("returns null when nothing has beats", () => {
    expect(resolveTimelineBeatGrid(chainedPlan([1, 1]), undefined)).toBeNull();
  });

  it("subdivides beats and applies the offset to the whole grid", () => {
    const grid = {
      beats: [0, 0.5, 1],
      source: "music-bed" as const,
      beatPeriodSeconds: 0.5,
      offsetSeconds: -0.03,
    };

    expect(beatGridPoints(grid, 1)).toEqual([-0.03, 0.47, 0.97]);
    expect(beatGridPoints(grid, 0.5)).toEqual([-0.03, 0.22, 0.47, 0.72, 0.97, 1.22]);
  });
});

describe("subdivision inference", () => {
  it("uses whole beats when the reference cuts on whole beats", () => {
    expect(inferSubdivisionBeats([1, 1, 2, 1, 4])).toBe(1);
  });

  it("uses half beats when the reference cuts on the off-beat", () => {
    expect(inferSubdivisionBeats([1, 0.5, 1.5, 2, 0.5])).toBe(0.5);
  });

  it("uses quarter beats when the reference needs them", () => {
    expect(inferSubdivisionBeats([0.25, 1.75, 2.25, 0.5])).toBe(0.25);
  });

  it("falls back when there is no reference to measure", () => {
    expect(inferSubdivisionBeats([])).toBe(1);
    expect(inferSubdivisionBeats([], 0.5)).toBe(0.5);
  });
});

describe("snapping cuts onto the beat grid", () => {
  it("moves every cut onto the grid", () => {
    // Durations that miss the beat by more than the 40ms tolerance, like a
    // model that is nearly right and audibly wrong.
    const p = chainedPlan([0.62, 1.24, 0.44, 1.3]);
    const before = measureTimelineBeatAlignment(p, resolveTimelineBeatGrid(p, analysis("video-1", beatsEvery(0.5, 40))));

    const { plan: snapped, report } = snapPlanToBeatGrid(p, analysis("video-1", beatsEvery(0.5, 40)));

    expect(before).toBe(0);
    expect(report.gridSource).toBe("source-footage");

    // Every cut sits on the lattice its own two shots allow, and a cut whose
    // shots can hold a whole beat is on a beat: only the 0.44s shot needs the
    // half-beat lattice, and it pulls only the cuts on either side of it.
    expect(report.subdivisionBeats).toBe(1);
    expect(report.refinedSubdivisionBeats).toBe(0.5);
    expect(report.refinedCuts).toBe(2);
    const grid = resolveTimelineBeatGrid(p, analysis("video-1", beatsEvery(0.5, 40)))!;
    const positions = computePlanPlacement(snapped);
    const halfBeatPoints = beatGridPoints(grid, 0.5);
    for (const position of positions.slice(1)) {
      const nearest = Math.min(...halfBeatPoints.map((point) => Math.abs(point - position)));
      expect(nearest).toBeLessThanOrEqual(BEAT_TOLERANCE_SECONDS);
    }
    // Cut 0's shots are 0.62s and 1.24s: both hold a whole beat, so it lands on
    // one. Measuring against the lattice actually chosen would call this 100%
    // on-grid whatever it did.
    expect(positions[1]!).toBeCloseTo(0.5, 6);
    expect(report.onBeatRatioAfter).toBeCloseTo(1 / 3, 6);
  });

  it("does not let rounding error accumulate across many cuts", () => {
    // 24 shots each 0.03s over a beat. Quantising each duration in turn would
    // leave the final cut 0.7s late; the cascade keeps every boundary on-grid.
    const durations = Array.from({ length: 24 }, () => 0.53);
    const p = chainedPlan(durations);

    const { plan: snapped, report } = snapPlanToBeatGrid(p, analysis("video-1", beatsEvery(0.5, 200)));

    expect(report.snappedCuts).toBe(23);
    expect(report.onBeatRatioAfter).toBe(1);
    const positions = computePlanPlacement(snapped);
    expect(positions[positions.length - 1]!).toBeCloseTo(12, 6);
    expect(report.maxAbsShiftSeconds).toBeLessThanOrEqual(0.5);
  });

  it("keeps every shot positive", () => {
    const p = chainedPlan([0.2, 0.2, 0.2, 0.2]);

    const { plan: snapped } = snapPlanToBeatGrid(p, analysis("video-1", beatsEvery(0.5, 40)));

    for (const item of snapped.segments) {
      expect(item.sourceEndTime - item.sourceStartTime).toBeGreaterThan(0);
    }
  });

  it("produces cut positions that are monotonically increasing", () => {
    const p = chainedPlan([1.7, 0.31, 2.2, 0.44, 1.1]);

    const { plan: snapped } = snapPlanToBeatGrid(p, analysis("video-1", beatsEvery(0.5, 40)));

    const positions = computePlanPlacement(snapped);
    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index]!).toBeGreaterThan(positions[index - 1]!);
    }
  });

  it("leaves the first shot's start alone", () => {
    const p = chainedPlan([1.03, 1.03], 4);
    const { plan: snapped } = snapPlanToBeatGrid(p, analysis("video-1", beatsEvery(0.5, 200)));

    expect(snapped.segments[0]!.sourceStartTime).toBe(4);
    expect(computePlanPlacement(snapped)[0]).toBe(0);
  });

  it("quantises to the unit the reference's own shot lengths imply", () => {
    const reference = [1, 0.5, 1.5, 2, 0.5];
    const p = chainedPlan([0.62, 0.62, 0.62]);

    const { report } = snapPlanToBeatGrid(p, analysis("video-1", beatsEvery(0.5, 40)), {
      referenceShotLengthsInBeats: reference,
    });

    expect(report.subdivisionBeats).toBe(0.5);
    expect(report.gridStepSeconds).toBe(0.25);
  });

  it("refines the unit rather than stretching a short shot onto a coarse grid", () => {
    const p = chainedPlan([0.53, 0.13, 0.53]);

    const { plan: snapped, report } = snapPlanToBeatGrid(p, analysis("video-1", beatsEvery(0.5, 40)));

    // One beat is 0.5s and the middle shot is 0.13s, so a whole-beat grid could
    // only express it by stretching it fourfold. The short shot keeps its own
    // share of the timeline: 0.125s is the closest the 16th lattice comes.
    const positions = computePlanPlacement(snapped);
    expect(positions[2]! - positions[1]!).toBeCloseTo(0.125, 6);
    // The refinement is reported as refinement, not as the plan's unit: the
    // reference for this plan is nothing but the one-beat default.
    expect(report.subdivisionBeats).toBe(1);
    expect(report.gridStepSeconds).toBe(0.5);
    expect(report.refinedSubdivisionBeats).toBe(0.25);
    expect(report.refinedCuts).toBe(2);
    // Both cuts here touch the short shot, so neither can be promised a beat.
    expect(report.onBeatRatioAfter).toBeCloseTo(0.5, 6);
  });

  it("does not let one short shot drag the whole plan off the beat", () => {
    // The shape that shipped: 1.06s shots against a 0.5s beat, and one 0.03s
    // sliver. Chosen globally, the unit came from the sliver, so the 1.06s cut
    // went to 1.0625 — 2.5ms from the plan and 62.5ms off the beat.
    const p = chainedPlan([1.06, 1.0, 0.03, 1.0, 1.0]);

    const { plan: snapped, report } = snapPlanToBeatGrid(p, analysis("video-1", beatsEvery(0.5, 40)));

    const positions = computePlanPlacement(snapped);
    expect(positions[1]!).toBeCloseTo(1.0, 6);
    expect(positions[4]!).toBeCloseTo(3.0, 6);
    // The sliver's own two cuts took the finer lattice; the other two did not.
    expect(report.refinedCuts).toBe(2);
    expect(report.subdivisionBeats).toBe(1);
    // Honest measurement: the one cut the sliver forced onto a 16th (2.125s) is
    // reported as off the beat, instead of all four reading 100% on-grid because
    // the pass graded itself against the lattice it had just chosen.
    expect(report.onBeatRatioAfter).toBeCloseTo(0.75, 6);
  });
});

describe("the reference's cut offset", () => {
  it("places cuts on an offset grid, and measures them there", () => {
    const p = chainedPlan([1.03, 1.03, 1.03]);

    const { plan: snapped, report } = snapPlanToBeatGrid(p, analysis("video-1", beatsEvery(0.5, 40)), {
      cutOffsetSeconds: -0.03,
    });

    expect(report.offsetSeconds).toBe(-0.03);
    expect(report.onBeatRatioAfter).toBe(1);
    const positions = computePlanPlacement(snapped);
    // Each cut sits 30ms before a beat, the way the reference does.
    expect(positions[1]!).toBeCloseTo(0.97, 6);
    expect(positions[2]!).toBeCloseTo(1.97, 6);
  });

  it("uses a tolerance tight enough that a 60ms miss is not on-beat", () => {
    const grid = resolveTimelineBeatGrid(chainedPlan([1, 1]), analysis("video-1", beatsEvery(0.5, 40)));
    const within = plan([
      segment({ sourceStartTime: 0, sourceEndTime: 0.97 }),
      segment({ sourceStartTime: 0.97, sourceEndTime: 1.9 }),
    ]);
    const beyond = plan([
      segment({ sourceStartTime: 0, sourceEndTime: 0.94 }),
      segment({ sourceStartTime: 0.94, sourceEndTime: 1.9 }),
    ]);

    expect(Math.abs(0.97 - 1)).toBeLessThanOrEqual(BEAT_TOLERANCE_SECONDS);
    expect(measureTimelineBeatAlignment(within, grid, 1)).toBe(1);
    expect(measureTimelineBeatAlignment(beyond, grid, 1)).toBe(0);
  });
});

describe("material handling", () => {
  it("trims the out point when the snapped shot is shorter", () => {
    const p = chainedPlan([1.2, 1.2]);
    const { plan: snapped, report } = snapPlanToBeatGrid(p, analysis("video-1", beatsEvery(0.5, 40)));

    expect(report.substitutedMoments).toBe(0);
    const first = snapped.segments[0]!;
    expect(first.sourceStartTime).toBe(0);
    expect(first.sourceEndTime).toBeCloseTo(1, 6);
  });

  it("extends within the analysed run when the snapped shot is longer", () => {
    const p = chainedPlan([0.8, 0.8]);
    const { plan: snapped } = snapPlanToBeatGrid(p, analysis("video-1", beatsEvery(0.5, 40)));

    expect(snapped.segments[0]!.sourceStartTime).toBe(0);
    expect(snapped.segments[0]!.sourceEndTime).toBeCloseTo(1, 6);
  });

  it("substitutes a different moment instead of stretching when no material fits", () => {
    // The analysed material is only 1.5s long, so a 2s shot cannot be grown.
    const map: SegmentMap = {
      videos: [
        {
          videoId: "video-1",
          duration: 20,
          segments: [
            {
              id: "s1",
              startTime: 0,
              endTime: 1.5,
              description: "short run",
              sceneType: "b-roll",
              motionLevel: "medium",
              hasDialogue: false,
              visualContent: "footage",
              confidence: 0.9,
              beatTimestamps: beatsEvery(0.5, 40),
            },
            {
              id: "s2",
              startTime: 6,
              endTime: 12,
              description: "long run",
              sceneType: "b-roll",
              motionLevel: "medium",
              hasDialogue: false,
              visualContent: "footage",
              confidence: 0.9,
              beatTimestamps: beatsEvery(0.5, 40),
            },
          ],
        },
      ],
    };
    const p = plan([
      segment({ sourceStartTime: 0, sourceEndTime: 1.5 }),
      segment({ sourceStartTime: 0, sourceEndTime: 2 }),
      segment({ sourceStartTime: 0, sourceEndTime: 1 }),
    ]);

    const { plan: snapped, report } = snapPlanToBeatGrid(p, map);

    expect(report.substitutedMoments).toBe(1);
    const substituted = snapped.segments[1]!;
    expect(substituted.sourceStartTime).toBe(6);
    expect(substituted.sourceEndTime).toBeCloseTo(8, 6);
  });

  it("keeps the planned span and reports it when no material exists at all", () => {
    const map: SegmentMap = {
      videos: [
        {
          videoId: "video-1",
          duration: 20,
          segments: [
            {
              id: "s1",
              startTime: 0,
              endTime: 0.5,
              description: "very short",
              sceneType: "b-roll",
              motionLevel: "medium",
              hasDialogue: false,
              visualContent: "footage",
              confidence: 0.9,
              beatTimestamps: beatsEvery(0.5, 40),
            },
          ],
        },
      ],
    };
    const p = plan([
      segment({ sourceStartTime: 0, sourceEndTime: 0.5 }),
      segment({ sourceStartTime: 0, sourceEndTime: 2 }),
      segment({ sourceStartTime: 0, sourceEndTime: 1 }),
    ]);

    const { plan: snapped, report } = snapPlanToBeatGrid(p, map);

    expect(report.issues.some((issue) => issue.code === "no_material")).toBe(true);
    // Not stretched: the planned 2s span survives.
    expect(snapped.segments[1]!.sourceEndTime - snapped.segments[1]!.sourceStartTime).toBe(2);
  });

  it("never invents material past the end of the video", () => {
    const map = analysis("video-1", beatsEvery(0.5, 40), 1.4);
    const p = plan([
      segment({ sourceStartTime: 0, sourceEndTime: 1.4 }),
      segment({ sourceStartTime: 0, sourceEndTime: 1.4 }),
    ]);

    const { plan: snapped } = snapPlanToBeatGrid(p, map);

    for (const item of snapped.segments) {
      expect(item.sourceEndTime).toBeLessThanOrEqual(1.4 + 1e-9);
    }
  });
});

describe("plans the pass must not touch", () => {
  it("leaves an anchored segment where the director put it", () => {
    const p = plan([
      segment({ sourceStartTime: 0, sourceEndTime: 1 }),
      segment({ sourceStartTime: 0, sourceEndTime: 1, targetPosition: 5 }),
    ]);

    const { plan: snapped, report } = snapPlanToBeatGrid(p, analysis("video-1", beatsEvery(0.5, 40)));

    expect(snapped.segments[1]!.targetPosition).toBe(5);
    expect(report.issues.some((issue) => issue.code === "anchored_segment")).toBe(true);
  });

  it("returns the plan unchanged when there is no beat grid", () => {
    const p = chainedPlan([1.03, 1.03]);

    const { plan: snapped, report } = snapPlanToBeatGrid(p, undefined);

    expect(snapped).toBe(p);
    expect(report.gridSource).toBeNull();
    expect(report.snappedCuts).toBe(0);
    expect(report.onBeatRatioAfter).toBeNull();
    expect(report.issues.every((issue) => issue.code === "no_beat_grid")).toBe(true);
  });

  it("treats layered segments as layers, not cuts", () => {
    const p = plan([
      segment({ sourceStartTime: 0, sourceEndTime: 2 }),
      segment({ sourceStartTime: 0, sourceEndTime: 1, trackIndex: 1 }),
      segment({ sourceStartTime: 2, sourceEndTime: 4 }),
    ]);

    const { plan: snapped, report } = snapPlanToBeatGrid(p, analysis("video-1", beatsEvery(0.5, 40)));

    // One splice on a three-segment plan: the overlay is a layer, not a cut.
    expect(report.totalCuts).toBe(1);
    expect(report.snappedCuts).toBe(1);
    expect(report.issues.some((issue) => issue.code === "anchored_segment")).toBe(true);
    // The overlay is untouched, including its track.
    expect(snapped.segments[1]!.trackIndex).toBe(1);
    expect(snapped.segments[1]!.sourceEndTime).toBe(1);
  });
});

describe("text keeps up with the cuts", () => {
  it("moves text by the cumulative shift of the cuts before it", () => {
    const p = plan(
      [segment({ sourceStartTime: 0, sourceEndTime: 1.03 }), segment({ sourceStartTime: 1.03, sourceEndTime: 2.06 })],
      { textElements: [{ content: "later", style: {} as never, startTime: 2, duration: 1, rationale: "t" }] },
    );

    const { plan: snapped } = snapPlanToBeatGrid(p, analysis("video-1", beatsEvery(0.5, 40)));

    // The cut at 1.03 moves to 1.0, so text written for 2.0 moves to 1.97.
    expect(snapped.textElements[0]!.startTime).toBeCloseTo(1.97, 6);
  });

  it("leaves text that sits before any moved cut alone", () => {
    const p = plan(
      [segment({ sourceStartTime: 0, sourceEndTime: 1.03 }), segment({ sourceStartTime: 1.03, sourceEndTime: 2.06 })],
      { textElements: [{ content: "early", style: {} as never, startTime: 0.5, duration: 0.2, rationale: "t" }] },
    );

    const { plan: snapped } = snapPlanToBeatGrid(p, analysis("video-1", beatsEvery(0.5, 40)));

    expect(snapped.textElements[0]!.startTime).toBe(0.5);
  });
});

describe("report honesty", () => {
  it("reports the fraction of cuts on the grid before and after", () => {
    const p = chainedPlan([0.62, 0.62, 0.62, 0.62]);

    const { report } = snapPlanToBeatGrid(p, analysis("video-1", beatsEvery(0.5, 40)));

    expect(report.onBeatRatioBefore).toBe(0);
    expect(report.onBeatRatioAfter).toBe(1);
    expect(report.totalCuts).toBe(3);
    expect(report.snappedCuts).toBe(3);
  });

  it("reports the shift it applied", () => {
    const p = chainedPlan([1.03, 1.03]);

    const { report } = snapPlanToBeatGrid(p, analysis("video-1", beatsEvery(0.5, 40)));

    expect(report.maxAbsShiftSeconds).toBeCloseTo(0.03, 6);
    expect(report.meanAbsShiftSeconds).toBeCloseTo(0.03, 6);
  });

  it("reports nulls rather than numbers for a plan with nothing to measure", () => {
    const { report } = snapPlanToBeatGrid(plan([segment()]), analysis("video-1", beatsEvery(0.5, 40)));

    expect(report.totalCuts).toBe(0);
    expect(report.onBeatRatioAfter).toBeNull();
  });
});
