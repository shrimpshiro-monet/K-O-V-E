import { describe, expect, it } from "vitest";
import { serializeReferenceProfile, type ReferenceProfile } from "@kove-advanced/core/mirror/reference-profile";
import { dtwDistance, rhythmSimilarity } from "@kove-advanced/core/rhythm/dtw";
import { fixture } from "./mirror-fixture";
describe("EditDNA format", () => {
  it("serializes a DNA-only artifact with ordered non-overlapping shots", () => {
    const dna = JSON.parse(serializeReferenceProfile(fixture)) as ReferenceProfile;
    expect(dna.version).toBe("kove.mirror.v2");
    expect(dna.aspectRatio.width).toBe(1080);
    expect(dna.shots.every((s, i) => s.startFrame < s.endFrame && (!i || s.startFrame >= dna.shots[i - 1].endFrame))).toBe(true);
    expect(() => serializeReferenceProfile({ ...fixture, shots: [fixture.shots[1], fixture.shots[0]] })).toThrow();
  });
  it("matches shape rather than average cut rate", () => {
    expect(dtwDistance([1, 2, 1], [1, 2, 1]).path).toEqual([[0, 0], [1, 1], [2, 2]]);
    expect(rhythmSimilarity([1, 2, 1], [2, 1, 1])).toBeLessThan(1);
    expect(rhythmSimilarity([], [])).toBe(1);
    expect(rhythmSimilarity([], [1])).toBe(0);
  });
});
