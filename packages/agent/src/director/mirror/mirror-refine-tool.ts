import type { EditingHost } from "../../host";
import { validateReferenceProfile } from "@kove-advanced/core/mirror/reference-profile";
import { frameToSeconds, secondsToFrame, shotSampleFrame } from "@kove-advanced/core/mirror/timebase";
import { refineMirror, type RefineKnobs } from "./refine-mirror";

/** Real decoded-frame critic. Works in the browser and on headless hosts that
 * provide an actual reference decoder AND a timeline compositor via mirrorFrameRunner.
 * A missing backend is an error, never a made-up parity number. */
export async function mirrorRefine(host: EditingHost, shotItemIds: readonly string[], options: {
  iterations?: number; seed?: number; targetScore?: number; sampleCount?: number;
} = {}) {
  host.requireOpenProject();
  const profile = host.getProject().mirrorProfile;
  if (!profile) throw new Error("No attached EditDNA: compile the reference first");
  validateReferenceProfile(profile);
  if (host.features?.().mirrorFrames !== true || !host.sampleMirrorFrame) throw new Error("UNSUPPORTED_HOST: real reference decoder and composited timeline renderer required");
  const sampleCount = options.sampleCount ?? Math.min(3, profile.shots.length);
  if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > 12) throw new Error("sampleCount must be 1..12");
  if (shotItemIds.length !== profile.shots.length || new Set(shotItemIds).size !== shotItemIds.length) throw new Error("Supply each compiled shot clip ID in EditDNA order");
  const clips = shotItemIds.map((id) => host.getProject().timeline.tracks.flatMap((track) => track.clips).find((clip) => clip.id === id));
  if (clips.some((clip) => !clip)) throw new Error("Mirror clips have changed: recompile the reference");
  const originals = clips.map((clip) => ({ id: clip!.id, keyframes: structuredClone(clip!.keyframes), colorGrading: structuredClone(clip!.colorGrading) }));
  const sampleFrames = Array.from({ length: sampleCount }, (_, i) => shotSampleFrame(profile.shots[Math.min(profile.shots.length - 1, Math.floor(i * profile.shots.length / sampleCount))]!));
  // Sample before opening a transaction: an unavailable reference is not a partial edit.
  const samples = await Promise.all(sampleFrames.map(async (frame) => ({
    timeSeconds: frameToSeconds(frame, profile.fps),
    reference: await host.sampleMirrorFrame!({ kind: "reference", frame, fps: profile.fps }),
  })));
  const transaction = host.beginTransaction("Refine mirror renders");
  const action = async (type: string, params: Record<string, unknown>) => {
    const result = await host.applyAction({ type: type as never, id: crypto.randomUUID(), timestamp: Date.now(), params });
    if (!result.success) throw new Error(result.error?.message ?? `${type} failed`);
  };
  const apply = async (knobs: RefineKnobs) => {
    for (const original of originals) {
      await action("keyframe/setAll", { clipId: original.id, keyframes: original.keyframes.map((kf) => ({
        ...kf,
        value: typeof kf.value === "number" ? (kf.property.startsWith("scale.") ? 1 + (kf.value - 1) * knobs.motionScale : kf.value * knobs.motionScale) : kf.value,
      })) });
      if (original.colorGrading?.lut) await action("clip/setColorGrading", { clipId: original.id,
        colorGrading: { ...original.colorGrading, lut: { ...original.colorGrading.lut, intensity: knobs.gradeStrength } } });
    }
  };
  try {
    const measured = await refineMirror({
      samples,
      referenceDurations: profile.rhythmCurve,
      candidateDurations: clips.map((clip) => secondsToFrame(clip!.duration, profile.fps)),
      apply,
      render: async (timeSeconds) => host.sampleMirrorFrame!({ kind: "timeline", frame: secondsToFrame(timeSeconds, profile.fps), fps: profile.fps }),
      ...(host.features?.().lpipsMirrorFrames && host.lpipsMirrorFrames && { lpips: (reference: typeof samples[number]["reference"], candidate: typeof samples[number]["reference"]) => host.lpipsMirrorFrames!(reference, candidate) }),
      iterations: options.iterations, seed: options.seed, targetScore: options.targetScore,
    });
    host.commitTransaction(transaction, "Refine mirror renders");
    return { ...measured, sampleFrames, fps: profile.fps, fpsSource: profile.fpsSource, durationFrames: profile.durationFrames, shotItemIds: [...shotItemIds], seed: options.seed ?? 0x1234abcd, iterations: options.iterations ?? 8, scoreFormula: measured.lpipsDistance === undefined ? "0.75 * mean grayscale SSIM + 0.25 * DTW rhythm" : "0.75 * mean(SSIM, 1-LPIPS distance) + 0.25 * DTW rhythm", lpips: measured.lpipsDistance === undefined ? "unavailable" : "measured" };
  } catch (error) {
    await host.rollbackTransaction(transaction);
    throw error;
  }
}
