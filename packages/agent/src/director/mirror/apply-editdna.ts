import type { EditingHost } from "../../host";
import type { ReferenceProfile } from "@kove-advanced/core/mirror/reference-profile";
import type { LabStats } from "@kove-advanced/core/color/reinhard-transfer";
import { createReinhardLut } from "@kove-advanced/core/color/reinhard-transfer";
import { allocateSourceRanges } from "@kove-advanced/core/mirror/allocate-shots";
import { serializeReferenceProfile } from "@kove-advanced/core/mirror/reference-profile";
import { frameToSeconds, shotDurationFrames } from "@kove-advanced/core/mirror/timebase";

/** Compiles measured shot boundaries and frame-relative motion into editable clips and keyframes.
 * Never inserts the reference media itself. Existing timeline content is preserved. */
export async function applyEditDNA(host: EditingHost, profile: ReferenceProfile, userMediaIds: readonly string[], targetStats?: readonly (LabStats | undefined)[]): Promise<string[]> {
  serializeReferenceProfile(profile); // validates chronology before any mutations
  if (!userMediaIds.length) throw new Error("Choose at least one source video");
  const project = host.getProject();
  const sources = userMediaIds.map((id) => {
    const item = project.mediaLibrary.items.find((media) => media.id === id && media.type === "video");
    if (!item) throw new Error(`Source video not found: ${id}`);
    return item;
  });
  for (const stats of targetStats ?? []) {
    if (stats && Object.values(stats).some((value) => typeof value !== "number" || !Number.isFinite(value))) throw new Error("Invalid target Lab statistics");
  }
  const ranges = allocateSourceRanges(profile.shots.map((shot) => frameToSeconds(shotDurationFrames(shot), profile.fps)), sources.map((item) => ({ id: item.id, duration: item.metadata.duration })));
  const tx = host.beginTransaction("Mirror reference");
  const apply = async (type: string, params: Record<string, unknown>) => {
    const result = await host.applyAction({ type: type as never, id: crypto.randomUUID(), timestamp: Date.now(), params });
    if (!result.success) throw new Error(result.error?.message ?? `${type} failed`);
  };
  const ids: string[] = [];
  try {
    await apply("project/updateSettings", { width: profile.aspectRatio.width, height: profile.aspectRatio.height, frameRate: profile.fps.num / profile.fps.den });
    // Dedicated track: do not layer mirrored shots on top of the user's original edit.
    await apply("track/add", { trackType: "video" });
    const track = host.getProject().timeline.tracks.filter((t) => t.type === "video").at(-1);
    if (!track) throw new Error("Could not create mirror video track");
    // Profile may start at a nonzero frame: preserve that offset while placing the first shot at zero.
    const origin = profile.shots[0].startFrame;
    for (let i = 0; i < profile.shots.length; i++) {
      const shot = profile.shots[i], sourceRange = ranges[i];
      const before = new Set(host.getProject().timeline.tracks.flatMap((t) => t.clips.map((c) => c.id)));
      await apply("clip/add", { trackId: track.id, mediaId: sourceRange.mediaId, startTime: frameToSeconds(shot.startFrame - origin, profile.fps), duration: frameToSeconds(shotDurationFrames(shot), profile.fps), inPoint: sourceRange.inPoint, outPoint: sourceRange.outPoint });
      const id = host.getProject().timeline.tracks.flatMap((t) => t.clips).find((c) => !before.has(c.id))?.id;
      if (!id) throw new Error("Inserted clip not found");
      ids.push(id);
      const samples = shot.cameraMotion?.samples ?? [];
      if (samples.length) {
        let x = 0, y = 0, angle = 0, zoom = 1;
        const tracks: Array<{ time: number; property: string; value: number }> = [
          { time: 0, property: "position.x", value: 0 }, { time: 0, property: "position.y", value: 0 },
          { time: 0, property: "rotation", value: 0 }, { time: 0, property: "scale.x", value: 1 }, { time: 0, property: "scale.y", value: 1 },
        ];
        for (const sample of samples) {
          // Invert reference frame motion to reproduce the camera's virtual move on new footage.
          x -= sample.translateX / profile.aspectRatio.width;
          y -= sample.translateY / profile.aspectRatio.height;
          angle -= sample.rotationRad * 180 / Math.PI;
          zoom /= sample.scale || 1;
          const time = frameToSeconds(sample.frame - shot.startFrame, profile.fps);
          if (time <= 0 || time > frameToSeconds(shotDurationFrames(shot), profile.fps) || ![x, y, angle, zoom].every(Number.isFinite)) continue;
          tracks.push(...([
            ["position.x", x], ["position.y", y], ["rotation", angle], ["scale.x", zoom], ["scale.y", zoom],
          ] as const).map(([property, value]) => ({ time, property, value })));
        }
        await apply("keyframe/setAll", { clipId: id, keyframes: tracks.map((k, n) => ({ ...k, id: `${id}-mirror-${n}`, easing: "linear" })) });
      }
      const target = targetStats?.[i];
      if (shot.colorStats && target) await apply("clip/setColorGrading", { clipId: id, colorGrading: { lut: createReinhardLut(shot.colorStats, target) } });
    }
    await apply("project/setMirrorProfile", { profile });
    host.commitTransaction(tx, "Mirror reference");
    return ids;
  } catch (error) {
    await host.rollbackTransaction(tx);
    throw error;
  }
}
