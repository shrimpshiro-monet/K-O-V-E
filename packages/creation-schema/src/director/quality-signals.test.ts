import { describe, expect, it } from "vitest";
import { RENDERED_REVIEW_METHOD, reviewRenderedDraft, scoreSportsMoment, snapTimeToBeat } from "./quality-signals";

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
    // Every review is labeled as a heuristic: pixel proxies, not semantic QA.
    expect(review.method).toBe(RENDERED_REVIEW_METHOD);
    const text = review.issues.join(" ");
    expect(text).toContain("(gradient-energy proxy)");
    expect(text).toContain("(texture-coverage proxy, not semantic subject detection)");
  });

  it("a healthy draft still carries the heuristic method label", () => {
    const review = reviewRenderedDraft([{ timestamp: 0, sharpness: 0.9, subjectVisibility: 0.9, textLegibility: 0.9 }]);
    expect(review.score).toBe(1);
    expect(review.issues).toHaveLength(0);
    expect(review.method).toBe(RENDERED_REVIEW_METHOD);
  });

  it("no observations is honest zero, not an invented score", () => {
    const review = reviewRenderedDraft([]);
    expect(review.score).toBe(0);
    expect(review.method).toBe(RENDERED_REVIEW_METHOD);
  });

  it("text legibility issues are named as contrast proxies, not OCR", () => {
    const review = reviewRenderedDraft([
      { timestamp: 0, sharpness: 0.9, subjectVisibility: 0.9, textLegibility: 0.2 },
    ]);
    expect(review.issues.join(" ")).toContain("(gradient-contrast proxy, not OCR)");
  });
});