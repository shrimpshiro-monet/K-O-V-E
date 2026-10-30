import { describe, expect, it } from "vitest";
import { audioBufferToWhisperSamples, audioChannelsToWhisperSamples } from "./whisper-audio";

function fakeAudioBuffer(channels: number[][], sampleRate: number): AudioBuffer {
  return {
    sampleRate,
    length: channels[0].length,
    duration: channels[0].length / sampleRate,
    numberOfChannels: channels.length,
    getChannelData: (index: number) => new Float32Array(channels[index]),
  } as AudioBuffer;
}

describe("audioBufferToWhisperSamples", () => {
  it("mixes channels to mono", () => {
    const samples = audioBufferToWhisperSamples(
      fakeAudioBuffer(
        [new Array(16_000).fill(1), new Array(16_000).fill(-0.5)],
        16_000,
      ),
    );
    expect(samples).toHaveLength(16_000);
    expect(samples[100]).toBeCloseTo(0.25);
  });

  it("resamples and crops the source range", () => {
    const samples = audioBufferToWhisperSamples(
      fakeAudioBuffer([new Array(48_000).fill(0.5)], 48_000),
      0.25,
      0.75,
    );
    expect(samples).toHaveLength(8_000);
    expect(samples[4_000]).toBeCloseTo(0.5);
  });

  it("mixes array-like channels with a hard source-frame cap", () => {
    const samples = audioChannelsToWhisperSamples(
      [new Float32Array([1, 0, 0, 0]), new Float32Array([0, 1, 0, 0])],
      32_000,
      2,
    );
    expect(samples).toHaveLength(1);
    expect(samples[0]).toBeCloseTo(0.5);
  });
});
