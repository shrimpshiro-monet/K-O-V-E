import { describe, expect, it } from "vitest";
import type { SegmentMap } from "@kove-advanced/creation-schema";
import { buildDirectorPrompt, resolveDirectorVideoId } from "./director-prompt";
import { PRE_BAKED_GENRES } from "./genres";

const segmentMap: SegmentMap = {
  videos: [
    {
      videoId: "85bb4b60-8218-455d-999a-616e9d553716",
      duration: 12,
      segments: [],
    },
  ],
};

describe("director prompt", () => {
  it("resolves model video aliases to the imported media ID", () => {
    expect(resolveDirectorVideoId(segmentMap, "video_0")).toBe(
      "85bb4b60-8218-455d-999a-616e9d553716",
    );
    expect(resolveDirectorVideoId(segmentMap, "clip-0")).toBe(
      "85bb4b60-8218-455d-999a-616e9d553716",
    );
  });

  it("does not throw when a worker result has no segments array", () => {
    const partialMap = {
      videos: [{ videoId: "video-id", duration: 12 }],
    } as unknown as SegmentMap;

    expect(() => buildDirectorPrompt(partialMap, "make a short highlight")).not.toThrow();
    expect(buildDirectorPrompt(partialMap, "make a short highlight")).toContain(
      "video_0: video-id",
    );
  });

  it("includes a measurable style target for a selected genre", () => {
    const prompt = buildDirectorPrompt(
      segmentMap,
      "make a highlight",
      PRE_BAKED_GENRES[0],
    );

    expect(prompt).toContain('"styleProfile"');
    expect(prompt).toContain('"cutsPerMinute"');
    expect(prompt).toContain('"cutStyle": "hard"');
  });

  it("passes analyzed segment signals into the director prompt", () => {
    const prompt = buildDirectorPrompt({
      videos: [{
        videoId: "video-1",
        duration: 12,
        segments: [{
          id: "segment-1",
          startTime: 2,
          endTime: 4,
          description: "high-energy action",
          sceneType: "action",
          motionLevel: "high",
          hasDialogue: false,
          visualContent: "player drives to the basket",
          confidence: 0.92,
          motionPeak: 0.88,
          audioEnergy: 0.76,
          beatTimestamps: [2.1, 2.6],
          facePresenceRatio: 0.5,
          importanceScore: 0.94,
        }],
      }],
    }, "make the strongest highlight");

    expect(prompt).toContain("## Footage graph");
    expect(prompt).toContain('"importanceScore": 0.94');
    expect(prompt).toContain('"beatTimestamps"');
    expect(prompt).toContain("2.1");
    expect(prompt).toContain("2.6");
  });
});
