import { describe, expect, it } from "vitest";
import { VideoEffectsEngine } from "../video/video-effects-engine";
import { BUILT_IN_EDITING_TEMPLATES } from "./built-in-templates";
import { resolveEditingTemplate } from "./resolver";
import type { Effect } from "../types/timeline";

/**
 * End-to-end unit check: built-in template recipe → resolveEditingTemplate →
 * the exact CSS string buildCSSFilter (the live render path) emits. Pins the
 * CONSUMER, not just the data: if any applier converted offsets a second
 * time, these ranges would blow.
 *
 * Expected CSS semantics: brightness(1 + value/100) → sane window 0.5..1.5;
 * contrast(value)/saturate(value) are multipliers → sane windows 0.5..2.5
 * and 0..3.
 */

interface CssInternals {
  buildCSSFilter(effect: Effect): string | null;
}

const CONTEXT = { clip: { id: "c1", startTime: 0, duration: 5, name: "clip" } };

function cssNumbers(css: string, fn: string): number[] {
  const out: number[] = [];
  const re = new RegExp(`${fn}\\((-?[\\d.]+)`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) out.push(Number(m[1]));
  return out;
}

describe("built-in templates through the live CSS path", () => {
  it("every template's resolved effects emit sane CSS values", () => {
    const engine = new VideoEffectsEngine({ width: 8, height: 8, useGPU: false });
    const internals = engine as unknown as CssInternals;
    let checked = 0;

    for (const template of BUILT_IN_EDITING_TEMPLATES) {
      const resolved = resolveEditingTemplate(template, CONTEXT);
      for (const effect of resolved.effects) {
        const css = internals.buildCSSFilter({
          id: effect.id,
          type: effect.type,
          params: effect.params as Record<string, unknown>,
          enabled: true,
        });
        if (!css) continue; // pixel-path or non-CSS effect — not this check

        for (const v of cssNumbers(css, "brightness")) {
          expect(v, `${template.id}: ${css}`).toBeGreaterThanOrEqual(0.5);
          expect(v, `${template.id}: ${css}`).toBeLessThanOrEqual(1.5);
          checked++;
        }
        for (const v of cssNumbers(css, "contrast")) {
          expect(v, `${template.id}: ${css}`).toBeGreaterThanOrEqual(0.5);
          expect(v, `${template.id}: ${css}`).toBeLessThanOrEqual(2.5);
          checked++;
        }
        for (const v of cssNumbers(css, "saturate")) {
          expect(v, `${template.id}: ${css}`).toBeGreaterThanOrEqual(0);
          expect(v, `${template.id}: ${css}`).toBeLessThanOrEqual(3);
          checked++;
        }
      }
    }

    // The suite must actually exercise the path — an accidental filter that
    // skips everything would pass vacuously otherwise.
    expect(checked).toBeGreaterThan(30);
  });
});
