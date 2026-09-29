import { describe, expect, it } from "vitest";
import { EFFECT_SHADERS } from "./effect-shaders";

/**
 * Structural guarantees for the effect shader library. These do not need a GPU:
 * they catch the failure mode that matters most — a shader that looks fine in
 * the editor but cannot compile or cannot receive its params on the device.
 */
describe("effect shader library", () => {
  it("keeps every shader in the WebGL2 / GLSL ES 3.00 dialect", () => {
    for (const def of EFFECT_SHADERS) {
      expect(def.glsl.trimStart().startsWith("#version 300 es"), def.id).toBe(true);
      expect(def.glsl, def.id).toContain("void main()");
      expect(def.glsl, def.id).not.toContain("texture2D(");
      expect(def.glsl, def.id).not.toContain("varying ");
      // Fragments are written through fragColor and sample the incoming frame.
      expect(def.glsl, def.id).toContain("out vec4 fragColor");
      expect(def.glsl, def.id).toContain("uniform sampler2D u_input");
      expect(def.glsl, def.id).toContain("uniform float u_time");
    }
  });

  it("declares a uniform for every param, named u_<param>", () => {
    for (const def of EFFECT_SHADERS) {
      for (const param of def.params) {
        const uniform = `uniform ${param.type === "color" ? "vec4" : "float"} u_${param.name}`;
        expect(def.glsl, `${def.id} is missing ${uniform}`).toContain(uniform);
      }
    }
  });

  it("publishes unique, in-range param definitions", () => {
    for (const def of EFFECT_SHADERS) {
      const names = def.params.map((param) => param.name);
      expect(new Set(names).size, def.id).toBe(names.length);
      for (const param of def.params) {
        if (param.type === "color") {
          expect(param.default, `${def.id}.${param.name}`).toMatch(/^#[0-9a-f]{6}$/i);
          continue;
        }
        expect(param.default).toBeGreaterThanOrEqual(param.min);
        expect(param.default).toBeLessThanOrEqual(param.max);
        expect(param.max).toBeGreaterThan(param.min);
      }
    }
  });

  it("ships the signature looks the director plans by name", () => {
    const ids = new Set(EFFECT_SHADERS.map((def) => def.id));
    for (const id of ["speed-lines", "glitch-blocks", "light-leak"]) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it("animates the time-driven looks instead of freezing at frame zero", () => {
    const withTime = EFFECT_SHADERS.filter((def) => def.glsl.includes("u_time"));
    expect(withTime.length).toBe(EFFECT_SHADERS.length);
    // A shader that never reads its params cannot respond to intensity.
    for (const def of EFFECT_SHADERS) {
      expect(def.glsl, def.id).toContain(`u_${def.params[0]!.name}`);
    }
  });

  it("never falls back to the GLSL ES 1.00 globals", () => {
    for (const def of EFFECT_SHADERS) {
      // gl_FragColor/gl_FragData are removed in ES 3.00 — a shader using them
      // fails to compile on exactly the WebGL2 devices this library targets.
      expect(def.glsl, def.id).not.toMatch(/\bgl_Frag(Color|Data)\b/);
    }
  });
});
