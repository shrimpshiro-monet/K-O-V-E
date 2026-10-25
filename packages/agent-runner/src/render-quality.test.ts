import { describe, expect, it } from "vitest";
import { isCutIntervalGridConforming } from "./render-quality";

describe("render quality cadence checks", () => {
  it("accepts the alternating 13/14-frame intervals of an exact 0.45s grid at 30fps", () => {
    expect(isCutIntervalGridConforming([0.45, 0.4333333333, 0.4666666667], 0.45, 30)).toBe(true);
  });

  it("rejects short intervals even when glitch frames may look like cuts", () => {
    expect(isCutIntervalGridConforming([0.45, 0.2, 0.25], 0.45, 30)).toBe(false);
  });
});
