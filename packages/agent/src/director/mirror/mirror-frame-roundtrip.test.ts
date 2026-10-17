import { expect, it } from "vitest";
import { HeadlessHost } from "../../headless-host";
import { makeEmptyProject } from "../../test-fixtures";
import { applyEditDNA } from "./apply-editdna";
import { createReferenceProfile } from "@kove-advanced/core/mirror/reference-profile";
import { frameRate, frameToSeconds, secondsToFrame } from "@kove-advanced/core/mirror/timebase";
import { ProjectSerializer } from "@kove-advanced/core/storage/project-serializer";
import type { IStorageEngine } from "@kove-advanced/core/storage/types";

it("compiles 30000/1001 frame boundaries and preserves them through project export/import", async () => {
  const fps = frameRate(30000, 1001);
  const profile = createReferenceProfile({ fps, fpsSource: "ffprobe", durationFrames: 3603,
    aspectRatio: { width: 1920, height: 1080 }, beatGridMs: [], shots: [
      { startFrame: 0, endFrame: 1001, captionWindows: [], cameraMotion: { dominantMove: "pan", samples: [{ frame: 500, translateX: 3, translateY: 0, rotationRad: 0, scale: 1 }] } },
      { startFrame: 1001, endFrame: 3603, captionWindows: [] },
    ] });
  const project = makeEmptyProject();
  project.mediaLibrary.items.push({ id: "m1", name: "source", type: "video", blob: null, fileHandle: null, thumbnailUrl: null, waveformData: null,
    metadata: { duration: 300, width: 1920, height: 1080, frameRate: 30, codec: "h264", sampleRate: 0, channels: 0, fileSize: 1 } });
  const host = new HeadlessHost(project);
  const ids = await applyEditDNA(host, profile, ["m1"]);
  const serializer = new ProjectSerializer({} as IStorageEngine);
  const restored = serializer.importFromJson(serializer.exportToJson(host.getProject()));
  const clips = ids.map((id) => restored.timeline.tracks.flatMap((t) => t.clips).find((clip) => clip.id === id)!);
  expect(restored.mirrorProfile).toEqual(profile);
  expect(restored.settings.frameRate).toBe(fps.num / fps.den);
  expect(clips.map((clip) => secondsToFrame(clip.startTime, fps))).toEqual([0, 1001]);
  expect(clips.map((clip) => secondsToFrame(clip.duration, fps))).toEqual([1001, 2602]);
  expect(clips.map((clip) => secondsToFrame(clip.startTime + clip.duration, fps))).toEqual([1001, 3603]);
  const pan = clips[0]!.keyframes.find((kf) => kf.property === "position.x" && kf.time > 0)!;
  expect(secondsToFrame(pan.time, fps)).toBe(500);
  expect(pan.time).toBe(frameToSeconds(500, fps));
});
