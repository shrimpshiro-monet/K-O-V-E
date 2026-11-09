import { describe, expect, it } from "vitest";
import { HeadlessHost } from "../../headless-host";
import { makeEmptyProject } from "../../test-fixtures";
import { applyEditDNA } from "./apply-editdna";
import { mirrorReference1to1 } from "./mirror-reference-tool";
import { fixture } from "./mirror-fixture";
import type { MediaItem } from "@kove-advanced/core/types/project";
function hostWithMedia(duration = 5) {
  const project = makeEmptyProject();
  project.mediaLibrary.items.push({ id: "m1", name: "my source", type: "video", blob: null, fileHandle: null, thumbnailUrl: null, waveformData: null,
    metadata: { duration, width: 1280, height: 720, frameRate: 30, codec: "h264", sampleRate: 48000, channels: 2, fileSize: 100 },
  } satisfies MediaItem);
  return new HeadlessHost(project);
}
describe("mirror compiler on headless host", () => {
  it("conforms format and shot durations and writes real keyframes", async () => {
    const host = hostWithMedia();
    const ids = await applyEditDNA(host, fixture, ["m1"]);
    const project = host.getProject();
    expect(project.mirrorProfile?.version).toBe("kove.mirror.v3");
    expect(project.settings).toMatchObject({ width: 1080, height: 1920, frameRate: 30 });
    const clips = project.timeline.tracks.flatMap((t) => t.clips);
    expect(clips.map((c) => c.id)).toEqual(ids);
    expect(clips.map((c) => c.startTime)).toEqual([0, 1]);
    expect(clips.map((c) => c.duration)).toEqual([1, 2]);
    expect(clips.map((c) => c.inPoint)).toEqual([0, 1]);
    expect(clips.every((clip) => clip.mediaId === "m1")).toBe(true);
    expect(clips[0].keyframes.some((kf) => kf.property === "scale.x" && kf.time > 0)).toBe(true);
  });

  it("compiles a per-frame measured shot into a bounded keyframe set", async () => {
    const host = hostWithMedia(20);
    const frameSamples = Array.from({ length: 300 }, (_, i) => ({
      frame: i + 1, translateX: i % 2 === 0 ? 3 : -3, translateY: 0,
      rotationRad: i % 3 === 0 ? 0.05 : 0, scale: 1.001,
    }));
    const profile = {
      ...fixture,
      durationFrames: 330,
      rhythmCurve: [330],
      shots: [{ ...(fixture.shots[0]), startFrame: 0, endFrame: 330, cameraMotion: { samples: frameSamples, dominantMove: "handheld" as const } }],
    };
    const ids = await applyEditDNA(host, profile, ["m1"]);
    const clip = host.getProject().timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === ids[0]);
    const keyframeTimes = new Set((clip?.keyframes ?? []).map((kf) => kf.time));
    expect(keyframeTimes.size).toBeGreaterThanOrEqual(2);
    expect(keyframeTimes.size).toBeLessThanOrEqual(48);
    // Simplification is apply-time only: the stored profile keeps every measured sample.
    expect(host.getProject().mirrorProfile?.shots[0].cameraMotion?.samples).toHaveLength(300);
  });

  it("writes no keyframes for a near-static shot", async () => {
    const host = hostWithMedia(20);
    // 20 × 0.05px on a 1080-wide frame: total excursion below the invisible threshold.
    const frameSamples = Array.from({ length: 20 }, (_, i) => ({ frame: i + 1, translateX: 0.05, translateY: 0, rotationRad: 0, scale: 1 }));
    const profile = {
      ...fixture,
      durationFrames: 330,
      rhythmCurve: [330],
      shots: [{ ...(fixture.shots[0]), startFrame: 0, endFrame: 330, cameraMotion: { samples: frameSamples, dominantMove: "static" as const } }],
    };
    const ids = await applyEditDNA(host, profile, ["m1"]);
    const clip = host.getProject().timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === ids[0]);
    expect(clip?.keyframes ?? []).toEqual([]);
  });

  it("keeps measured text treatment but omits reference wording from the agent result", async () => {
    const host = hostWithMedia();
    const profile = {
      ...fixture,
      shots: fixture.shots.map((shot) => ({
        ...shot,
        captionWindows: [{ startFrame: shot.startFrame, endFrame: shot.endFrame, text: "PRIVATE_REFERENCE_WORDS" }],
      })),
      styleEvidence: {
        ...fixture.styleEvidence!,
        textOverlays: [{
          source: "local-ocr" as const,
          confidence: 0.6,
          startFrame: 0,
          endFrame: 20,
          bounds: { x: 0.2, y: 0.7, width: 0.5, height: 0.1 },
          text: "PRIVATE_REFERENCE_WORDS",
        }],
      },
    };
    const result = await mirrorReference1to1(host, profile, ["m1"]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_REFERENCE_WORDS");
    expect(result.profile.styleEvidence?.textOverlays[0]).toMatchObject({
      confidence: 0.6,
      bounds: { x: 0.2, y: 0.7, width: 0.5, height: 0.1 },
    });
  });
  it("writes an editable per-shot LUT only with measured reference and target stats", async () => {
    const host = hostWithMedia();
    const stats = { lMean: 60, lStd: 12, aMean: 4, aStd: 8, bMean: -2, bStd: 9 };
    const profile = { ...fixture, shots: fixture.shots.map((shot, i) => i === 0 ? { ...shot, colorStats: stats } : shot) };
    const ids = await applyEditDNA(host, profile, ["m1"], [stats]);
    const clip = host.getProject().timeline.tracks.flatMap((track) => track.clips).find((c) => c.id === ids[0]);
    expect(clip?.colorGrading?.lut?.size).toBe(17);
    expect(clip?.colorGrading?.lut?.data).toHaveLength(17 ** 3 * 3);
  });

  it("validates before mutating if source is too short", async () => {
    const host = hostWithMedia(0.5);
    await expect(applyEditDNA(host, fixture, ["m1"])).rejects.toThrow(/shorter/);
    expect(host.getProject().timeline.tracks).toHaveLength(0);
  });

  it("migrates legacy profiles before persisting them to the project", async () => {
    const host = hostWithMedia();
    const legacy = { ...fixture, version: "kove.mirror.v2" as const, styleEvidence: undefined };
    await applyEditDNA(host, legacy, ["m1"]);
    expect(host.getProject().mirrorProfile?.version).toBe("kove.mirror.v3");
    expect(host.getProject().mirrorProfile?.styleEvidence).toEqual({
      transitions: [],
      textOverlays: [],
      effects: [],
    });
  });
});
