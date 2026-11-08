import { describe, expect, it } from "vitest";
import { createTurnContext, recordExtractionOutcome, trustedAnalysis } from "./turn-context";
import type { SegmentMap } from "@kove-advanced/creation-schema";

function mapWithSegments(videoCount: number, segmentsPerVideo = 2): SegmentMap {
  return {
    videos: Array.from({ length: videoCount }, (_, video) => ({
      videoId: `video-${video + 1}`,
      duration: 10,
      fps: 30,
      totalFrames: 300,
      resolution: { width: 1920, height: 1080 },
      sourceFile: `video-${video + 1}.mp4`,
      segments: Array.from({ length: segmentsPerVideo }, (_, segment) => ({
        id: `video-${video + 1}-seg-${segment}`,
        startTime: segment * 5,
        endTime: segment * 5 + 5,
        sceneType: "b-roll" as const,
        motionLevel: "medium" as const,
        description: `Sampled content ${video + 1}:${segment}`,
        hasDialogue: false,
        visualContent: "test",
        confidence: 0.9,
      })),
    })),
  };
}

describe("recordExtractionOutcome (turn-scoped extraction evidence)", () => {
  it("starts as not-run and nothing trusted", () => {
    const context = createTurnContext(true);
    expect(context.extractionStatus ?? "not-run").toBe("not-run");
    expect(trustedAnalysis(context)).toBeUndefined();
  });

  it("records failed outcomes without clobbering an earlier success", () => {
    const context = createTurnContext(true);
    recordExtractionOutcome(context, {
      ok: true,
      data: { frameCount: 12, segmentMap: mapWithSegments(1) },
      images: [{ videoId: "video-1", timestamp: 1, dataUrl: "data:image/jpeg;base64,x", width: 64, height: 64 }],
    });
    recordExtractionOutcome(context, { ok: false, error: "boom" });
    expect(context.extractionStatus).toBe("failed");
    // The turn keeps the earlier frame-backed evidence: a later failed call
    // must not throw away what already worked.
    expect(trustedAnalysis(context)?.frameCount).toBe(12);
    expect(trustedAnalysis(context)?.images).toHaveLength(1);
  });

  it("rejects metadata-only results (frameCount 0): no analysis", () => {
    const context = createTurnContext(true);
    recordExtractionOutcome(context, {
      ok: true,
      data: { frameCount: 0, segmentMap: mapWithSegments(1) },
    });
    expect(context.extractionStatus).toBe("no-frames");
    expect(trustedAnalysis(context)).toBeUndefined();
  });

  it("rejects empty segment maps (no videos / no segments) even with frames", () => {
    const context = createTurnContext(true);
    recordExtractionOutcome(context, { ok: true, data: { frameCount: 10, segmentMap: { videos: [] } } });
    expect(context.extractionStatus).toBe("empty-map");

    const noSegments = createTurnContext(true);
    recordExtractionOutcome(noSegments, {
      ok: true,
      data: {
        frameCount: 10,
        segmentMap: { videos: [{ ...mapWithSegments(1).videos[0], segments: [] }] },
      },
    });
    expect(noSegments.extractionStatus).toBe("empty-map");
    expect(trustedAnalysis(noSegments)).toBeUndefined();
  });

  it("caches frame-backed results as trusted evidence", () => {
    const context = createTurnContext(true);
    const images = [
      { videoId: "video-1", timestamp: 0, dataUrl: "data:image/jpeg;base64,a", width: 64, height: 64 },
      { videoId: "video-1", timestamp: 4, dataUrl: "data:image/jpeg;base64,b", width: 64, height: 64 },
    ];
    const referenceAnalysis = { analysisVersion: "1.1.0", videos: [] };
    recordExtractionOutcome(context, {
      ok: true,
      data: { frameCount: 17, segmentMap: mapWithSegments(2), referenceAnalysis },
      images,
    });
    expect(context.extractionStatus).toBe("succeeded");
    const analysis = trustedAnalysis(context);
    expect(analysis?.frameCount).toBe(17);
    expect(analysis?.segmentMap.videos).toHaveLength(2);
    expect(analysis?.referenceAnalysis).toEqual(referenceAnalysis);
    expect(analysis?.images).toEqual(images);
  });

  it("never caches evidence when the gate is off (contextless callers unaffected)", () => {
    const context = createTurnContext(false);
    recordExtractionOutcome(context, { ok: true, data: { frameCount: 6, segmentMap: mapWithSegments(1) } });
    expect(context.extractionStatus).toBe("succeeded");
    expect(trustedAnalysis(context)).toBeDefined();
  });
});
