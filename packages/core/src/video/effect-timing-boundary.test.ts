import { describe, expect, it } from "vitest";
import type { Effect } from "../types/timeline";
import type { Action } from "../types/actions";
import type { Project } from "../types/project";
import { ActionExecutor } from "../actions/action-executor";
import {
  VideoEffectsEngine,
  isEffectActiveAtTime,
} from "./video-effects-engine";
import { getMotionShaderEffectDefs } from "../motion/shaders";

/**
 * Pins the effect-timing contract on the clip-effect path.
 *
 * History: `effectSpecs.duration` / `startOffset` from director plans were
 * forwarded into `Effect.params` by plan_edit but ignored by the renderer —
 * a "0.3s speed-lines hit" rendered for the whole clip (see the Serene_Athens
 * export review). The render path now honors them: applyEffects accepts the
 * clip-local playhead time and isEffectActiveAtTime gates each effect.
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
    duration: 3, // a 3s clip, as in the original repro
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

function effect(params: Record<string, unknown>): Effect {
  return { id: "fx", type: "shader", params, enabled: true };
}

describe("effect timing: storage and renderer plumbing", () => {
  it("effect/add stores duration/startOffset only inside params — the Effect still has no timing fields", async () => {
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
    expect(Object.keys(stored).sort()).toEqual(
      ["enabled", "id", "params", "type"].sort(),
    );
    expect(stored.params).toEqual({ shaderId: "speed-lines", ...TIMING_PARAMS });
  });

  it("applyEffects accepts the clip-local playhead time (time-gating signature)", () => {
    // (image, effects, timeSec?) — timeSec is optional, so legacy callers
    // without a clock keep the always-active behavior.
    expect(VideoEffectsEngine.prototype.applyEffects.length).toBe(3);
    const privateProto = VideoEffectsEngine.prototype as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    expect(privateProto.renderEffectsOntoFxCanvas.length).toBe(3);
  });

  it("the shader resolver still drops timing from GPU params — gating happens upstream", () => {
    const engine = new VideoEffectsEngine({ width: 8, height: 8, useGPU: false });
    const resolved = internals(engine).resolveShaderEffect(
      effect({ shaderId: "speed-lines", ...TIMING_PARAMS }),
    );
    expect(resolved).not.toBeNull();
    expect(resolved?.def.id).toBe("speed-lines");
    expect(Object.keys(resolved?.params ?? {}).sort()).toEqual([
      "amount",
      "density",
      "speed",
    ]);
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

  it("the CSS filter string itself is timing-blind — the gate decides application", () => {
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
    expect(a).toBe(b);
  });
});

describe("isEffectActiveAtTime — the hit window", () => {
  const hit = effect({ shaderId: "speed-lines", startOffset: 0.5, duration: 0.3 });
  const untimed = effect({ shaderId: "speed-lines", amount: 0.6 });

  it("a 0.3s hit starting at 0.5s is only active in [0.5, 0.8)", () => {
    expect(isEffectActiveAtTime(hit, 0.49)).toBe(false);
    expect(isEffectActiveAtTime(hit, 0.5)).toBe(true);
    expect(isEffectActiveAtTime(hit, 0.65)).toBe(true);
    expect(isEffectActiveAtTime(hit, 0.79)).toBe(true);
    expect(isEffectActiveAtTime(hit, 0.8)).toBe(false);
    expect(isEffectActiveAtTime(hit, 4.5)).toBe(false);
  });

  it("a hit at clip start (startOffset 0) closes at its duration", () => {
    const atStart = effect({ shaderId: "speed-lines", duration: 0.3 });
    expect(isEffectActiveAtTime(atStart, 0)).toBe(true);
    expect(isEffectActiveAtTime(atStart, 0.29)).toBe(true);
    expect(isEffectActiveAtTime(atStart, 0.31)).toBe(false);
  });

  it("untimed effects stay active for the whole clip and when no clock exists", () => {
    expect(isEffectActiveAtTime(untimed, 0)).toBe(true);
    expect(isEffectActiveAtTime(untimed, 4.5)).toBe(true);
    expect(isEffectActiveAtTime(untimed, undefined)).toBe(true);
    expect(isEffectActiveAtTime(hit, undefined)).toBe(true); // legacy callers
  });

  it("fails open on malformed windows — bad timing never erases an effect", () => {
    expect(isEffectActiveAtTime(effect({ duration: 0 }), 1)).toBe(true);
    expect(isEffectActiveAtTime(effect({ duration: -2 }), 1)).toBe(true);
    expect(
      isEffectActiveAtTime(effect({ startOffset: Number.NaN, duration: 0.3 }), 0.1),
    ).toBe(true);
  });

  it("negative startOffset clamps to 0", () => {
    const neg = effect({ startOffset: -1, duration: 0.3 });
    expect(isEffectActiveAtTime(neg, 0)).toBe(true);
    expect(isEffectActiveAtTime(neg, 0.31)).toBe(false);
  });
});
