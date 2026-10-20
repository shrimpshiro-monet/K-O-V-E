import { describe, expect, it } from "vitest";
import { createReferenceProfile } from "./reference-profile";
import { fitProfileToFootage } from "./fit-profile-to-footage";

const profile = createReferenceProfile({
  fps: { num: 30, den: 1 },
  fpsSource: "web-metadata",
  durationFrames: 600,
  aspectRatio: { width: 576, height: 640 },
  shots: [
    { startFrame: 0, endFrame: 300, captionWindows: [] },
    { startFrame: 300, endFrame: 600, captionWindows: [] },
  ],
  beatGridMs: [],
});

describe("fitProfileToFootage", () => {
  it("keeps the profile when the footage is long enough", () => {
    const result = fitProfileToFootage(profile, 30);
    expect(result.fitted).toBe(false);
    expect(result.profile).toBe(profile);
  });

  it("trims the last shot when the footage is slightly shorter", () => {
    const result = fitProfileToFootage(profile, 19);
    expect(result.fitted).toBe(true);
    expect(result.profile.durationFrames).toBe(570);
    expect(result.profile.shots).toHaveLength(2);
    expect(result.profile.shots[1].endFrame).toBe(570);
    expect(result.profile.rhythmCurve).toEqual([300, 270]);
    expect(result.profile.warnings?.join(" ")).toMatch(/longer than the footage/);
  });

  it("drops the shots that do not fit", () => {
    const result = fitProfileToFootage(profile, 8);
    expect(result.fitted).toBe(true);
    expect(result.droppedShots).toBe(1);
    expect(result.profile.shots).toHaveLength(1);
    expect(result.profile.durationFrames).toBe(240);
    expect(result.profile.rhythmCurve).toEqual([240]);
  });

  it("rejects footage that cannot hold a single frame", () => {
    expect(() => fitProfileToFootage(profile, 0)).toThrow(/no footage/i);
  });
});
