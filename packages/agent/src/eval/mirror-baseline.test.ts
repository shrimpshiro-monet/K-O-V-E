import { describe, expect, it } from "vitest";
import type { Project } from "@kove-advanced/core/types/project";
import {
  aggregateMirrorBaseline,
  compiledCutTimesMs,
  measureBeatAlignment,
  type MirrorBaselineCaseReport,
} from "./mirror-baseline";

describe("mirror baseline beat alignment", () => {
  it("measures the distance from every cut to its nearest beat", () => {
    const alignment = measureBeatAlignment([1000, 2000, 3500], [1990, 980, 3000]);
    expect(alignment.status).toBe("measured");
    expect(alignment.cutCount).toBe(3);
    expect(alignment.beatCount).toBe(3);
    expect(alignment.meanAbsoluteErrorMs).toBeCloseTo(176.666, 2);
    expect(alignment.medianAbsoluteErrorMs).toBe(20);
    expect(alignment.maxAbsoluteErrorMs).toBe(500);
  });

  it("labels alignment unavailable without cuts or beats", () => {
    expect(measureBeatAlignment([], [1000]).reason).toMatch(/no cuts/i);
    expect(measureBeatAlignment([1000], []).reason).toMatch(/beat grid is empty/i);
  });

  it("collects compiled cut times from the shot clip ids in timeline order", () => {
    const timeline = {
      tracks: [
        {
          clips: [
            { id: "b", startTime: 2.5 },
            { id: "a", startTime: 0 },
            { id: "other", startTime: 1 },
            { id: "c", startTime: 6 },
          ],
        },
        { clips: [{ id: "a-shadow", startTime: 9 }] },
      ],
    } as unknown as Project["timeline"];
    expect(compiledCutTimesMs({ timeline }, ["a", "b", "c"])).toEqual([2500, 6000]);
  });

  it("summarizes only measured beat alignment errors", () => {
    const measured = (error: number): MirrorBaselineCaseReport => ({
      extraction: { textStatus: "measured" },
      refine: { status: "unavailable", reason: "test" },
      beatAlignment: {
        status: "measured",
        cutCount: 2,
        beatCount: 4,
        meanAbsoluteErrorMs: error,
      },
    } as unknown as MirrorBaselineCaseReport);
    const unavailable = {
      extraction: { textStatus: "unavailable" },
      refine: { status: "unavailable", reason: "test" },
      beatAlignment: { status: "unavailable", cutCount: 0, beatCount: 0, reason: "No beats." },
    } as unknown as MirrorBaselineCaseReport;
    const summary = aggregateMirrorBaseline([measured(10), measured(30), unavailable]);
    expect(summary.measuredBeatAlignmentCases).toBe(2);
    expect(summary.meanBeatAlignmentErrorMs).toBe(20);
  });
});
