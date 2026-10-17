import { describe, expect, it } from "vitest";
import { frameRate, frameToSeconds, secondsToFrame } from "./timebase";
import { locateCutFrame } from "./cut-boundary";
import { createReferenceProfile, parseReferenceProfile, serializeReferenceProfile } from "./reference-profile";

describe("rational EditDNA clock", () => {
  it("round-trips exact frame indices for long NTSC and cinema durations", () => {
    for (const fps of [frameRate(30000, 1001), frameRate(24000, 1001), frameRate(25, 1)]) {
      for (const frame of [0, 1, 2, 300, 120_000, 1_000_001]) {
        expect(secondsToFrame(frameToSeconds(frame, fps), fps)).toBe(frame);
      }
    }
    expect(frameRate(60000, 2002)).toEqual({ num: 30000, den: 1001 });
  });
  it("rejects non-integer frame boundaries and malformed FPS", () => {
    expect(() => frameRate(29.97, 1)).toThrow();
    expect(() => frameRate(0, 1)).toThrow();
    expect(() => frameToSeconds(0.5, { num: 30, den: 1 })).toThrow();
  });
  it("searches integer frames and repeats deterministic cut analysis", async () => {
    const frames = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => i < 6 ? 20 : 230);
    const analyze = async () => locateCutFrame(0, 9, async (i) => frames[i]!, (a, b) => Math.abs(a-b) / 255, 0.23);
    expect(await analyze()).toBe(6);
    expect(await analyze()).toBe(await analyze());
  });
  it("never upgrades assumed legacy FPS without explicit selection", () => {
    const legacy = { version: "kove.mirror.v1", fps: 30, aspectRatio: { width: 1280, height: 720 }, shots: [{ startFrame: 0, endFrame: 30, durationSeconds: 1, captionWindows: [] }] };
    expect(() => parseReferenceProfile(legacy)).toThrow(/Explicitly select/);
    expect(parseReferenceProfile(legacy, { num: 24000, den: 1001 }).fps).toEqual({ num: 24000, den: 1001 });
  });
  it("preserves the same frame boundaries across DNA JSON export/import", () => {
    const fps = frameRate(30000, 1001);
    const dna = createReferenceProfile({ fps, fpsSource: "ffprobe", durationFrames: 3003, aspectRatio: { width: 1920, height: 1080 }, beatGridMs: [], shots: [
      { startFrame: 0, endFrame: 1001, captionWindows: [] },
      { startFrame: 1001, endFrame: 3003, captionWindows: [] },
    ] });
    const imported = parseReferenceProfile(JSON.parse(serializeReferenceProfile(dna)));
    expect(imported).toEqual(dna);
    expect(imported.rhythmCurve).toEqual([1001, 2002]);
    expect(secondsToFrame(frameToSeconds(imported.shots[1]!.startFrame, fps), fps)).toBe(1001);
    expect(() => serializeReferenceProfile({ ...dna, shots: [{ ...dna.shots[0]!, endFrame: 1000 }, dna.shots[1]!] })).toThrow();
  });
});
