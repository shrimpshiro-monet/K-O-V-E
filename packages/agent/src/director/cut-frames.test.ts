import { describe, expect, it } from "vitest";
import type { EditPlan } from "@kove-advanced/creation-schema";
import type { EditingHost } from "../host";
import { MAX_CUT_POINT_FRAMES, sampleCutPointFrames } from "./cut-frames";

function makePlan(transitionCount: number): EditPlan {
  return {
    segments: Array.from({ length: transitionCount + 1 }, (_, index) => ({
      sourceVideoId: `vid-${index % 2}`,
      sourceStartTime: 10,
      sourceEndTime: 14,
      effects: [],
      rationale: `segment ${index}`,
    })),
    textElements: [],
    effects: [],
    transitions: Array.from({ length: transitionCount }, (_, index) => ({
      afterSegmentIndex: index,
      type: "crossfade",
      duration: 0.25,
      rationale: "planned cut",
    })),
    audioDecisions: [],
    metadata: {
      targetDuration: (transitionCount + 1) * 4,
      targetPlatform: "youtube",
      genre: "test",
      pacing: "medium",
      rationale: "test",
    },
  };
}

function makeHost(
  calls: Array<Record<string, unknown>>,
  fail = false,
): EditingHost {
  return {
    runJob: async (kind: string, params: Record<string, unknown>) => {
      expect(kind).toBe("extractVideoFrame");
      calls.push(params);
      if (fail) return { ok: false, error: "decode failed" };
      return { ok: true, data: { imageDataBase64: "AAAA", width: 320, height: 180 } };
    },
  } as unknown as EditingHost;
}

describe("sampleCutPointFrames", () => {
  it("returns one before/after frame per planned transition (3 transitions → 6 frames)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const result = await sampleCutPointFrames(makePlan(3), makeHost(calls));

    expect(result.extractionFailed).toBe(false);
    expect(result.plannedCutCount).toBe(3);
    expect(result.frames).toHaveLength(6);
    expect(result.frames.map((frame) => frame.role)).toEqual([
      "before",
      "after",
      "before",
      "after",
      "before",
      "after",
    ]);

    expect(calls).toHaveLength(6);
    for (const call of calls) {
      expect(typeof call.mediaId).toBe("string");
      expect(typeof call.timeSeconds).toBe("number");
      expect(call.maxWidth).toBe(320);
    }

    expect(result.frames[0]?.mediaId).toBe("vid-0");
    expect(result.frames[0]?.timeSeconds).toBeCloseTo(13.95);
    expect(result.frames[0]?.plannedCutTime).toBeCloseTo(4);
    expect(result.frames[1]?.mediaId).toBe("vid-1");
    expect(result.frames[1]?.timeSeconds).toBeCloseTo(10.05);
  });

  it("caps extraction at MAX_CUT_POINT_FRAMES (5 transitions → 8 frames)", async () => {
    const result = await sampleCutPointFrames(makePlan(5), makeHost([]));
    expect(MAX_CUT_POINT_FRAMES).toBe(8);
    expect(result.frames).toHaveLength(8);
    expect(result.plannedCutCount).toBe(5);
  });

  it("reports extraction failure without fabricating frames", async () => {
    const result = await sampleCutPointFrames(makePlan(2), makeHost([], true));
    expect(result.extractionFailed).toBe(true);
    expect(result.frames).toHaveLength(0);
  });
});
