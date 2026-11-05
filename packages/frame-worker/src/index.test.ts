import { describe, expect, it, vi } from "vitest";

vi.mock("./frame-extraction", async (importOriginal) => {
  const original = await importOriginal<typeof import("./frame-extraction")>();
  return {
    ...original,
    detectSceneBoundaries: vi.fn(async () => []),
    computeAdaptiveTimestamps: vi.fn(() => [1]),
    readMosaicConfig: vi.fn(() => null),
    callVisionWorker: vi.fn(async () => []),
    descriptionsToSegmentMap: vi.fn((videoId: string, duration: number) => ({
      videoId,
      duration,
      segments: [],
    })),
  };
});

import { extractSegments } from "./index";

describe("extractSegments vision input trace", () => {
  it("reports the exact selected image batches sent to the vision worker", async () => {
    const frame = {
      timestamp: 1,
      imageData: "aW1hZ2U=",
      width: 320,
      height: 180,
    };
    const inputs: unknown[] = [];

    const result = await extractSegments({
      videos: [{ videoId: "video-1", duration: 2, frames: [frame] }],
      workerUrl: "https://vision.example/analyze",
      onVisionInput: (input) => inputs.push(input),
    });

    expect(result.frameCount).toBe(1);
    expect(inputs).toEqual([{
      videoId: "video-1",
      duration: 2,
      frameCount: 1,
      batches: [{
        batchIndex: 0,
        sourceTimestamps: [1],
        imageCount: 1,
        images: [frame],
      }],
    }]);
  });
});
