import { describe, expect, it } from "vitest";
import { referenceBeatTargets } from "./reference-beats";

/** 120 BPM: a beat every 0.5s. */
function analysis(overrides: {
  beats?: number[];
  segments?: Array<{ startTime: number; endTime: number }>;
  styleProfile?: Record<string, unknown>;
  role?: string;
} = {}) {
  const beats = overrides.beats ?? Array.from({ length: 40 }, (_, index) => index * 0.5);
  const segments = overrides.segments ?? [
    { startTime: 0, endTime: 2 },
    { startTime: 2, endTime: 2.5 },
  ];
  return {
    videos: [
      {
        videoId: "ref-1",
        role: overrides.role ?? "reference",
        styleProfile: overrides.styleProfile ?? {
          cutOffsetMs: -30,
          cutOnBeatRatio: 0.9,
        },
        segments: segments.map((segment, index) => ({
          id: `s${index}`,
          ...segment,
          beatTimestamps: beats,
        })),
      },
    ],
  };
}

describe("reference beat targets", () => {
  it("converts the measured cut offset to seconds", () => {
    const targets = referenceBeatTargets(analysis());

    expect(targets.cutOffsetSeconds).toBeCloseTo(-0.03, 9);
  });

  it("keeps a positive offset positive", () => {
    const targets = referenceBeatTargets(
      analysis({ styleProfile: { cutOffsetMs: 45, cutOnBeatRatio: 0.8 } }),
    );

    expect(targets.cutOffsetSeconds).toBeCloseTo(0.045, 9);
  });

  it("withholds the offset when the reference does not cut on the beat", () => {
    // 20% of cuts near a beat: the median distance to a beat is not a style.
    const targets = referenceBeatTargets(
      analysis({ styleProfile: { cutOffsetMs: -120, cutOnBeatRatio: 0.2 } }),
    );

    expect(targets.cutOffsetSeconds).toBeUndefined();
  });

  it("withholds the offset when the ratio was never measured", () => {
    const targets = referenceBeatTargets(analysis({ styleProfile: { cutOffsetMs: -30 } }));

    expect(targets.cutOffsetSeconds).toBeUndefined();
  });

  it("withholds the offset when the ratio is null", () => {
    const targets = referenceBeatTargets(
      analysis({ styleProfile: { cutOffsetMs: -30, cutOnBeatRatio: null } }),
    );

    expect(targets.cutOffsetSeconds).toBeUndefined();
  });

  it("measures the beat period from the analysed beats", () => {
    const targets = referenceBeatTargets(analysis({ beats: Array.from({ length: 20 }, (_, i) => i * 0.25) }));

    expect(targets.beatPeriodSeconds).toBeCloseTo(0.25, 9);
  });

  it("expresses the reference's shot lengths in beats", () => {
    const targets = referenceBeatTargets(
      analysis({ segments: [{ startTime: 0, endTime: 2 }, { startTime: 2, endTime: 2.5 }] }),
    );

    // A 2s shot at 120 BPM is 4 beats; a 0.5s shot is 1 beat.
    expect(targets.shotLengthsInBeats).toEqual([4, 1]);
  });

  it("prefers the video marked as the reference", () => {
    const root = analysis();
    const targets = referenceBeatTargets({
      videos: [
        {
          ...root.videos[0]!,
          videoId: "source-1",
          role: "source",
          styleProfile: { cutOffsetMs: 0, cutOnBeatRatio: 1 },
        },
        root.videos[0]!,
      ],
    });

    expect(targets.cutOffsetSeconds).toBeCloseTo(-0.03, 9);
  });

  it("falls back to the first video when nothing is marked", () => {
    const root = analysis({ role: "source" });
    expect(referenceBeatTargets(root).cutOffsetSeconds).toBeCloseTo(-0.03, 9);
  });

  it("returns nothing usable for an absent or malformed analysis", () => {
    for (const input of [undefined, null, {}, { videos: [] }, { videos: "nope" }, 42, "text"]) {
      expect(referenceBeatTargets(input)).toEqual({});
    }
  });

  it("omits shot lengths when the analysis has no beats to divide by", () => {
    const targets = referenceBeatTargets(analysis({ beats: [] }));

    expect(targets.shotLengthsInBeats).toBeUndefined();
    expect(targets.beatPeriodSeconds).toBeUndefined();
  });

  it("ignores non-numeric and degenerate timestamps", () => {
    const targets = referenceBeatTargets({
      videos: [
        {
          role: "reference",
          styleProfile: { cutOffsetMs: Number.NaN, cutOnBeatRatio: 0.9 },
          segments: [
            { startTime: 0, endTime: 2, beatTimestamps: [0, 0.5, "x", null, 1] },
            { startTime: 2, endTime: 2, beatTimestamps: [] },
          ],
        },
      ],
    });

    expect(targets.cutOffsetSeconds).toBeUndefined();
    // Only the segment with positive duration counts.
    expect(targets.shotLengthsInBeats).toEqual([4]);
  });
});
