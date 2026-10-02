import { describe, expect, it } from "vitest";
import { AudioEngine } from "./audio-engine";
import { tone } from "./loudness/loudness.test-signals";

/** Minimal AudioBuffer stand-in (the engine only reads these three members). */
const fakeBuffer = (channels: Float64Array[], sampleRate: number) =>
  ({
    numberOfChannels: channels.length,
    sampleRate,
    getChannelData: (i: number) => Float32Array.from(channels[i]!),
  }) as unknown as AudioBuffer;
const measure = (b: AudioBuffer) => AudioEngine.prototype.measureLoudness.call({}, b);

describe("AudioEngine.measureLoudness is the real BS.1770 meter (no placeholder values)", () => {
  it("-23 dBFS stereo 1 kHz reads -23 LUFS (the old RMS-0.691 stub would read -26.7)", () => {
    const t = tone(20, -23);
    const m = measure(fakeBuffer([t, t], 48_000));
    expect(m.integrated).toBeCloseTo(-23, 1);
    expect(m.truePeak).toBeCloseTo(-23, 0);
    expect(m.detail?.standard).toMatch(/BS\.1770-4/);
  });
  it("range is measured, not the hard-coded 10", () => {
    const x = Float64Array.from([...tone(20, -20), ...tone(20, -30)]);
    expect(measure(fakeBuffer([x, x], 48_000)).range).toBeCloseTo(10, 0);
    const flat = tone(20, -23);
    expect(measure(fakeBuffer([flat, flat], 48_000)).range).toBeLessThan(0.5);
  });
  it("uses ALL channels (the stub looked at channel 0 only)", () => {
    const t = tone(20, -23);
    const stereo = measure(fakeBuffer([t, t], 48_000)).integrated;
    const mono = measure(fakeBuffer([t, new Float64Array(t.length)], 48_000)).integrated;
    expect(stereo - mono).toBeCloseTo(3.01, 1);
  });
  it("silence is -Infinity, not a fabricated number", () => {
    const z = new Float64Array(48_000 * 5);
    const m = measure(fakeBuffer([z, z], 48_000));
    expect(m.integrated).toBe(Number.NEGATIVE_INFINITY);
    expect(m.truePeak).toBe(Number.NEGATIVE_INFINITY);
  });
});
