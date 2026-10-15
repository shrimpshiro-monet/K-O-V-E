import { describe, expect, it } from "vitest";
import {
  atLeast,
  compareVersions,
  compileMirrorPlan,
  motionMoveFor,
  structuralDiff,
  type EngineReferenceReport,
  type MirrorSource,
} from "./mirror";

const FRAME = 1 / 30;

/** Three two-second shots: cuts at 0, 2 and 4 in a 6s reference. */
function threeCutReport(
  overrides: Partial<EngineReferenceReport["editPattern"]> = {},
  duration = 6,
): EngineReferenceReport {
  return {
    analysisVersion: "1.2.0",
    videoId: "ref-1",
    duration,
    summary: { pacing: "moderate", cutCount: 2, cutsPerMinute: 20 },
    styleProfile: { pacing: "moderate", cutsPerMinute: 20, medianShotDuration: 2 },
    editPattern: {
      cutStyle: "coverage-led",
      cutEvidence: [
        { time: 0, confidence: 0.9 },
        { time: 2, confidence: 0.9 },
        { time: 4, confidence: 0.9 },
      ],
      transitions: [
        { type: "hard-cut", startTime: 2, confidence: 0.82 },
        { type: "fade-to-black", startTime: 4, confidence: 0.72 },
      ],
      effects: [
        {
          type: "camera-motion-or-whip-pan-candidate",
          startTime: 1.0,
          endTime: 1.5,
          confidence: 0.5,
          evidence: { meanOpticalFlow: 6, dominantDirection: 10 },
        },
      ],
      ...overrides,
    },
  };
}

const longSource: MirrorSource[] = [{ videoId: "src-1", durationSec: 30 }];

describe("compileMirrorPlan", () => {
  it("maps every reference shot to one segment, boundary for boundary", () => {
    const report = threeCutReport();
    const plan = compileMirrorPlan(report, longSource, "trim");

    expect(plan.segments).toHaveLength(3);
    expect(plan.segments.map((s) => [s.sourceStartTime, s.sourceEndTime])).toEqual([
      [0, 2],
      [2, 4],
      [4, 6],
    ]);
    // Timeline boundaries land inside one frame of the reference cuts.
    expect(plan.segments.map((s) => s.targetPosition)).toEqual([0, 2, 4]);
    for (const [index, cut] of [0, 2, 4].entries()) {
      expect(Math.abs((plan.segments[index]!.targetPosition ?? 0) - cut)).toBeLessThanOrEqual(FRAME);
    }
    expect(plan.metadata.targetDuration).toBe(6);
    expect(plan.metadata.genre).toBe("reference-mirror");
    expect(plan.metadata.rationale).toContain("no LLM in mapping path");
  });

  it("maps junction evidence with the fixed vocabulary", () => {
    const plan = compileMirrorPlan(threeCutReport(), longSource, "trim");

    // hard-cut emits nothing; fade-to-black at 4s is the junction after shot 2.
    expect(plan.transitions).toHaveLength(1);
    expect(plan.transitions[0]).toMatchObject({
      afterSegmentIndex: 1,
      type: "dipToBlack",
      duration: 0.4,
    });
  });

  it("turns mid-shot motion into a camera move scaled by optical flow", () => {
    const plan = compileMirrorPlan(threeCutReport(), longSource, "trim");

    expect(plan.segments[0]!.cameraMoves).toHaveLength(1);
    expect(plan.segments[0]!.cameraMoves![0]).toMatchObject({
      move: "drift-right",
      intensity: 0.5, // meanOpticalFlow 6 / 12
      startTime: 1.0,
    });
  });

  it("turns boundary-adjacent motion into a whipPan transition", () => {
    const report = threeCutReport({
      effects: [
        {
          type: "camera-motion-or-whip-pan-candidate",
          startTime: 1.9,
          endTime: 2.1,
          evidence: { meanOpticalFlow: 9, dominantDirection: 0 },
        },
      ],
    });
    const plan = compileMirrorPlan(report, longSource, "trim");

    expect(plan.transitions.some((t) => t.type === "whipPan" && t.afterSegmentIndex === 0)).toBe(true);
    // The move was spent on the junction, not duplicated inside the shot.
    expect(plan.segments[0]!.cameraMoves).toBeUndefined();
  });

  it("leaves textElements empty rather than inventing captions", () => {
    const plan = compileMirrorPlan(threeCutReport(), longSource, "trim");

    expect(plan.textElements).toEqual([]);
    expect(plan.metadata.rationale).toContain("no OCR");
  });

  it("wraps a short source instead of dropping shots", () => {
    const plan = compileMirrorPlan(threeCutReport(), [{ videoId: "src-1", durationSec: 4 }], "wrap");

    expect(plan.segments).toHaveLength(3);
    expect(plan.segments[2]).toMatchObject({ sourceVideoId: "src-1", sourceStartTime: 0 });
    expect(plan.segments[2]!.rationale).toContain("looped source span");
  });

  it("trims when the source runs out", () => {
    const plan = compileMirrorPlan(threeCutReport(), [{ videoId: "src-1", durationSec: 3 }], "trim");

    expect(plan.segments).toHaveLength(2);
    expect(plan.segments[1]!.sourceEndTime).toBe(3);
  });

  it("scales the skeleton to fit the source exactly once", () => {
    const sources: MirrorSource[] = [{ videoId: "src-1", durationSec: 3 }];
    const plan = compileMirrorPlan(threeCutReport(), sources, "scale");

    expect(plan.segments.map((s) => s.sourceEndTime - s.sourceStartTime)).toEqual([1, 1, 1]);
    expect(structuralDiff(plan, threeCutReport(), { sources, fitPolicy: "scale" }).maxShotDriftSec).toBe(0);
  });

  it("spans multiple sources in order", () => {
    const plan = compileMirrorPlan(
      threeCutReport(),
      [
        { videoId: "src-1", durationSec: 2.5 },
        { videoId: "src-2", durationSec: 10 },
      ],
      "trim",
    );

    expect(plan.segments.map((s) => s.sourceVideoId)).toEqual(["src-1", "src-2", "src-2"]);
  });

  it("refuses to compile without a source", () => {
    expect(() => compileMirrorPlan(threeCutReport(), [], "trim")).toThrow(/at least one source/);
  });

  it("falls back to transition timings when there is no cut evidence", () => {
    const report = threeCutReport({
      cutEvidence: undefined,
      transitions: [{ type: "hard-cut", startTime: 3, confidence: 0.82 }],
    });
    const plan = compileMirrorPlan(report, longSource, "trim");

    expect(plan.segments).toHaveLength(2);
    expect(plan.segments.map((s) => s.sourceStartTime)).toEqual([0, 3]);
  });
});

describe("structuralDiff", () => {
  it("matches the shot count when the compiler keeps every shot", () => {
    const report = threeCutReport();
    const plan = compileMirrorPlan(report, longSource, "trim");

    const diff = structuralDiff(plan, report, { sources: longSource, fitPolicy: "trim" });
    expect(diff).toEqual({ cutCountMatch: true, maxShotDriftSec: 0 });
  });

  it("reports a mismatch when a shot is dropped (a cut at the very end)", () => {
    const report = threeCutReport({
      cutEvidence: [
        { time: 0, confidence: 0.9 },
        { time: 2, confidence: 0.9 },
        { time: 4, confidence: 0.9 },
        { time: 6, confidence: 0.9 },
      ],
    });
    const plan = compileMirrorPlan(report, longSource, "trim");

    // The 6s cut closes the last shot: there is nothing after it to show.
    expect(plan.segments).toHaveLength(3);
    const diff = structuralDiff(plan, report, { sources: longSource, fitPolicy: "trim" });
    expect(diff.cutCountMatch).toBe(false);
    expect(diff.maxShotDriftSec).toBe(0);
  });

  it("measures per-shot drift when a source truncates a shot", () => {
    const report = threeCutReport();
    const plan = compileMirrorPlan(report, [{ videoId: "src-1", durationSec: 5 }], "trim");

    // Third shot wanted 2s and got 1s.
    expect(plan.segments).toHaveLength(3);
    const diff = structuralDiff(plan, report);
    expect(diff.maxShotDriftSec).toBeCloseTo(1, 6);
  });
});

describe("motion vocabulary", () => {
  it("picks the move from flow magnitude and direction", () => {
    const at = (evidence: Record<string, unknown>, window: [number, number] = [0, 2]) =>
      motionMoveFor({
        type: "camera-motion-or-whip-pan-candidate",
        startTime: window[0],
        endTime: window[1],
        evidence,
      });

    expect(at({ meanOpticalFlow: 10, dominantDirection: 0 })).toBe("whip-shake");
    expect(at({ meanOpticalFlow: 4, dominantDirection: 0 }, [0, 0.2])).toBe("snap-zoom");
    expect(at({ meanOpticalFlow: 4, dominantDirection: 10 })).toBe("drift-right");
    expect(at({ meanOpticalFlow: 4, dominantDirection: 170 })).toBe("drift-left");
    expect(at({ meanOpticalFlow: 4, dominantDirection: 90 })).toBe("tilt-down");
    expect(at({ meanOpticalFlow: 4, dominantDirection: -90 })).toBe("tilt-up");
  });
});

describe("version gate", () => {
  it("compares numerically, not lexically", () => {
    expect(compareVersions("1.10.0", "1.2.0")).toBe(1);
    expect(atLeast("1.10.0", "1.2.0")).toBe(true);
    expect(atLeast("1.2.0", "1.2.0")).toBe(true);
    expect(atLeast("1.1.0", "1.2.0")).toBe(false);
    expect(atLeast(undefined, "1.2.0")).toBe(false);
  });
});
