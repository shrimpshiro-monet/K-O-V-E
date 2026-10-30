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

export type ReferenceEvidenceSource =
  | "local-pixel-analysis"
  | "local-ocr"
  | "local-transcription"
  | "vision-model"
  | "human";

export interface ReferenceEvidenceConfidence {
  readonly source: ReferenceEvidenceSource;
  readonly confidence: number;
  readonly note?: string;
}

export interface NormalizedFrameRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ReferenceTransitionEvidence extends ReferenceEvidenceConfidence {
  readonly startFrame: number;
  readonly endFrame: number;
  readonly type: "hard-cut" | "dissolve" | "fade" | "wipe" | "unknown";
}

export interface ReferenceTextStyleEstimate {
  readonly fontFamily?: string;
  readonly fontSizeRatio?: number;
  readonly fontWeight?: number;
  readonly color?: string;
  readonly backgroundColor?: string;
  readonly alignment?: "left" | "center" | "right";
}

export interface ReferenceTextOverlay extends ReferenceEvidenceConfidence {
  readonly startFrame: number;
  readonly endFrame: number;
  readonly bounds: NormalizedFrameRect;
  readonly text?: string;
  readonly style?: ReferenceTextStyleEstimate;
}

export interface ReferenceEffectEvidence extends ReferenceEvidenceConfidence {
  readonly startFrame: number;
  readonly endFrame: number;
  readonly name: string;
  /** Tentative visual estimates, not renderer-ready effect parameters. */
  readonly parameterEstimates?: Readonly<Record<string, number>>;
}

export interface ReferenceStyleEvidence {
  readonly transitions: readonly ReferenceTransitionEvidence[];
  readonly textOverlays: readonly ReferenceTextOverlay[];
  readonly effects: readonly ReferenceEffectEvidence[];
}

/** Media-free reference structure. Pixel/audio samples never enter EditDNA. */
export interface ReferenceProfile {
  version: "kove.mirror.v2" | "kove.mirror.v3";
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
  /** Extended visual evidence. V2 profiles omit this until migrated. */
  styleEvidence?: ReferenceStyleEvidence;
  warnings?: string[];
}

export function createReferenceProfile(input: Omit<ReferenceProfile, "version" | "rhythmCurve" | "durationFrames"> & { durationFrames: number }): ReferenceProfile {
  const profile: ReferenceProfile = {
    ...input,
    version: "kove.mirror.v3",
    styleEvidence: input.styleEvidence ?? { transitions: [], textOverlays: [], effects: [] },
    fps: frameRate(input.fps.num, input.fps.den),
    rhythmCurve: input.shots.map(shotDurationFrames),
  };
  validateReferenceProfile(profile);
  return profile;
}

export function validateReferenceProfile(profile: ReferenceProfile): void {
  if (profile.version !== "kove.mirror.v2" && profile.version !== "kove.mirror.v3") {
    throw new Error("Unsupported EditDNA version");
  }
  if (profile.version === "kove.mirror.v3" && !profile.styleEvidence) {
    throw new Error("EditDNA v3 requires style evidence");
  }
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
  validateStyleEvidence(profile.styleEvidence, profile.durationFrames);
}

export const REFERENCE_PROFILE_V3_LIMITATIONS = [
  "Original overlay layers, exact font identity, and renderer-specific effect parameters cannot be recovered reliably from a flattened video.",
  "Local text detection is browser-dependent and sparsely sampled; measured words, bounds, alignment, and relative size are estimates.",
  "Semantic effect identification is not enabled in the local analyzer; an empty effect list means unmeasured, not effect-free.",
] as const;

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
  if (profile.version === "kove.mirror.v3") return profile;
  const migrated: ReferenceProfile = {
    ...profile,
    version: "kove.mirror.v3",
    styleEvidence: { transitions: [], textOverlays: [], effects: [] },
    warnings: [
      ...(profile.warnings ?? []),
      "EditDNA v2 migrated to v3; text, transition, and effect evidence was not present in the original profile.",
    ],
  };
  validateReferenceProfile(migrated);
  return migrated;
}

export function serializeReferenceProfile(profile: ReferenceProfile): string {
  return JSON.stringify(parseReferenceProfile(profile));
}

function validateStyleEvidence(
  evidence: ReferenceStyleEvidence | undefined,
  durationFrames: number,
): void {
  if (evidence === undefined) return;
  for (const transition of evidence.transitions) {
    validateEvidenceRange(transition, durationFrames, "transition");
    if (!["hard-cut", "dissolve", "fade", "wipe", "unknown"].includes(transition.type)) {
      throw new Error("Invalid transition evidence type");
    }
  }
  for (const overlay of evidence.textOverlays) {
    validateEvidenceRange(overlay, durationFrames, "text overlay");
    const rect = overlay.bounds;
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
        rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 ||
        rect.x + rect.width > 1 || rect.y + rect.height > 1) {
      throw new Error("Text overlay bounds must be normalized to the frame");
    }
    if (overlay.style?.fontSizeRatio !== undefined &&
        (!Number.isFinite(overlay.style.fontSizeRatio) || overlay.style.fontSizeRatio <= 0)) {
      throw new Error("Text overlay font-size ratio must be positive");
    }
    if (overlay.style?.fontWeight !== undefined &&
        (!Number.isFinite(overlay.style.fontWeight) || overlay.style.fontWeight < 100 || overlay.style.fontWeight > 900)) {
      throw new Error("Text overlay font weight must be between 100 and 900");
    }
  }
  for (const effect of evidence.effects) {
    validateEvidenceRange(effect, durationFrames, "effect");
    if (!effect.name.trim()) throw new Error("Effect evidence name cannot be empty");
    if (effect.parameterEstimates &&
        Object.values(effect.parameterEstimates).some((value) => !Number.isFinite(value))) {
      throw new Error("Effect parameter estimates must be finite");
    }
  }
}

function validateEvidenceRange(
  evidence: ReferenceEvidenceConfidence & { readonly startFrame: number; readonly endFrame: number },
  durationFrames: number,
  label: string,
): void {
  if (!Number.isSafeInteger(evidence.startFrame) || !Number.isSafeInteger(evidence.endFrame) ||
      evidence.startFrame < 0 || evidence.endFrame <= evidence.startFrame ||
      evidence.endFrame > durationFrames) {
    throw new Error(`Invalid ${label} evidence frame interval`);
  }
  if (!Number.isFinite(evidence.confidence) || evidence.confidence < 0 || evidence.confidence > 1) {
    throw new Error(`${label} evidence confidence must be between 0 and 1`);
  }
  if (!["local-pixel-analysis", "local-ocr", "local-transcription", "vision-model", "human"].includes(evidence.source)) {
    throw new Error(`Invalid ${label} evidence source`);
  }
}

/** Convert source seconds only at input boundaries; keep all stored boundaries integer. */
export function quantizeShotBoundaries(seconds: readonly number[], fps: FrameRate, durationFrames: number): number[] {
  const frames = [...new Set([0, ...seconds.map((time) => secondsToFrame(time, fps)), durationFrames])].filter((frame) => frame >= 0 && frame <= durationFrames).sort((a, b) => a - b);
  return frames;
}
