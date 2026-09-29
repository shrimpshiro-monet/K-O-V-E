import { describe, expect, it } from "vitest";
import { EFFECT_SHADERS } from "@kove-advanced/core/motion/shaders/index";
import {
  SIGNATURE_EFFECT_DEFS,
  SIGNATURE_EFFECT_NAMES,
  buildSignatureEffectParams,
  isSignatureEffectType,
  isSupportedEffectType,
  normalizeEffectType,
  resolveSignatureEffect,
  summarizeEditPlan,
} from "@kove-advanced/creation-schema";

// ---------------------------------------------------------------------------
// Signature shader effects: the plan-facing vocabulary must match the renderer
// ---------------------------------------------------------------------------

describe("signature shader effects", () => {
  const coreById = new Map(EFFECT_SHADERS.map((def) => [def.id, def]));

  it("mirrors the core effect-shader list exactly", () => {
    const coreEffectIds = [...coreById.keys()].sort();
    const mirroredIds = SIGNATURE_EFFECT_DEFS.map((def) => def.shaderId).sort();
    expect(mirroredIds).toEqual(coreEffectIds);
  });

  it("keeps every mirrored param name and default inside the core shader definition", () => {
    for (const signal of SIGNATURE_EFFECT_DEFS) {
      const core = coreById.get(signal.shaderId);
      expect(core, `missing core shader ${signal.shaderId}`).toBeDefined();
      const coreParams = new Map(core!.params.map((param) => [param.name, param]));

      for (const [name, value] of Object.entries(signal.defaults)) {
        const param = coreParams.get(name);
        expect(param, `${signal.name}.${name} is not a param of ${signal.shaderId}`).toBeDefined();
        if (typeof value === "number") {
          expect(value, `${signal.name}.${name} default below min`).toBeGreaterThanOrEqual(param!.min);
          expect(value, `${signal.name}.${name} default above max`).toBeLessThanOrEqual(param!.max);
        } else {
          // Colour params default to a hex string in core too.
          expect(typeof param!.default).toBe("string");
        }
      }
    }
  });

  it("keeps the intensity mapping inside the shader's declared ranges at both endpoints", () => {
    for (const signal of SIGNATURE_EFFECT_DEFS) {
      const core = coreById.get(signal.shaderId)!;
      const coreParams = new Map(core.params.map((param) => [param.name, param]));
      for (const intensity of [0, 0.25, 0.5, 0.75, 1]) {
        const params = signal.intensity(intensity);
        for (const [name, value] of Object.entries(params)) {
          const param = coreParams.get(name);
          expect(param, `${signal.name}.${name} is not a param of ${signal.shaderId}`).toBeDefined();
          expect(
            value,
            `${signal.name}.${name}=${value} at intensity ${intensity} is outside [${param!.min}, ${param!.max}]`,
          ).toBeGreaterThanOrEqual(param!.min);
          expect(value).toBeLessThanOrEqual(param!.max);
        }
      }
    }
  });

  it("moves the picture harder as intensity rises", () => {
    // Every definition must produce a visibly different frame at 1.0 than at
    // 0.0 — otherwise the "intensity" knob is a lie.
    for (const signal of SIGNATURE_EFFECT_DEFS) {
      const low = buildSignatureEffectParams(signal, 0, undefined);
      const high = buildSignatureEffectParams(signal, 1, undefined);
      expect(low, signal.name).not.toEqual(high);
    }
  });

  it("treats aliases as supported effect types and canonicalizes them", () => {
    expect(normalizeEffectType("VHS tape")).toBe("vhs");
    expect(normalizeEffectType("crt")).toBe("scanlines");
    expect(normalizeEffectType("comic-book")).toBe("halftone");
    expect(normalizeEffectType("thermal")).toBe("gradient-map");
    expect(normalizeEffectType("gopro")).toBe("fisheye");
    expect(normalizeEffectType("heat-haze")).toBe("wave-warp");
    expect(normalizeEffectType("tron")).toBe("edge-glow");
    expect(normalizeEffectType("8-bit")).toBe("dither");
    expect(normalizeEffectType("not-an-effect")).toBeUndefined();

    for (const name of SIGNATURE_EFFECT_NAMES) {
      expect(isSignatureEffectType(name)).toBe(true);
      expect(isSupportedEffectType(name)).toBe(true);
    }
    expect(isSignatureEffectType("cinematic")).toBe(false);
  });

  it("lets explicit params override the intensity mapping and drops unknown keys", () => {
    const vhs = resolveSignatureEffect("vhs")!;
    const params = buildSignatureEffectParams(vhs, 0.5, {
      scanlines: 0.05,
      shaderId: "something-else",
      nope: 1,
    });
    expect(params.scanlines).toBe(0.05); // explicit override wins
    expect(params.jitter).toBeCloseTo(0.3, 5); // intensity mapping fills the rest
    expect(params).not.toHaveProperty("shaderId");
    expect(params).not.toHaveProperty("nope");
  });

  it("summarizes a plan with signature effects without dropping them", () => {
    const plan = {
      segments: [],
      textElements: [],
      effects: [{ type: "vhs", params: {}, rationale: "tape look" }],
      transitions: [],
      metadata: { targetDuration: 10, targetPlatform: "tiktok", genre: "social-reel", pacing: "fast", rationale: "x" },
    };
    expect(summarizeEditPlan(plan as never)).toContain("1 effect(s)");
  });
});
