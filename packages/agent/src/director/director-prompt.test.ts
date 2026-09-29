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

    expect(prompt).toContain("## Footage Analysis");
    expect(prompt).toContain("importance=0.94");
    expect(prompt).toContain("beats=[2.1,2.6]");
    expect(prompt).toContain("segment-1");
    expect(prompt).toContain("high-energy action");
  });

  it("lists audio/video media library entries with their exact ids", () => {
    const prompt = buildDirectorPrompt(segmentMap, "make a montage", undefined, undefined, [
      { id: "media_mus1", name: "bed.mp3", type: "audio", duration: 30 },
      { id: "media_vid1", name: "footage.mp4", type: "video", duration: 8 },
      { id: "media_img1", name: "cover.png", type: "image", duration: 0 },
    ]);

    expect(prompt).toContain("## Available media library");
    expect(prompt).toContain('- media_0: media_mus1 — "bed.mp3" (audio, 30.0s)');
    expect(prompt).toContain('- media_1: media_vid1 — "footage.mp4" (video, 8.0s)');
    // Images cannot carry music/sfx — keep them out of the id list.
    expect(prompt).not.toContain("cover.png");
    expect(prompt).toContain("use EXACTLY one of the media ids below");
    expect(prompt).toContain(
      '"sourceVideoId": "<media id from the Available media library block>"',
    );
  });

  it("omits the media library block when no library is available", () => {
    expect(buildDirectorPrompt(segmentMap, "make a montage")).not.toContain(
      "## Available media library",
    );
    expect(
      buildDirectorPrompt(segmentMap, "make a montage", undefined, undefined, []),
    ).not.toContain("## Available media library");
  });
});
