import { describe, expect, it } from "vitest";
import { BeatDetectionEngine } from "./beat-detection-engine";

function audioBuffer(length: number): AudioBuffer {
  const samples = new Float32Array(length).fill(0.5);
  return {
    length,
    duration: length / 48_000,
    sampleRate: 48_000,
    numberOfChannels: 1,
    getChannelData: () => samples,
  } as unknown as AudioBuffer;
}

describe("beat analysis for short clips", () => {
  it.each([0, 1, 100, 2047, 2048])("does not throw for %i samples", async (length) => {
    const result = await new BeatDetectionEngine().analyzeAudioBuffer(audioBuffer(length));
    expect(result.duration).toBe(length / 48_000);
    expect(result.confidence).toBe(0);
    expect(Number.isFinite(result.bpm)).toBe(true);
  });
});
