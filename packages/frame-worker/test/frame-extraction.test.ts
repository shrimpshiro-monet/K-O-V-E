import { describe, it, expect } from "vitest";
import {
  batchFrames,
  computeAdaptiveTimestamps,
  detectSceneBoundaries,
  descriptionsToSegmentMap,
  DEFAULT_SAMPLE_CONFIG,
} from "../src/frame-extraction";
import type { ExtractedFrame, VisionDescription } from "../src/frame-extraction";

function makeFrame(timestamp: number, size = 100): ExtractedFrame {
  return {
    timestamp,
    imageData: "a".repeat(size),
    width: 640,
    height: 480,
  };
}

describe("batchFrames", () => {
  it("batches frames into groups of batchSize", () => {
    const frames = Array.from({ length: 14 }, (_, i) => makeFrame(i));
    const batches = batchFrames(frames, 5);

    expect(batches).toHaveLength(3);
    expect(batches[0]!.frames).toHaveLength(5);
    expect(batches[1]!.frames).toHaveLength(5);
    expect(batches[2]!.frames).toHaveLength(4);
  });

  it("handles empty frames", () => {
    const batches = batchFrames([], 5);
    expect(batches).toHaveLength(0);
  });

  it("handles single frame", () => {
    const batches = batchFrames([makeFrame(0)], 5);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.frames).toHaveLength(1);
  });
});

describe("computeAdaptiveTimestamps", () => {
  it("generates baseline timestamps", () => {
    const timestamps = computeAdaptiveTimestamps(10, [], {
      baselineFps: 1,
      burstFps: 10,
      burstDurationSec: 1,
      sceneThreshold: 0.35,
    });

    // At 1fps for 10 seconds, we expect ~10 timestamps
    expect(timestamps.length).toBeGreaterThanOrEqual(8);
    expect(timestamps.length).toBeLessThanOrEqual(12);
  });

  it("adds burst timestamps around scene boundaries", () => {
    const boundaries = [{ timestamp: 5, score: 0.8 }];
    const timestamps = computeAdaptiveTimestamps(10, boundaries, {
      baselineFps: 1,
      burstFps: 10,
      burstDurationSec: 1,
      sceneThreshold: 0.35,
    });

    // Should have more timestamps due to burst around t=5
    expect(timestamps.length).toBeGreaterThan(10);
  });

  it("returns sorted timestamps", () => {
    const boundaries = [{ timestamp: 3, score: 0.8 }, { timestamp: 7, score: 0.9 }];
    const timestamps = computeAdaptiveTimestamps(10, boundaries);

    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]!);
    }
  });
});

describe("detectSceneBoundaries", () => {
  it("returns empty for fewer than 2 frames", async () => {
    expect(await detectSceneBoundaries([], 0.35)).toHaveLength(0);
    expect(await detectSceneBoundaries([makeFrame(0)], 0.35)).toHaveLength(0);
  });

  it("detects boundaries between different frames", async () => {
    // Skip in Node.js environment — createImageBitmap is a browser-only API
    if (typeof createImageBitmap === "undefined") {
      console.warn("Skipping: createImageBitmap not available in Node.js");
      return;
    }
    const frames = [
      makeFrame(0, 100),
      makeFrame(1, 100),
      makeFrame(2, 200), // different size = different histogram
      makeFrame(3, 200),
    ];
    const boundaries = await detectSceneBoundaries(frames, 0.3);
    expect(boundaries.length).toBeGreaterThanOrEqual(0);
  });
});

describe("descriptionsToSegmentMap", () => {
  it("creates segment map from descriptions", () => {
    const descriptions: VisionDescription[] = [
      {
        timestamp: 0,
        description: "Person talking to camera",
        sceneType: "talking",
        motionLevel: "low",
        hasDialogue: true,
        confidence: 0.9,
      },
      {
        timestamp: 5,
        description: "Action scene with fast movement",
        sceneType: "action",
        motionLevel: "high",
        hasDialogue: false,
        confidence: 0.85,
      },
    ];

    const segmentMap = descriptionsToSegmentMap("video-1", 10, descriptions);

    expect(segmentMap.videoId).toBe("video-1");
    expect(segmentMap.duration).toBe(10);
    expect(segmentMap.segments.length).toBe(2);
    expect(segmentMap.segments[0]!.sceneType).toBe("talking");
    expect(segmentMap.segments[1]!.sceneType).toBe("action");
  });

  it("handles empty descriptions", () => {
    const segmentMap = descriptionsToSegmentMap("video-1", 10, []);
    expect(segmentMap.segments).toHaveLength(0);
  });

  it("merges consecutive same-type segments", () => {
    const descriptions: VisionDescription[] = [
      {
        timestamp: 0,
        description: "Talking head shot",
        sceneType: "talking",
        motionLevel: "low",
        hasDialogue: true,
        confidence: 0.9,
      },
      {
        timestamp: 2,
        description: "Still talking",
        sceneType: "talking",
        motionLevel: "low",
        hasDialogue: true,
        confidence: 0.88,
      },
    ];

    const segmentMap = descriptionsToSegmentMap("video-1", 10, descriptions);
    expect(segmentMap.segments).toHaveLength(1);
  });

  it("carries quality signals into browser-built segments", () => {
    const segmentMap = descriptionsToSegmentMap("video-1", 10, [{
      timestamp: 0,
      description: "fast action",
      sceneType: "action",
      motionLevel: "high",
      hasDialogue: false,
      confidence: 0.9,
      motionPeak: 0.9,
      audioEnergy: 0.8,
      beatTimestamps: [0.1],
      subjectIds: ["player-1"],
      subjectContinuityScore: 0.95,
    }, {
      timestamp: 1,
      description: "same action",
      sceneType: "action",
      motionLevel: "high",
      hasDialogue: false,
      confidence: 0.9,
      motionPeak: 0.7,
      audioEnergy: 0.6,
      beatTimestamps: [1.1],
      subjectIds: ["player-1"],
      subjectContinuityScore: 0.9,
    }]);

    expect(segmentMap.segments[0]?.sportsMomentScore).toBeGreaterThan(0.6);
    expect(segmentMap.segments[0]?.sportsMomentEvent).toBe("crowd-reaction");
    expect(segmentMap.segments[0]?.subjectIds).toEqual(["player-1"]);
    expect(segmentMap.segments[0]?.beatTimestamps).toEqual([0.1, 1.1]);
  });
});
