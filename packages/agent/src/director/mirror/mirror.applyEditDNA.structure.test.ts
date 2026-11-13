import { describe, expect, it } from "vitest";
import { HeadlessHost } from "../../headless-host";
import { makeEmptyProject } from "../../test-fixtures";
import { applyEditDNA } from "./apply-editdna";
import { fixture } from "./mirror-fixture";
import type { MediaItem } from "@kove-advanced/core/types/project";
function hostWithMedia(duration = 5) {
  const project = makeEmptyProject();
  project.mediaLibrary.items.push({ id: "m1", name: "my source", type: "video", blob: null, fileHandle: null, thumbnailUrl: null, waveformData: null,
    metadata: { duration, width: 1280, height: 720, frameRate: 30, codec: "h264", sampleRate: 48000, channels: 2, fileSize: 100 },
  } satisfies MediaItem);
  return new HeadlessHost(project);
}

const structureFixture = {
  ...fixture,
  structure: {
    editRange: { startFrame: 0, endFrame: 90 },
    events: [
      { frame: 30, type: "flash" as const, durationFrames: 2, intensity: 0.6, confidence: 0.8, source: "local-pixel-analysis" as const },
      { frame: 50, type: "dip" as const, durationFrames: 2, intensity: 0.7, confidence: 0.8, source: "local-pixel-analysis" as const },
      { frame: 75, type: "hard-cut" as const, durationFrames: 1, intensity: 1, confidence: 0.55, source: "ffmpeg-scene-score" as const },
    ],
    energyCurve: [0.1, 0.4, 0.2],
    density: { cutsPerSec: 1, eventsPerSec: 1.5, byType: { "hard-cut": 1, flash: 1, dip: 1 } },
    shotLengths: { median: 30, p25: 30, p75: 30, min: 30, max: 60 },
  },
};

describe("mirror compiler: measured edit structure", () => {
  it("compiles a boundary flash event into a rendered flash transition, not a doubled brightness hit", async () => {
    const host = hostWithMedia();
    const ids = await applyEditDNA(host, structureFixture, ["m1"]);
    const project = host.getProject();
    const clips = project.timeline.tracks.flatMap((t) => t.clips);
    expect(clips).toHaveLength(2);
    const mirrorTrack = project.timeline.tracks.filter((t) => t.type === "video").at(-1)!;
    expect(mirrorTrack.transitions).toHaveLength(1);
    expect(mirrorTrack.transitions[0]).toMatchObject({
      type: "flash",
      clipAId: ids[0],
      clipBId: ids[1],
      duration: 2 / 30,
    });
    // The boundary flash became the transition, not a doubled brightness hit.
    expect(clips[0].effects).toEqual([]);
    // The mid-shot dip at frame 50 is a separate measured event on shot 2.
    expect(clips[1].effects).toEqual([
      expect.objectContaining({
        type: "brightness",
        params: { value: -70, startOffset: 20 / 30, duration: 2 / 30 },
      }),
    ]);
  });

  it("compiles a mid-shot dip event into a timed brightness hit", async () => {
    const host = hostWithMedia();
    await applyEditDNA(host, structureFixture, ["m1"]);
    const clip = host.getProject().timeline.tracks.flatMap((t) => t.clips)[1]!;
    // Frame 50 sits in shot 2 (30..90): offset 20 frames, value -0.7*100.
    expect(clip.effects).toEqual([
      expect.objectContaining({
        type: "brightness",
        params: { value: -70, startOffset: 20 / 30, duration: 2 / 30 },
      }),
    ]);
  });

  it("compiles a mid-shot flash event into a timed brightness hit", async () => {
    const host = hostWithMedia();
    const profile = {
      ...structureFixture,
      structure: {
        ...structureFixture.structure,
        events: [
          { frame: 45, type: "flash" as const, durationFrames: 2, intensity: 0.6, confidence: 0.8, source: "local-pixel-analysis" as const },
        ],
      },
    };
    await applyEditDNA(host, profile, ["m1"]);
    const project = host.getProject();
    expect(project.timeline.tracks.filter((t) => t.type === "video").at(-1)!.transitions).toHaveLength(0);
    const clip = project.timeline.tracks.flatMap((t) => t.clips)[1]!;
    expect(clip.effects).toEqual([
      expect.objectContaining({
        type: "brightness",
        params: { value: 60, startOffset: 15 / 30, duration: 2 / 30 },
      }),
    ]);
  });

  it("snaps accent offsets to the reference beat grid within 2 frames", async () => {
    const host = hostWithMedia();
    const profile = {
      ...structureFixture,
      beatGridMs: [1000, 2000, 3000, 4000],
      structure: {
        ...structureFixture.structure,
        events: [
          // Frame 32 is 2/30s (≈66ms) after the 1000ms beat: snaps to frame 30.
          { frame: 32, type: "dip" as const, durationFrames: 2, intensity: 0.7, confidence: 0.8, source: "local-pixel-analysis" as const },
        ],
      },
    };
    await applyEditDNA(host, profile, ["m1"]);
    const clip = host.getProject().timeline.tracks.flatMap((t) => t.clips)[1]!;
    expect(clip.effects).toEqual([
      expect.objectContaining({
        type: "brightness",
        params: { value: -70, startOffset: 0, duration: 2 / 30 },
      }),
    ]);
  });

  it("drops low-confidence boundary events instead of inventing transitions", async () => {
    const host = hostWithMedia();
    const profile = {
      ...structureFixture,
      structure: {
        ...structureFixture.structure,
        events: [
          { frame: 30, type: "flash" as const, durationFrames: 2, intensity: 0.6, confidence: 0.4, source: "local-pixel-analysis" as const },
        ],
      },
    };
    await applyEditDNA(host, profile, ["m1"]);
    const project = host.getProject();
    expect(project.timeline.tracks.filter((t) => t.type === "video").at(-1)!.transitions).toHaveLength(0);
    expect(project.timeline.tracks.flatMap((t) => t.clips)[1]!.effects).toEqual([]);
  });

  it("does not treat the edit origin as a cut boundary", async () => {
    const host = hostWithMedia();
    const profile = {
      ...structureFixture,
      structure: {
        ...structureFixture.structure,
        events: [
          { frame: 1, type: "flash" as const, durationFrames: 2, intensity: 0.6, confidence: 0.8, source: "local-pixel-analysis" as const },
        ],
      },
    };
    await applyEditDNA(host, profile, ["m1"]);
    expect(host.getProject().timeline.tracks.filter((t) => t.type === "video").at(-1)!.transitions).toHaveLength(0);
  });
});
