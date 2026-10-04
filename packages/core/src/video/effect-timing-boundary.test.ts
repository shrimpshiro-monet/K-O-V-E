import { describe, expect, it } from "vitest";
import type { Effect } from "../types/timeline";
import type { Action } from "../types/actions";
import type { Project } from "../types/project";
import { ActionExecutor } from "../actions/action-executor";
import { VideoEffectsEngine } from "./video-effects-engine";
import { getMotionShaderEffectDefs } from "../motion/shaders";

/**
 * Pins the current (broken) behaviour reported in the Serene_Athens export
 * review: `effectSpecs.duration` / `startOffset` from director plans are
 * forwarded into `Effect.params` by plan_edit, but nothing downstream
 * consumes them — a clip effect always renders for the whole clip.
 *
 * These tests document the boundary exactly as it is today so the fix
 * (honouring duration/startOffset on the clip-effect render path) has to
 * update them deliberately.
 */

interface EngineInternals {
  resolveShaderEffect(effect: Effect): {
    readonly def: { readonly id: string; readonly category: string };
    readonly params: Record<string, number | string>;
    readonly time: number;
  } | null;
  buildCSSFilter(effect: Effect): string | null;
}

function internals(engine: VideoEffectsEngine): EngineInternals {
  return engine as unknown as EngineInternals;
}

const TIMING_PARAMS = {
  duration: 0.3,
  startOffset: 0.5,
  easing: "ease-in",
  intensity: 0.8,
};

function makeProjectWithClip(): Project {
  const clip = {
    id: "c1",
    mediaId: "m1",
    trackId: "t1",
    startTime: 0,
    duration: 3, // a 3s clip, as in the requested render check
    inPoint: 0,
    outPoint: 3,
    effects: [],
    audioEffects: [],
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      anchor: { x: 0.5, y: 0.5 },
      rotation: 0,
      opacity: 1,
    },
    volume: 1,
    keyframes: [],
  };
  return {
    id: "p1",
    name: "Test",
    createdAt: 0,
    modifiedAt: 0,
    settings: {
      width: 1920,
      height: 1080,
      frameRate: 30,
      sampleRate: 48000,
      channels: 2,
    },
    timeline: {
      duration: 3,
      tracks: [
        {
          id: "t1",
          name: "Video",
          type: "video",
          hidden: false,
          muted: false,
          clips: [clip],
        },
      ],
    },
    mediaLibrary: { items: [] },
  } as unknown as Project;
}

describe("clip-effect timing boundary (duration/startOffset are dead params)", () => {
  it("effect/add stores duration/startOffset only inside params — the Effect has no timing fields", async () => {
    const project = makeProjectWithClip();
    const executor = new ActionExecutor();
    const result = await executor.execute(
      {
        id: "act-1",
        type: "effect/add",
        params: {
          clipId: "c1",
          effectType: "shader",
          params: { shaderId: "speed-lines", ...TIMING_PARAMS },
          effectId: "fx-speed",
        },
        timestamp: Date.now(),
      } as unknown as Action,
      project,
    );
    expect(result.success).toBe(true);

    const stored = project.timeline.tracks[0].clips[0].effects[0];
    // The timeline Effect shape is { id, type, params, enabled } — there is
    // nowhere to express a 0.3s window on a 3s clip.
    expect(Object.keys(stored).sort()).toEqual(
      ["enabled", "id", "params", "type"].sort(),
    );
    expect(stored.params).toEqual({ shaderId: "speed-lines", ...TIMING_PARAMS });
  });

  it("the shader resolver drops duration/startOffset/easing/intensity — only shader params survive", () => {
    const engine = new VideoEffectsEngine({ width: 8, height: 8, useGPU: false });
    const resolved = internals(engine).resolveShaderEffect({
      id: "fx-speed",
      type: "shader",
      params: { shaderId: "speed-lines", ...TIMING_PARAMS },
      enabled: true,
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.def.id).toBe("speed-lines");
    // Exactly the shader's declared uniforms — nothing else reaches the GPU.
    expect(Object.keys(resolved?.params ?? {}).sort()).toEqual([
      "amount",
      "density",
      "speed",
    ]);
    expect("duration" in (resolved?.params ?? {})).toBe(false);
    expect("startOffset" in (resolved?.params ?? {})).toBe(false);
    expect(resolved?.time).toBe(0);
  });

  it("the speed-lines shader def declares no duration parameter", () => {
    const def = getMotionShaderEffectDefs().find((d) => d.id === "speed-lines");
    expect(def).toBeDefined();
    expect(def?.params.map((p) => p.name).sort()).toEqual([
      "amount",
      "density",
      "speed",
    ]);
  });

  it("the CSS-filter path is equally timing-blind: identical filter string with or without duration", () => {
    const engine = new VideoEffectsEngine({ width: 8, height: 8, useGPU: false });
    const withTiming: Effect = {
      id: "fx-bw",
      type: "grayscale",
      params: { amount: 1, ...TIMING_PARAMS },
      enabled: true,
    };
    const withoutTiming: Effect = {
      id: "fx-bw",
      type: "grayscale",
      params: { amount: 1 },
      enabled: true,
    };
    const a = internals(engine).buildCSSFilter(withTiming);
    const b = internals(engine).buildCSSFilter(withoutTiming);
    expect(a).not.toBeNull();
    expect(a).toBe(b); // duration changes nothing on this path either
  });

  it("applyEffects takes no playhead time — the render function cannot gate effects by time", () => {
    // Function arity is the structural proof: (image, effects) only.
    expect(VideoEffectsEngine.prototype.applyEffects.length).toBe(2);
    const privateProto = VideoEffectsEngine.prototype as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    // renderEffectsOntoFxCanvas(image, effects) — same arity, no time input.
    expect(privateProto.renderEffectsOntoFxCanvas.length).toBe(2);
  });
});
