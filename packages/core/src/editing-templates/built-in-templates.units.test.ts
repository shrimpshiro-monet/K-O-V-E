import { describe, expect, it } from "vitest";
import { BUILT_IN_EDITING_TEMPLATES } from "./built-in-templates";

/**
 * Pins the renderer's unit conventions for template recipe effects. The live
 * render path (applyEffectsCPU → buildCSSFilter) consumes:
 *   - brightness as PERCENT offset: brightness(1 + value / 100)
 *   - contrast as CSS MULTIPLIER: contrast(value), 1 = unchanged
 *   - saturation as CSS MULTIPLIER: saturate(value), 1 = unchanged
 * The template library once mixed 0..1 offsets into all three (brightness
 * no-ops, contrast(0.08) ≈ flat gray). Expression bindings (bind(...)) are
 * skipped — the binding's own range governs those.
 */

interface RecipeEffect {
  readonly type: string;
  readonly params: { readonly value?: unknown };
}

function* recipeEffects(): Generator<{ templateId: string; effect: RecipeEffect }> {
  for (const template of BUILT_IN_EDITING_TEMPLATES) {
    const effects = (
      template.recipe as { effects?: readonly RecipeEffect[] }
    ).effects;
    for (const effect of effects ?? []) {
      yield { templateId: template.id, effect };
    }
  }
}

describe("built-in template effect units", () => {
  it("brightness values are on the percent scale (0 or |value| >= 1)", () => {
    for (const { templateId, effect } of recipeEffects()) {
      if (effect.type !== "brightness") continue;
      const value = effect.params.value;
      if (typeof value !== "number") continue; // expression binding
      expect(
        value === 0 || Math.abs(value) >= 1,
        `${templateId}: brightness ${value} looks like a 0..1-scale value; renderer expects percent`,
      ).toBe(true);
    }
  });

  it("contrast values are bounded CSS multipliers, never offsets", () => {
    for (const { templateId, effect } of recipeEffects()) {
      if (effect.type !== "contrast") continue;
      const value = effect.params.value;
      if (typeof value !== "number") continue;
      // contrast(0) flattens to gray; values < 0.5 mean someone wrote an offset.
      expect(value, `${templateId}: contrast`).toBeGreaterThan(0);
      expect(value, `${templateId}: contrast`).toBeGreaterThanOrEqual(0.5);
      expect(value, `${templateId}: contrast`).toBeLessThanOrEqual(3);
    }
  });

  it("saturation values are bounded CSS multipliers, never offsets", () => {
    for (const { templateId, effect } of recipeEffects()) {
      if (effect.type !== "saturation") continue;
      const value = effect.params.value;
      if (typeof value !== "number") continue;
      expect(value, `${templateId}: saturation`).toBeGreaterThanOrEqual(0);
      expect(value, `${templateId}: saturation`).toBeLessThanOrEqual(3);
    }
  });
});
