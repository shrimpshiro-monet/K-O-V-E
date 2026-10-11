// Regression: executeAction (the agent/live-host mutation path) must keep the
// render bridges in lockstep with the project. Before the fix it did a bare
// `set({ project })`, so plan-applied transitions and effects existed in the
// store but were INVISIBLE to the preview (hard cuts, no glow/effects) while
// UI-added ones rendered fine. Proven live by canvas luminance sweeps.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useProjectStore } from "./project-store";
import type { Clip, Transition } from "@kove-advanced/core";
import { createEmptyProject } from "./project/project-helpers";

const {
  mockEffectsBridge,
  mockEffectsBridgeState,
  mockTransitionBridge,
  mockTransitionBridgeState,
} = vi.hoisted(() => {
  const clipEffects = new Map<string, Array<Record<string, unknown>>>();
  const effectsBridge = {
    isInitialized: vi.fn(() => true),
    deserializeEffects: vi.fn(
      (clipId: string, data: { effects: Array<Record<string, unknown>> }) => {
        clipEffects.set(clipId, data.effects.map((effect) => ({ ...effect })));
        return { success: true };
      },
    ),
    clearEffects: vi.fn((clipId: string) => {
      clipEffects.delete(clipId);
    }),
    getColorGrading: vi.fn(() => ({})),
  };

  const trackTransitions = new Map<string, Transition[]>();
  const transitionBridge = {
    isInitialized: vi.fn(() => true),
    setTransitionsForTrack: vi.fn((trackId: string, transitions: Transition[]) => {
      trackTransitions.set(trackId, [...transitions]);
    }),
    clearTransitionsForTrack: vi.fn((trackId: string) => {
      trackTransitions.delete(trackId);
    }),
  };

  return {
    mockEffectsBridge: effectsBridge,
    mockEffectsBridgeState: { clipEffects },
    mockTransitionBridge: transitionBridge,
    mockTransitionBridgeState: { trackTransitions },
  };
});

vi.mock("../services/auto-save", () => ({
  autoSaveManager: {
    startAutoSave: vi.fn(),
    stopAutoSave: vi.fn(),
    triggerSave: vi.fn(),
    getRecentSaves: vi.fn().mockResolvedValue([]),
    loadSave: vi.fn(),
    deleteSave: vi.fn(),
  },
  initializeAutoSave: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../bridges/media-bridge", () => ({
  getMediaBridge: vi.fn(() => ({ isInitialized: vi.fn().mockReturnValue(true) })),
  initializeMediaBridge: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../bridges/effects-bridge", () => ({
  getEffectsBridge: vi.fn(() => mockEffectsBridge),
}));

vi.mock("../bridges/transition-bridge", () => ({
  getTransitionBridge: vi.fn(() => mockTransitionBridge),
}));

const makeClip = (id: string, trackId: string, startTime: number): Clip => ({
  id,
  mediaId: "media-1",
  trackId,
  startTime,
  duration: 5,
  inPoint: 0,
  outPoint: 5,
  effects: [],
  audioEffects: [],
  transform: {
    position: { x: 0.5, y: 0.5 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    anchor: { x: 0.5, y: 0.5 },
    opacity: 1,
  },
  volume: 1,
  keyframes: [],
});

function seedProjectWithTwoClips() {
  const project = createEmptyProject("Bridge Sync Test");
  const track = {
    id: "video-track-1",
    type: "video" as const,
    name: "Video 1",
    clips: [makeClip("clip-a", "video-track-1", 0), makeClip("clip-b", "video-track-1", 5)],
    transitions: [],
    locked: false,
    hidden: false,
    muted: false,
    solo: false,
  };
  const seeded = { ...project, timeline: { ...project.timeline, tracks: [track] } };
  useProjectStore.setState({ project: seeded, hasOpenProject: true });
}

describe("executeAction render-bridge sync (agent mutation path)", () => {
  beforeEach(() => {
    mockEffectsBridgeState.clipEffects.clear();
    mockTransitionBridgeState.trackTransitions.clear();
    mockEffectsBridge.deserializeEffects.mockClear();
    mockTransitionBridge.setTransitionsForTrack.mockClear();
    seedProjectWithTwoClips();
  });

  it("pushes transition/add into the transition bridge", async () => {
    const result = await useProjectStore.getState().executeAction({
      type: "transition/add",
      id: "t-add-1",
      timestamp: Date.now(),
      params: {
        clipAId: "clip-a",
        clipBId: "clip-b",
        transitionType: "crossfade",
        duration: 0.45,
      },
    });
    expect(result.success).toBe(true);

    const synced = mockTransitionBridgeState.trackTransitions.get("video-track-1") ?? [];
    expect(synced.map((t) => ({ a: t.clipAId, b: t.clipBId, type: t.type, d: t.duration }))).toEqual([
      { a: "clip-a", b: "clip-b", type: "crossfade", d: 0.45 },
    ]);
  });

  it("pushes effect/add into the effects bridge", async () => {
    const result = await useProjectStore.getState().executeAction({
      type: "effect/add",
      id: "e-add-1",
      timestamp: Date.now(),
      params: {
        clipId: "clip-a",
        effectType: "glow",
        params: { radius: 18, intensity: 0.9, color: "#7c4dff" },
      },
    });
    expect(result.success).toBe(true);

    const glowCalls = mockEffectsBridge.deserializeEffects.mock.calls.filter(([, data]) =>
      data.effects.some((effect) => effect.type === "glow"),
    );
    expect(glowCalls.length).toBeGreaterThan(0);
    expect(mockEffectsBridgeState.clipEffects.get("clip-a")?.some((e) => e.type === "glow")).toBe(true);
  });

  it("clears bridge state for clips removed via executeAction", async () => {
    // Pre-seed the bridge as if the clip were already rendered.
    mockEffectsBridgeState.clipEffects.set("clip-a", [{ id: "fx-1", type: "glow" }]);
    const before = useProjectStore.getState().project;
    expect(before.timeline.tracks[0].clips.some((c) => c.id === "clip-a")).toBe(true);

    const result = await useProjectStore.getState().executeAction({
      type: "clip/remove",
      id: "c-rm-1",
      timestamp: Date.now(),
      params: { clipId: "clip-a" },
    });
    expect(result.success).toBe(true);
    expect(mockEffectsBridgeState.clipEffects.has("clip-a")).toBe(false);
  });
});
