import { describe, expect, it } from "vitest";
import { _synthesizeEffectParamsForTest } from "./registry";

/**
 * Pins the intensity → param synthesis for clip effects. contrast/saturation
 * are CSS MULTIPLIERS downstream (contrast(1) = identity): the old scale-100
 * mapping emitted contrast(50)/saturate(50) for an intensity-0.5 hit, which
 * renders as a blown/flat frame. Synthesis must stay on the multiplier scale.
 */
describe("synthesizeEffectParams unit conventions", () => {
  it("maps contrast intensity to a 1..2 CSS multiplier, never percent offsets", () => {
    for (const intensity of [0, 0.25, 0.5, 0.75, 1]) {
      const params = _synthesizeEffectParamsForTest("contrast", undefined, intensity) as {
        value: number;
      };
      expect(params.value).toBeCloseTo(1 + intensity, 10);
      expect(params.value).toBeGreaterThanOrEqual(1);
      expect(params.value).toBeLessThanOrEqual(2);
    }
  });

  it("maps saturation intensity to a 1..2 CSS multiplier", () => {
    for (const intensity of [0, 0.5, 1]) {
      const params = _synthesizeEffectParamsForTest("saturation", undefined, intensity) as {
        value: number;
      };
      expect(params.value).toBeCloseTo(1 + intensity, 10);
      expect(params.value).toBeLessThanOrEqual(2);
    }
  });

  it("keeps brightness on the percent scale the renderer expects", () => {
    const params = _synthesizeEffectParamsForTest("brightness", undefined, 0.5) as {
      value: number;
    };
    // brightness(1 + value/100): value 50 → 1.5x, a visible flash, not a blowout
    expect(params.value).toBe(50);
  });

  it("passes director-supplied params through untouched", () => {
    const params = _synthesizeEffectParamsForTest(
      "contrast",
      { value: 1.5 },
      0.9,
    );
    expect(params).toEqual({ value: 1.5 });
  });
});
