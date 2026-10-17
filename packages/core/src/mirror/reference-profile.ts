import type { LabStats } from "../color/reinhard-transfer";
import type { CameraMotionCurve } from "../vision/camera-motion-extractor";
import { frameRate, secondsToFrame, shotDurationFrames, type FrameRate } from "./timebase";

export interface ShotProfile {
  /** Half-open interval [startFrame, endFrame) on the reference clock. */
  startFrame: number;
  endFrame: number;
  captionWindows: Array<{ startFrame: number; endFrame: number; text?: string }>;
  /** Canonical, frame-indexed motion measurement lives in cameraMotion.samples.
   * The existing dominantMove is derived from samples for v2 compatibility.
   * Do not introduce a sibling `camera` field or independently stored summary:
   * derive new classifications from these samples to avoid two sources of truth. */
  cameraMotion?: CameraMotionCurve;
  colorStats?: LabStats;
}

/** Media-free reference structure. Pixel/audio samples never enter EditDNA. */
export interface ReferenceProfile {
  version: "kove.mirror.v2";
  fps: FrameRate;
  fpsSource: "ffprobe" | "web-metadata" | "user";
  durationFrames: number;
  aspectRatio: { width: number; height: number };
  sampleAspectRatio?: FrameRate;
  codedDimensions?: { width: number; height: number };
  rotationDegrees?: number;
  shots: ShotProfile[];
  /** Shot durations in integer frames. */
  rhythmCurve: number[];
  beatGridMs: number[];
  warnings?: string[];
}

export function createReferenceProfile(input: Omit<ReferenceProfile, "version" | "rhythmCurve" | "durationFrames"> & { durationFrames: number }): ReferenceProfile {
  const profile: ReferenceProfile = {
    ...input, version: "kove.mirror.v2",
    fps: frameRate(input.fps.num, input.fps.den),
    rhythmCurve: input.shots.map(shotDurationFrames),
  };
  validateReferenceProfile(profile);
  return profile;
}

export function validateReferenceProfile(profile: ReferenceProfile): void {
  if (profile.version !== "kove.mirror.v2") throw new Error("Unsupported EditDNA version");
  const canonicalFps = frameRate(profile.fps.num, profile.fps.den);
  if (canonicalFps.num !== profile.fps.num || canonicalFps.den !== profile.fps.den) throw new Error("EditDNA FPS must be a reduced rational");
  if (!["ffprobe", "web-metadata", "user"].includes(profile.fpsSource)) throw new Error("FPS provenance is required");
  if (!Number.isSafeInteger(profile.durationFrames) || profile.durationFrames <= 0 || !Number.isFinite(profile.aspectRatio.width) || !Number.isFinite(profile.aspectRatio.height) || profile.aspectRatio.width <= 0 || profile.aspectRatio.height <= 0) {
    throw new Error("Invalid reference duration or dimensions");
  }
  if (profile.codedDimensions && (!Number.isSafeInteger(profile.codedDimensions.width) || !Number.isSafeInteger(profile.codedDimensions.height) || profile.codedDimensions.width <= 0 || profile.codedDimensions.height <= 0)) throw new Error("Invalid coded dimensions");
  if (profile.sampleAspectRatio && (!Number.isSafeInteger(profile.sampleAspectRatio.num) || !Number.isSafeInteger(profile.sampleAspectRatio.den) || profile.sampleAspectRatio.num <= 0 || profile.sampleAspectRatio.den <= 0)) throw new Error("Invalid sample aspect ratio");
  if (profile.rotationDegrees !== undefined && !Number.isFinite(profile.rotationDegrees)) throw new Error("Invalid rotation");
  if (profile.shots.length === 0) throw new Error("EditDNA needs at least one shot");
  let previousEnd = 0;
  for (const shot of profile.shots) {
    if (!Number.isSafeInteger(shot.startFrame) || !Number.isSafeInteger(shot.endFrame) || shot.startFrame !== previousEnd || shot.endFrame <= shot.startFrame || shot.endFrame > profile.durationFrames) {
      throw new Error("Shots must tile the reference in positive, contiguous, half-open frame intervals");
    }
    for (const caption of shot.captionWindows) {
      if (!Number.isSafeInteger(caption.startFrame) || !Number.isSafeInteger(caption.endFrame) || caption.startFrame < shot.startFrame || caption.endFrame > shot.endFrame || caption.endFrame <= caption.startFrame) throw new Error("Invalid caption frame interval");
    }
    let previousMotionFrame = shot.startFrame - 1;
    for (const sample of shot.cameraMotion?.samples ?? []) {
      if (!Number.isSafeInteger(sample.frame) || sample.frame <= previousMotionFrame || sample.frame >= shot.endFrame || ![sample.translateX, sample.translateY, sample.rotationRad, sample.scale].every(Number.isFinite) || sample.scale <= 0) throw new Error("Invalid camera motion sample frame or transform");
      previousMotionFrame = sample.frame;
    }
    if (shot.colorStats && Object.values(shot.colorStats).some((value) => typeof value !== "number" || !Number.isFinite(value))) throw new Error("Invalid reference color statistics");
    previousEnd = shot.endFrame;
  }
  if (previousEnd !== profile.durationFrames) throw new Error("Shots must cover the reference duration");
  if (profile.rhythmCurve.length !== profile.shots.length || profile.rhythmCurve.some((value, i) => value !== shotDurationFrames(profile.shots[i]!))) throw new Error("Rhythm curve must match shot durations in frames");
}

/** Legacy numeric FPS was never authoritative; migration marks its provenance as user-assumed. */
export function parseReferenceProfile(value: unknown, confirmedLegacyFps?: FrameRate): ReferenceProfile {
  if (!value || typeof value !== "object") throw new Error("Invalid EditDNA");
  const record = value as Record<string, unknown>;
  if (record.version === "kove.mirror.v1") {
    if (!confirmedLegacyFps) throw new Error("Legacy EditDNA FPS was assumed, not measured. Explicitly select a rational FPS to migrate it.");
    if (!Array.isArray(record.shots)) throw new Error("Invalid legacy EditDNA");
    const clock = frameRate(confirmedLegacyFps.num, confirmedLegacyFps.den);
    const shots = (record.shots as Array<ShotProfile & { durationSeconds?: number }>).map(({ durationSeconds: _old, ...shot }) => shot);
    return createReferenceProfile({
      fps: clock, fpsSource: "user", durationFrames: shots.at(-1)?.endFrame ?? 0,
      aspectRatio: record.aspectRatio as ReferenceProfile["aspectRatio"], shots,
      beatGridMs: Array.isArray(record.beatGridMs) ? record.beatGridMs as number[] : [],
      warnings: ["Legacy DNA migrated using explicitly selected FPS; verify source cuts."],
    });
  }
  const profile = value as ReferenceProfile;
  validateReferenceProfile(profile);
  return profile;
}

export function serializeReferenceProfile(profile: ReferenceProfile): string {
  validateReferenceProfile(profile);
  return JSON.stringify(profile);
}

/** Convert source seconds only at input boundaries; keep all stored boundaries integer. */
export function quantizeShotBoundaries(seconds: readonly number[], fps: FrameRate, durationFrames: number): number[] {
  const frames = [...new Set([0, ...seconds.map((time) => secondsToFrame(time, fps)), durationFrames])].filter((frame) => frame >= 0 && frame <= durationFrames).sort((a, b) => a - b);
  return frames;
}
