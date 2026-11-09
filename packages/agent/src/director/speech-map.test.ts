import { describe, expect, it } from "vitest";
import type { SegmentMap, TranscriptEvidence, VideoSegment } from "@kove-advanced/creation-schema";
import { buildSpeechSpotlights, formatSpeechMap } from "./speech-map";

function segment(partial: Partial<VideoSegment> & { id: string; startTime: number; endTime: number }): VideoSegment {
  return {
    description: "test segment",
    sceneType: "talking",
    motionLevel: "low",
    hasDialogue: true,
    visualContent: "n/a",
    confidence: 0.9,
    ...partial,
  } as VideoSegment;
}

function line(startTime: number, text: string, endTime = startTime + (text.split(/\s+/).length * 0.35 + 0.8)): TranscriptEvidence {
  return { startTime, endTime, text };
}

const mapWith = (segments: VideoSegment[], duration = 60): SegmentMap => ({
  videos: [{ videoId: "vid-1", duration, segments }],
});

describe("speech spotlights", () => {
  it("marks questions as hook candidates and emphatic payoffs", () => {
    const spotlights = buildSpeechSpotlights(
      mapWith([
        segment({
          id: "seg-1",
          startTime: 0,
          endTime: 20,
          transcript: [
            line(2, "you know what's crazy?"),
            line(5, "the best thing i ever did"),
          ],
        }),
      ]),
    );
    const roles = spotlights.map((spotlight) => spotlight.role);
    expect(roles).toContain("hook");
    expect(roles).toContain("payoff");
    const hook = spotlights.find((entry) => entry.role === "hook");
    expect(hook?.videoId).toBe("vid-1");
    expect(hook?.why).toBe("question addressed to the viewer");
    const payoff = spotlights.find((entry) => entry.role === "payoff");
    expect(payoff?.why).toContain('"');
  });

  it("prefers a line followed by silence as the landing", () => {
    const spotlights = buildSpeechSpotlights(
      mapWith([
        segment({
          id: "seg-1",
          startTime: 0,
          endTime: 30,
          transcript: [
            line(10, "pretty good"),
            line(12, "and that's the whole thing"),
            line(14, "ok"),
          ],
        }),
      ]),
    );
    const landing = spotlights.find((entry) => entry.role === "landing");
    // "pretty good" (2 words → ends ~11.5) is followed by a 0.5s gap; the 12s
    // line ("and that's the whole thing") ends ~14.0 with no gap either. The
    // final "ok" line at 14s: padded 13.70s–15.45s; video runs to 60 → the
    // largest landing window wins (padding shrinks the gap measurement).
    expect(landing?.startTime).toBe(13.7);
    expect(landing?.quote).toBe("ok");
    expect(landing?.why).toBe("goes quiet for 44.9s after it");
  });

  it("drops filler-heavy lines entirely", () => {
    const spotlights = buildSpeechSpotlights(
      mapWith([
        segment({
          id: "seg-1",
          startTime: 0,
          endTime: 20,
          transcript: [
            line(2, "um uh like you know i mean um uh thing"),
            line(6, "the best thing ever"),
          ],
        }),
      ]),
    );
    expect(spotlights.map((entry) => entry.quote)).not.toContain("um uh like you know i mean um uh thing");
    expect(spotlights.some((entry) => entry.role === "payoff")).toBe(true);
  });

  it("caps spotlights per video and formats with exact windows", () => {
    const transcripts = [
      line(4, "here's why this is the best"),
      line(6, "wait until you're gonna see it"),
      line(8, "watch this!"),
      line(10, "i'm gonna show you something"),
      line(12, "check this out"),
    ];
    const spotlights = buildSpeechSpotlights(
      mapWith([segment({ id: "seg-1", startTime: 0, endTime: 30, transcript: transcripts })]),
      3,
    );
    expect(spotlights.length).toBe(3);
    for (const spotlight of spotlights) {
      expect(spotlight.quote.length).toBeGreaterThan(0);
      expect(spotlight.startTime).toBeLessThan(spotlight.endTime);
    }

    const formatted = formatSpeechMap(spotlights);
    expect(formatted).toContain("## Speech map (transcript-first evidence");
    expect(formatted).toMatch(/\[vid-1 \d+\.\d\ds-\d+\.\d\ds\]/);
    expect(formatted).toContain("NOT copy for text elements");
  });

  it("returns empty for footage without transcripts instead of inventing lines", () => {
    expect(buildSpeechSpotlights(mapWith([segment({ id: "seg-1", startTime: 0, endTime: 5 })]))).toEqual([]);
    expect(buildSpeechSpotlights({ videos: [] })).toEqual([]);
    expect(formatSpeechMap([])).toBe("");
  });
});
