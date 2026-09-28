import { describe, expect, it } from "vitest";
import type { EditPlan } from "@kove-advanced/creation-schema";
import { beatError, cutTimesFromTimeline, midWordCuts, pairwise, snap, timelineBeats } from "./metrics";

describe("eval metrics", () => {
  it("snap moves only within maxShift", () => {
    expect(snap(1.0, [1.2, 2], 0.25)).toBe(1.2);
    expect(snap(1.0, [1.3], 0.25)).toBe(1.0);
  });
  it("beatError: empty beats is Infinity, exact math otherwise", () => {
    expect(beatError([1, 2], []).mean).toBe(Infinity);
    expect(beatError([1.0, 2.1], [1, 2]).mean).toBeCloseTo(0.05);
  });
  it("midWordCuts counts only boundaries inside a word", () => {
    const plan = { segments: [{ sourceVideoId: "v", sourceStartTime: 1.5, sourceEndTime: 3 }] } as unknown as EditPlan;
    expect(midWordCuts(plan, { v: [{ start: 1, end: 2 }] })).toBe(1);
  });
  it("pairwise: position-biased judge scores 0.5, real judge scores 1", async () => {
    expect(await pairwise(async () => "A" as const, 1, 2)).toBe(0.5);
    expect(await pairwise(async (x: number, y: number) => (x > y ? "A" as const : "B" as const), 2, 1)).toBe(1);
  });
  it("cutTimesFromTimeline ignores audio tracks and dedupes", () => {
    const tracks = [
      { type: "video", clips: [{ startTime: 0 }, { startTime: 4 }, { startTime: 4.001 }] },
      { type: "audio", clips: [{ startTime: 2 }] },
    ];
    expect(cutTimesFromTimeline(tracks)).toEqual([4]);
  });
  it("timelineBeats shifts source beats by startTime - inPoint and clips to range", () => {
    const clip = { startTime: 10, inPoint: 2, duration: 8 };
    expect(timelineBeats([clip], [2, 4, 9, 11])).toEqual([10, 12, 17]);
  });
});
