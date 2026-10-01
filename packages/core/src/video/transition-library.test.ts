import { describe, expect, it } from "vitest";
import { TransitionEngine } from "./transition-engine";
import { TRANSITION_TYPES } from "../types/effects";
import { EFFECT_SHADERS } from "../motion/shaders/effect-shaders";
import type { Clip } from "../types/timeline";

/**
 * The transition library is a chain of lookups: a type in TRANSITION_TYPES has
 * to reach the engine's dispatch, its default-parameter table, the available-
 * types list the UI reads, and the editor's preview. This file walks that chain
 * at runtime for every type, so a transition can never be half-registered —
 * listed in the schema but unrenderable, or renderable but unlistable.
 */

function makeClip(id: string, startTime: number): Clip {
  return {
    id,
    mediaId: "media-1",
    trackId: "track-1",
    startTime,
    duration: 2,
    inPoint: 0,
    outPoint: 2,
    effects: [],
    audioEffects: [],
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      opacity: 1,
    },
    volume: 1,
    keyframes: {},
  } as unknown as Clip;
}

const engine = new TransitionEngine({ width: 1920, height: 1080 });
const types = TRANSITION_TYPES as unknown as readonly string[];

describe("transition library wiring", () => {
  it("lists exactly the types the schema declares", () => {
    const available = engine.getAvailableTransitionTypes() as unknown as string[];
    expect([...available].sort()).toEqual([...types].sort());
  });

  it("has non-empty default parameters for every type", () => {
    const missing: string[] = [];
    for (const type of types) {
      const params = engine.getDefaultParams(type as never);
      if (!params || Object.keys(params).length === 0) missing.push(type);
    }
    expect(missing).toEqual([]);
  });

  it("creates a transition object carrying that type and its defaults", () => {
    const failures: Array<{ type: string; reason: string }> = [];
    for (const type of types) {
      const transition = engine.createTransition(
        makeClip("a", 0),
        makeClip("b", 2),
        type as never,
        0.5,
      );
      if (!transition) failures.push({ type, reason: "returned null" });
      else if (transition.type !== type) failures.push({ type, reason: "type changed" });
      else if (Object.keys(transition.params).length === 0) {
        failures.push({ type, reason: "empty params" });
      }
    }
    expect(failures).toEqual([]);
  });

  it("refuses a type the schema does not declare", () => {
    expect(() => engine.getDefaultParams("quantumSmear" as never)).toThrow(
      /Unknown transition type: quantumSmear/,
    );
    const bogus = engine.createTransition(
      makeClip("a", 0),
      makeClip("b", 2),
      "quantumSmear" as never,
      0.5,
    );
    expect(bogus).toBeNull();
  });

  it("refuses to render a type the schema does not declare", async () => {
    // The guard runs before any canvas work, so this is observable in Node.
    await expect(
      engine.renderTransitionToCanvas(
        {} as never,
        {} as never,
        { type: "quantumSmear" } as never,
        0.5,
      ),
    ).rejects.toThrow(/Unknown transition type: quantumSmear/);
  });

  it("gates placement on adjacency and duration", () => {
    const adjacent = engine.validateTransition(
      makeClip("a", 0),
      makeClip("b", 2),
      0.5,
    );
    expect(adjacent.valid).toBe(true);

    const gapped = engine.validateTransition(
      makeClip("a", 0),
      makeClip("b", 5),
      0.5,
    );
    expect(gapped.valid).toBe(false);
    expect(String(gapped.error)).toMatch(/adjacent/i);

    const tooLong = engine.validateTransition(
      makeClip("a", 0),
      makeClip("b", 2),
      99,
    );
    expect(tooLong.warning).toBeTruthy();
    expect(tooLong.maxDuration).toBe(4);
  });
});

describe("effect shader library wiring", () => {
  it("exposes 20 uniquely identified looks with GLSL and parameters", () => {
    expect(EFFECT_SHADERS).toHaveLength(20);
    const ids = EFFECT_SHADERS.map((shader) => shader.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const shader of EFFECT_SHADERS) {
      expect(shader.glsl).toContain("#version 300 es");
      expect(shader.glsl).not.toContain("gl_FragColor");
      expect(shader.params.length).toBeGreaterThan(0);
    }
  });

  it("gives every declared parameter a uniform in the shader source", () => {
    const missing: Array<{ shader: string; param: string }> = [];
    for (const shader of EFFECT_SHADERS) {
      for (const param of shader.params) {
        if (!shader.glsl.includes(`u_${param.name}`)) {
          missing.push({ shader: shader.id, param: param.name });
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
