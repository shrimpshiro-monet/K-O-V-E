import { describe, expect, it, vi } from "vitest";
import type { SegmentMap } from "@kove-advanced/creation-schema";
import { enrichSegmentMapWithTranscripts } from "./transcript-evidence";

const map: SegmentMap = {
  videos: [{
    videoId: "source-1",
    duration: 5,
    segments: [
      {
        id: "s1",
        startTime: 0,
        endTime: 2,
        description: "Opening",
        sceneType: "talking",
        motionLevel: "low",
        hasDialogue: true,
        visualContent: "speaker",
        confidence: 0.9,
      },
      {
        id: "s2",
        startTime: 2,
        endTime: 5,
        description: "Closing",
        sceneType: "talking",
        motionLevel: "low",
        hasDialogue: true,
        visualContent: "speaker",
        confidence: 0.9,
      },
    ],
  }],
};

describe("transcript evidence enrichment", () => {
  it("attaches timestamped words to their source segment and reports malformed/truncated evidence", async () => {
    const host = {
      transcribeMediaAudio: vi.fn().mockResolvedValue({
        status: "complete",
        words: [
          { startTime: 1.8, endTime: 2.2, text: "boundary" },
          { startTime: 2.4, endTime: 2.8, text: "closing" },
          { startTime: -1, endTime: 0, text: "invalid" },
        ],
      }),
    };

    const result = await enrichSegmentMapWithTranscripts(host, map, ["source-1"]);
    expect(result.segmentMap.videos[0]?.segments.map((segment) => segment.transcript)).toEqual([
      [{ startTime: 1.8, endTime: 2, text: "boundary" }],
      [
        { startTime: 2, endTime: 2.2, text: "boundary" },
        { startTime: 2.4, endTime: 2.8, text: "closing" },
      ],
    ]);
    expect(result.segmentMap.videos[0]?.transcriptStatus).toMatchObject({
      state: "complete",
      wordCount: 2,
    });
    expect(result.warnings[0]).toContain("malformed transcript word");
  });

  it("reports unsupported hosts and does not transcribe reference videos", async () => {
    const host = {};
    const result = await enrichSegmentMapWithTranscripts(host, map, []);
    expect(result.segmentMap).toEqual(map);
    expect(result.warnings).toEqual([]);

    const skipped = await enrichSegmentMapWithTranscripts(host, map, ["source-1"]);
    expect(skipped.segmentMap.videos[0]?.transcriptStatus).toEqual({
      state: "skipped",
      reason: "This host does not support local audio transcription.",
    });
    expect(skipped.warnings).toHaveLength(1);
  });

  it("caps transcript context per segment and across the full extraction", async () => {
    const manyWords = Array.from({ length: 600 }, (_, index) => ({
      startTime: index / 100,
      endTime: (index + 1) / 100,
      text: `word-${index}`,
    }));
    const host = {
      transcribeMediaAudio: vi.fn().mockResolvedValue({ status: "complete", words: manyWords }),
    };
    const videos = Array.from({ length: 5 }, (_, index) => ({
      ...map.videos[0]!,
      videoId: `source-${index}`,
      duration: 10,
      segments: [{
        ...map.videos[0]!.segments[0]!,
        id: `segment-${index}`,
        endTime: 10,
      }],
    }));
    const result = await enrichSegmentMapWithTranscripts(
      host,
      { videos },
      videos.map((video) => video.videoId),
    );

    expect(result.segmentMap.videos[0]?.segments[0]?.transcript).toHaveLength(100);
    expect(result.segmentMap.videos[0]?.transcriptStatus?.state).toBe("complete");
    expect(result.segmentMap.videos[3]?.transcriptStatus).toMatchObject({
      state: "complete",
      wordCount: 200,
    });
    expect(result.segmentMap.videos[4]?.transcriptStatus?.state).toBe("skipped");
    expect(host.transcribeMediaAudio).toHaveBeenCalledTimes(4);
    expect(result.warnings.some((warning) => warning.includes("context budget"))).toBe(true);
  });
});
