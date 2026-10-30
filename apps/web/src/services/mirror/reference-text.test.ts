import { describe, expect, it } from "vitest";
import {
  mergeTextObservations,
  normalizeTextObservations,
} from "./reference-text";

describe("reference text measurements", () => {
  it("normalizes detector boxes and rejects empty or out-of-frame results", () => {
    expect(normalizeTextObservations([
      { rawValue: "Title", boundingBox: { x: 20, y: 70, width: 60, height: 15 } },
      { rawValue: " ", boundingBox: { x: 0, y: 0, width: 10, height: 10 } },
      { rawValue: "outside", boundingBox: { x: 120, y: 0, width: 10, height: 10 } },
    ], 10, 20, 100, 100)).toEqual([{
      frame: 10,
      endFrame: 20,
      text: "Title",
      bounds: { x: 0.2, y: 0.7, width: 0.6, height: 0.15 },
    }]);
  });

  it("merges repeated sampled text while preserving distinct overlays and caveats", () => {
    const observations = [
      ...normalizeTextObservations([
        { rawValue: "SALE", boundingBox: { x: 20, y: 10, width: 30, height: 8 } },
      ], 0, 30, 100, 100),
      ...normalizeTextObservations([
        { rawValue: "sale", boundingBox: { x: 21, y: 10, width: 30, height: 8 } },
        { rawValue: "NEW", boundingBox: { x: 10, y: 75, width: 40, height: 8 } },
      ], 30, 60, 100, 100),
    ];
    const overlays = mergeTextObservations(observations, 100, 30);
    expect(overlays).toHaveLength(2);
    expect(overlays[0]).toMatchObject({
      startFrame: 0,
      endFrame: 60,
      text: "SALE",
      source: "local-ocr",
      confidence: 0.55,
      style: { alignment: "left" },
    });
    expect(overlays[0]?.note).toContain("sparsely");
  });
});
