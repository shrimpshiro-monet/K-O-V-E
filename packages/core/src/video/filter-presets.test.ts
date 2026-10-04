import { describe, expect, it } from "vitest";
import { FILTER_PRESETS } from "./filter-presets";

/**
 * Pins the parameter-unit conventions for filter presets. Preset effects are
 * applied verbatim as clip effects (FilterPresetsPanel → addVideoEffect),
 * and buildCSSFilter consumes:
 *   - brightness as PERCENT: brightness(1 + value / 100)
 *   - contrast as a CSS MULTIPLIER: contrast(value), 1 = identity
 *   - saturation as a CSS MULTIPLIER: saturate(value), 1 = identity
 * A 0..1-scale brightness (e.g. -0.05) renders as brightness(0.9995) — a
 * silent no-op. That bug once covered the whole preset library; these tests
 * keep it from coming back.
 */
describe("filter preset parameter units", () => {
  it("every brightness value is on the percent scale (0 or |value| >= 1)", () => {
    for (const preset of FILTER_PRESETS) {
      for (const effect of preset.effects) {
        if (effect.type !== "brightness") continue;
        const value = (effect.params as { value: number }).value;
        expect(
          value === 0 || Math.abs(value) >= 1,
          `${preset.id}: brightness ${value} looks like a 0..1-scale value; the renderer expects percent`,
        ).toBe(true);
      }
    }
  });

  it("contrast and saturation values are bounded CSS multipliers", () => {
    for (const preset of FILTER_PRESETS) {
      for (const effect of preset.effects) {
        if (effect.type !== "contrast" && effect.type !== "saturation") continue;
        const value = (effect.params as { value: number }).value;
        if (effect.type === "saturation") {
          // saturate(0) = full desaturation is legitimate (e.g. B&W presets).
          expect(value, `${preset.id}: saturation`).toBeGreaterThanOrEqual(0);
        } else {
          // contrast(0) would flatten the frame to gray — never valid.
          expect(value, `${preset.id}: contrast`).toBeGreaterThan(0);
        }
        expect(value, `${preset.id}: ${effect.type}`).toBeLessThanOrEqual(3);
      }
    }
  });

  it("color-bw-high-contrast is saturate(0) + contrast(1.5) + brightness(-5%)", () => {
    const preset = FILTER_PRESETS.find((p) => p.id === "color-bw-high-contrast");
    expect(preset).toBeDefined();
    expect(preset?.effects).toEqual([
      { type: "saturation", params: { value: 0 } },
      { type: "contrast", params: { value: 1.5 } },
      { type: "brightness", params: { value: -5 } },
    ]);
  });

  it("color-bw-crushed adds a tonal shadow/midtone crush on top of contrast", () => {
    const preset = FILTER_PRESETS.find((p) => p.id === "color-bw-crushed");
    expect(preset).toBeDefined();
    const tonal = preset?.effects.find((e) => e.type === "tonal");
    expect(tonal?.params).toEqual({
      shadows: -1,
      midtones: -1,
      highlights: -0.4,
    });
    // Full desaturation and a >1.5 contrast multiplier are the point of it.
    expect(preset?.effects).toContainEqual({
      type: "saturation",
      params: { value: 0 },
    });
    const contrast = preset?.effects.find((e) => e.type === "contrast");
    expect(
      (contrast?.params as { value: number }).value,
    ).toBeGreaterThanOrEqual(2);
  });
});
