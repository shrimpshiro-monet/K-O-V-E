import { describe, expect, it } from "vitest";
import {
  CLIP_EFFECT_PARAM_SPECS,
  clampClipEffectParams,
  getClipEffectParamSpec,
} from "./clip-effect-params";
import { getEffectDefinition } from "./effects";

describe("clip-effect param scale (one true table)", () => {
  it("every spec param sits inside its own range with a legal default", () => {
    for (const spec of CLIP_EFFECT_PARAM_SPECS) {
      for (const param of spec.params) {
        expect(param.min).toBeLessThan(param.max);
        expect(param.default).toBeGreaterThanOrEqual(param.min);
        expect(param.default).toBeLessThanOrEqual(param.max);
      }
    }
  });

  it("keeps contrast/saturation on the multiplier scale and brightness on percent", () => {
    const contrast = getClipEffectParamSpec("contrast");
    expect(contrast?.params[0]).toMatchObject({ min: 0, max: 2, default: 1, unit: "x" });
    const saturation = getClipEffectParamSpec("saturation");
    expect(saturation?.params[0]).toMatchObject({ min: 0, max: 2, default: 1, unit: "x" });
    const brightness = getClipEffectParamSpec("brightness");
    expect(brightness?.params[0]).toMatchObject({ min: -100, max: 100, default: 0, unit: "%" });
  });

  it("manifest EFFECT_DEFINITIONS agrees with the canonical table for the audited trio", () => {
    for (const type of ["brightness", "contrast", "saturation"] as const) {
      const spec = getClipEffectParamSpec(type);
      const definition = getEffectDefinition(type);
      expect(spec).toBeDefined();
      expect(definition).toBeDefined();
      const table = spec!.params.find((p) => p.key === "value")!;
      const declared = definition!.params.find((p) => p.key === "value")!;
      expect(declared.min).toBe(table.min);
      expect(declared.max).toBe(table.max);
      expect(declared.default).toBe(table.default);
    }
    // The old manifest claimed percent offsets for contrast/saturation
    // (min -100, default 0). That claim must never come back.
    const contrast = getEffectDefinition("contrast")!.params.find((p) => p.key === "value")!;
    expect(contrast.default).toBe(1);
    expect(contrast.min).toBe(0);
  });

  it("clamps model-scale mistakes instead of blowing out the frame", () => {
    // A model following the old percent habit sends contrast 50.
    expect(clampClipEffectParams("contrast", { value: 50 })).toEqual({ value: 2 });
    // The same mistake arrives as a string now and then — coerce, then clamp.
    expect(clampClipEffectParams("contrast", { value: "50" })).toEqual({ value: 2 });
    // Negative and saturating extremes clamp too.
    expect(clampClipEffectParams("saturation", { value: -3 })).toEqual({ value: 0 });
    expect(clampClipEffectParams("brightness", { value: 500 })).toEqual({ value: 100 });
    expect(clampClipEffectParams("temperature", { value: -250 })).toEqual({ value: -100 });
  });

  it("keeps falsy-but-legal values: contrast 0 stays 0, brightness 0 stays 0", () => {
    expect(clampClipEffectParams("contrast", { value: 0 })).toEqual({ value: 0 });
    expect(clampClipEffectParams("brightness", { value: 0 })).toEqual({ value: 0 });
  });

  it("passes through unknown effect types and non-numeric params untouched", () => {
    expect(clampClipEffectParams("shader", { shaderId: "scanlines", density: 360 })).toEqual({
      shaderId: "scanlines",
      density: 360,
    });
    expect(clampClipEffectParams("chromaKey", { keyColor: { r: 0, g: 1, b: 0 }, tolerance: 5 })).toEqual({
      keyColor: { r: 0, g: 1, b: 0 },
      tolerance: 1,
    });
  });
});
