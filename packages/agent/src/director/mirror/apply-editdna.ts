import type { EditingHost } from "../../host";
import type { EditEvent, ReferenceProfile } from "@kove-advanced/core/mirror/reference-profile";
import type { LabStats } from "@kove-advanced/core/color/reinhard-transfer";
import { createReinhardLut } from "@kove-advanced/core/color/reinhard-transfer";
import { allocateSourceRanges } from "@kove-advanced/core/mirror/allocate-shots";
import { parseReferenceProfile } from "@kove-advanced/core/mirror/reference-profile";
import { frameToSeconds, shotDurationFrames } from "@kove-advanced/core/mirror/timebase";
import {
  coverSafeMotionKeyframes,
  integrateMotionSeries,
  MIN_MOTION_MAGNITUDE,
  simplifyMotionKeyframes,
} from "./simplify-motion";

/** Measured event types that compile to a rendered transition between the two
 * adjacent mirror clips. Types absent here compile to nothing (hard cuts are
 * clip boundaries already; speed ramps need the planner, not the compiler). */
const EVENT_TRANSITIONS: Partial<Record<EditEvent["type"], string>> = {
  flash: "flash",
  dissolve: "crossfade",
  whip: "whipPan",
  "shake-hit": "impactShake",
  "zoom-punch": "crossZoom",
  "rgb-split": "colorSplit",
};

/** Measured confidence floor for compiling an accent. Structure events come
 * from deterministic pixel/scene analysis, so 0.5 keeps low-confidence ffmpeg
 * scene candidates out without discarding measured pixel excursions (0.8). */
const EVENT_CONFIDENCE_FLOOR = 0.5;

interface TimedAccent {
  readonly startFrame: number;
  readonly endFrame: number;
  readonly kind: "flash" | "dip";
  /** 0..1 measured excursion strength when derived from structure events. */
  readonly intensity?: number;
  /** Directly measured brightness parameter (legacy style-evidence path). */
  readonly measuredBrightness?: number;
}

/** Boundary cut into shot `boundary` (the transition between clip boundary-1
 * and clip boundary). The first shot's start is the edit origin, not a cut. */
function findBoundaryIndex(event: EditEvent, profile: ReferenceProfile): number {
  for (let i = 1; i < profile.shots.length; i++) {
    if (Math.abs(profile.shots[i]!.startFrame - event.frame) <= 1) return i;
  }
  return -1;
}

/** Snap a frame to the nearest reference beat when a reliable grid exists,
 * within the same ±2-frame tolerance the beat-sync acceptance gate uses. */
function snapToBeatFrame(frame: number, profile: ReferenceProfile): number {
  if (!profile.beatGridMs.length) return frame;
  const fps = profile.fps.num / profile.fps.den;
  let best = frame;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const ms of profile.beatGridMs) {
    const distance = Math.abs((ms / 1000) * fps - frame);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = (ms / 1000) * fps;
    }
  }
  return bestDistance <= 2 ? best : frame;
}

/** Compiles measured shot boundaries and frame-relative motion into editable clips and keyframes.
 * Never inserts the reference media itself. Existing timeline content is preserved. */
export async function applyEditDNA(host: EditingHost, inputProfile: ReferenceProfile, userMediaIds: readonly string[], targetStats?: readonly (LabStats | undefined)[]): Promise<string[]> {
  const profile = parseReferenceProfile(inputProfile);
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
    const events = profile.structure?.events ?? [];
    // Structure events (v3 measured edit structure) drive accents when present;
    // legacy style evidence is the fallback for profiles extracted before v3.
    const accents: TimedAccent[] = events.length
      ? events
          .filter(
            (event): event is EditEvent & { type: "flash" | "dip" } =>
              (event.type === "flash" || event.type === "dip") &&
              event.confidence >= EVENT_CONFIDENCE_FLOOR,
          )
          .map((event) => ({
            startFrame: event.frame,
            endFrame: event.frame + Math.max(1, event.durationFrames),
            kind: event.type,
            intensity: event.intensity,
          }))
      : (profile.styleEvidence?.effects ?? [])
          .filter(
            (evidence) =>
              evidence.confidence >= 0.75 &&
              (evidence.name === "flash" || evidence.name === "dip"),
          )
          .map((evidence) => ({
            startFrame: evidence.startFrame,
            endFrame: evidence.endFrame,
            kind: evidence.name as "flash" | "dip",
            measuredBrightness: evidence.parameterEstimates?.brightness,
          }));
    await apply("project/updateSettings", { width: profile.aspectRatio.width, height: profile.aspectRatio.height, frameRate: profile.fps.num / profile.fps.den });
    // Boundary accents that will compile to rendered transitions: decide the
    // set before the clip loop so their brightness effects are not doubled.
    // The engine centers a transition window on the clip boundary (see
    // transition-engine getTransitionWindow), so no clip overlap is required.
    const transitionFrames = new Set<number>();
    if (events.length) {
      for (const event of events) {
        if (!EVENT_TRANSITIONS[event.type] || event.confidence < EVENT_CONFIDENCE_FLOOR) continue;
        if (findBoundaryIndex(event, profile) < 1) continue;
        transitionFrames.add(event.frame);
      }
    }
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
      await apply("transform/update", { clipId: id, transform: { fitMode: "cover" } });
      const samples = shot.cameraMotion?.samples ?? [];
      const dominantMove = shot.cameraMotion?.dominantMove;
      if (samples.length && (dominantMove === "push" || dominantMove === "pull")) {
        const series = integrateMotionSeries(samples, shot, profile.fps, profile.aspectRatio);
        const source = sources.find((item) => item.id === sourceRange.mediaId);
        if (!source) throw new Error(`Allocated source video not found: ${sourceRange.mediaId}`);
        const magnitude = series.reduce(
          (max, point) => Math.max(max, Math.abs(point.zoom - 1)),
          0,
        );
        const tracks = magnitude >= MIN_MOTION_MAGNITUDE
          ? coverSafeMotionKeyframes(
              simplifyMotionKeyframes(series),
              series,
              { width: source.metadata.width, height: source.metadata.height },
              { width: profile.aspectRatio.width, height: profile.aspectRatio.height },
            )
          : [];
        if (tracks.length) {
          await apply("keyframe/setAll", { clipId: id, keyframes: tracks.map((k, n) => ({ ...k, id: `${id}-mirror-${n}`, easing: "linear" })) });
        }
      }
      const target = targetStats?.[i];
      if (shot.colorStats && target) await apply("clip/setColorGrading", { clipId: id, colorGrading: { lut: createReinhardLut(shot.colorStats, target) } });
      for (const accent of accents) {
        if (accent.startFrame < shot.startFrame || accent.endFrame > shot.endFrame) continue;
        if (accent.kind === "flash" && transitionFrames.has(accent.startFrame)) continue;
        let value: number;
        if (typeof accent.intensity === "number" && Number.isFinite(accent.intensity)) {
          value = Math.round(Math.max(0.4, Math.min(1, accent.intensity)) * 100) * (accent.kind === "flash" ? 1 : -1);
        } else if (typeof accent.measuredBrightness === "number" && Number.isFinite(accent.measuredBrightness)) {
          value = Math.max(-100, Math.min(100, accent.measuredBrightness));
        } else {
          value = accent.kind === "flash" ? 100 : -100;
        }
        const offsetFrame = Math.max(0, snapToBeatFrame(accent.startFrame, profile) - shot.startFrame);
        await apply("effect/add", {
          clipId: id,
          effectType: "brightness",
          params: {
            value,
            startOffset: frameToSeconds(offsetFrame, profile.fps),
            duration: frameToSeconds(Math.max(1, accent.endFrame - accent.startFrame), profile.fps),
          },
        });
      }
    }
    // Compiled boundary transitions between the adjacent mirror clips.
    if (events.length) {
      const minDuration = frameToSeconds(2, profile.fps);
      for (const event of events) {
        const transitionType = EVENT_TRANSITIONS[event.type];
        if (!transitionType || event.confidence < EVENT_CONFIDENCE_FLOOR) continue;
        const boundary = findBoundaryIndex(event, profile);
        if (boundary < 1) continue;
        const clipAId = ids[boundary - 1];
        const clipBId = ids[boundary];
        if (!clipAId || !clipBId) continue;
        const duration = Math.min(0.5, Math.max(minDuration, frameToSeconds(Math.max(2, event.durationFrames), profile.fps)));
        await apply("transition/add", { clipAId, clipBId, transitionType, duration });
      }
    }
    await apply("project/setMirrorProfile", { profile });
    host.commitTransaction(tx, "Mirror reference");
    return ids;
  } catch (error) {
    await host.rollbackTransaction(tx);
    throw error;
  }
}
