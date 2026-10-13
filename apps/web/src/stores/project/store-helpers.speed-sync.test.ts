import { describe, expect, it } from "vitest";
import type { Project } from "@kove-advanced/core";
import { getSpeedEngine, initializeSpeedEngine } from "@kove-advanced/core";
import type { ProjectState } from "../project-store";
import { createProjectStoreHelpers } from "./store-helpers";

// The store syncs engines on every project change. Speed ramps / freeze
// frames live on clips; before the adoption in syncOverlayEnginesFromProject
// they silently played as 1x straight-through in BOTH preview and export.
function makeProject(clip: Record<string, unknown>): Project {
  return {
    id: "p1",
    name: "speed sync",
    createdAt: 0,
    modifiedAt: 0,
    settings: { width: 1920, height: 1080, frameRate: 30, sampleRate: 48000, channels: 2 },
    timeline: {
      duration: 0,
      tracks: [
        {
          id: "track-1",
          type: "video",
          clips: [
            {
              id: "clip-1",
              mediaId: "m1",
              trackId: "track-1",
              startTime: 0,
              duration: 4,
              inPoint: 0,
              outPoint: 4,
              ...clip,
            },
          ],
        },
      ],
      subtitles: [],
      markers: [],
    },
    mediaLibrary: { items: [] },
  } as unknown as Project;
}

describe("syncOverlayEnginesFromProject — speed engine", () => {
  it("registers clip speedKeyframes + freezeFrames into the speed engine (replace semantics)", () => {
    initializeSpeedEngine(); // fresh singleton for the assertion
    const project = makeProject({
      speed: 1,
      speedKeyframes: [
        { id: "k0", time: 0, speed: 1, easing: "linear" },
        { id: "k1", time: 4, speed: 2, easing: "linear" },
      ],
      freezeFrames: [{ id: "f0", sourceTime: 2, startTime: 1, duration: 0.5 }],
    });
    let state = { project } as ProjectState;
    const set = (partial: Partial<ProjectState>) => {
      state = { ...state, ...partial } as ProjectState;
    };
    const get = () => state;
    const helpers = createProjectStoreHelpers(set, get);

    helpers.syncOverlayEnginesFromProject();
    helpers.syncOverlayEnginesFromProject(); // store syncs on every change — replace, never accumulate

    const speedEngine = getSpeedEngine();
    const keyframes = speedEngine.getSpeedKeyframes("clip-1");
    expect(keyframes.map((k) => [k.time, k.speed])).toEqual([
      [0, 1],
      [4, 2],
    ]);
    const freezes = speedEngine.getFreezeFrames("clip-1");
    expect(freezes).toHaveLength(1);
    expect(freezes[0]).toMatchObject({ clipId: "clip-1", sourceTime: 2, startTime: 1, duration: 0.5 });
  });
});
