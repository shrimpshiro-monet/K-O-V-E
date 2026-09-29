import { describe, expect, it } from "vitest";
import { compareStyleProfile, type StyleProfile } from "./index";

const profile: StyleProfile = {
  version: "1.0.0",
  pacing: "fast",
  cutsPerMinute: 30,
  medianShotDuration: 2,
  cutOnBeatRatio: 0.8,
  effectDensity: 4,
  transitionDensity: 12,
  textOverlayDensity: 2,
  shotTypeDistribution: { action: 0.8, talking: 0.2 },
  cutStyle: "hard",
  effectPalette: ["chromatic-aberration"],
  transitionPalette: ["crossfade"],
  detectedBpm: 120,
  dialogueRatio: 0.2,
  musicRatio: 1,
  confidence: 0.9,
};

describe("style profile comparison", () => {
  it("scores matching genre targets and reports deviations", () => {
    const matching = compareStyleProfile(profile, {
      pacing: "fast",
      cutsPerMinute: [24, 45],
      cutStyle: "hard",
      effectPalette: ["chromatic-aberration"],
      transitionPalette: ["crossfade"],
    });
    expect(matching.score).toBe(1);
    expect(matching.deviations).toHaveLength(0);

    const mismatch = compareStyleProfile(profile, {
      pacing: "slow",
      cutsPerMinute: [4, 12],
    });
    expect(mismatch.score).toBeLessThan(1);
    expect(mismatch.deviations).toContain("pacing fast does not match slow");
  });
});