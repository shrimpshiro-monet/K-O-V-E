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
describe("mirror compiler on headless host", () => {
  it("conforms format and shot durations and writes real keyframes", async () => {
    const host = hostWithMedia();
    const ids = await applyEditDNA(host, fixture, ["m1"]);
    const project = host.getProject();
    expect(project.mirrorProfile?.version).toBe("kove.mirror.v2");
    expect(project.settings).toMatchObject({ width: 1080, height: 1920, frameRate: 30 });
    const clips = project.timeline.tracks.flatMap((t) => t.clips);
    expect(clips.map((c) => c.id)).toEqual(ids);
    expect(clips.map((c) => c.startTime)).toEqual([0, 1]);
    expect(clips.map((c) => c.duration)).toEqual([1, 2]);
    expect(clips.map((c) => c.inPoint)).toEqual([0, 1]);
    expect(clips[0].keyframes.some((kf) => kf.property === "scale.x" && kf.time > 0)).toBe(true);
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
});
