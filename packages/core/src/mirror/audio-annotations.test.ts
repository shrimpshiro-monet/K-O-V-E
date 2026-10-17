import { describe, expect, it } from "vitest";
import { frameRate } from "./timebase";
import { createReferenceProfile, serializeReferenceProfile, type ReferenceProfile } from "./reference-profile";
import { applyAudioAnnotations } from "./audio-annotations";

/** 30 fps, 10 s, two 5 s shots: [0,150) and [150,300). */
function measuredProfile(): ReferenceProfile {
  return createReferenceProfile({
    fps: frameRate(30, 1),
    fpsSource: "ffprobe",
    durationFrames: 300,
    aspectRatio: { width: 1920, height: 1080 },
    shots: [
      { startFrame: 0, endFrame: 150, captionWindows: [] },
      { startFrame: 150, endFrame: 300, captionWindows: [] },
    ],
    beatGridMs: [],
  });
}

describe("applyAudioAnnotations", () => {
  it("maps words to the shot containing their start frame", () => {
    const { profile, droppedWords } = applyAudioAnnotations(measuredProfile(), {
      words: [
        { text: "hello", start: 1.0, end: 1.4 },
        { text: "world", start: 6.0, end: 6.35 },
      ],
      beatsMs: [],
    });
    expect(droppedWords).toBe(0);
    expect(profile.shots[0]!.captionWindows).toEqual([{ startFrame: 30, endFrame: 42, text: "hello" }]);
    expect(profile.shots[1]!.captionWindows).toEqual([{ startFrame: 180, endFrame: 191, text: "world" }]);
    expect(profile.rhythmCurve).toEqual([150, 150]);
  });

  it("clips a word spanning a cut to the shot it starts in", () => {
    const { profile, droppedWords } = applyAudioAnnotations(measuredProfile(), {
      words: [{ text: "cross", start: 4.9, end: 5.2 }],
      beatsMs: [],
    });
    expect(droppedWords).toBe(0);
    // floor(4.9·30)=147, ceil(5.2·30)=156; clipped to shot 0's end at 150.
    expect(profile.shots[0]!.captionWindows).toEqual([{ startFrame: 147, endFrame: 150, text: "cross" }]);
    expect(profile.shots[1]!.captionWindows).toEqual([]);
  });

  it("drops malformed, zero-length and out-of-range words", () => {
    const { profile, droppedWords } = applyAudioAnnotations(measuredProfile(), {
      words: [
        { text: "neg", start: 2.0, end: 1.0 },
        { text: "same", start: 3.0, end: 3.0 },
        { text: "past", start: 11.0, end: 11.5 },
        { text: "nan", start: Number.NaN, end: 1.0 },
        { text: "tiny", start: 2.0, end: 2.001 },
      ],
      beatsMs: [],
    });
    // "tiny" floor(60)→60, ceil(60.03)→61 survives; the other four drop.
    expect(droppedWords).toBe(4);
    expect(profile.shots[0]!.captionWindows).toEqual([{ startFrame: 60, endFrame: 61, text: "tiny" }]);
  });

  it("deduplicates repeated whisper chunks", () => {
    const { profile } = applyAudioAnnotations(measuredProfile(), {
      words: [
        { text: "dup", start: 1.0, end: 1.4 },
        { text: "dup", start: 1.0, end: 1.4 },
      ],
      beatsMs: [],
    });
    expect(profile.shots[0]!.captionWindows).toHaveLength(1);
  });

  it("sorts, deduplicates and trims the beat grid to the reference duration", () => {
    const { profile } = applyAudioAnnotations(measuredProfile(), {
      words: [],
      beatsMs: [500, 250, 500, -10, Number.NaN, 9_999, 10_000],
    });
    // 9999ms < 10s stays; 10000ms == duration is trimmed; negatives/NaN drop.
    expect(profile.beatGridMs).toEqual([250, 500, 9999]);
  });

  it("produces a profile that still serializes (validation passes)", () => {
    const { profile } = applyAudioAnnotations(measuredProfile(), {
      words: [{ text: "validated", start: 0.1, end: 0.5 }],
      beatsMs: [400],
    });
    expect(() => serializeReferenceProfile(profile)).not.toThrow();
    expect(JSON.parse(serializeReferenceProfile(profile)).beatGridMs).toEqual([400]);
  });
});
