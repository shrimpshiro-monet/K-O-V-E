import { describe, expect, it } from "vitest";
import { reviewRenderedDraft, scoreSportsMoment, snapTimeToBeat } from "./quality-signals";

describe("quality signals", () => {
  it("ranks high-energy sports moments", () => {
    const result = scoreSportsMoment({ motionPeak: 0.9, audioEnergy: 0.8, facePresenceRatio: 0.4 });
    expect(result.score).toBeGreaterThan(0.65);
    expect(result.event).toBe("crowd-reaction");
  });

  it("snaps timing to a nearby beat without moving distant cuts", () => {
    expect(snapTimeToBeat(2.08, [2, 4])).toBe(2);
    expect(snapTimeToBeat(2.5, [2, 4])).toBe(2.5);
  });

  it("flags visible render defects", () => {
    const review = reviewRenderedDraft([
      { timestamp: 0, sharpness: 0.1, subjectVisibility: 0.2, textLegibility: 0.8, hasBlackFrame: true },
      { timestamp: 1, sharpness: 0.9, subjectVisibility: 0.9, textLegibility: 0.9 },
    ]);
    expect(review.score).toBeLessThan(0.7);
    expect(review.issues).toHaveLength(3);
  });
});