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
  | "ffmpeg-scene-score"
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

/**
 * Measured edit event on the reference clock. Every declared event must come
 * from a measurement (scene score, luma excursion, or boundary rescan) — an
 * absent event means "not measured", never "the reference had none".
 */
export interface EditEvent {
  /** Boundary frame on the reference clock (start of the event). */
  frame: number;
  type:
    | "hard-cut"
    | "flash"
    | "dip"
    | "whip"
    | "dissolve"
    | "zoom-punch"
    | "shake-hit"
    | "rgb-split"
    | "blur"
    | "speed-ramp"
    | "split-panel";
  /** Event length in frames (1 for an instantaneous cut). */
  durationFrames: number;
  /** 0..1 measured strength; 1 for a binary cut. */
  intensity: number;
  confidence: number;
  source: ReferenceEvidenceSource;
  /** Nearest music beat when a reliable beat grid exists. */
  beatIndex?: number;
  /** Event frame minus the beat frame, in frames. */
  beatOffsetFrames?: number;
}

export interface EditDensity {
  cutsPerSec: number;
  eventsPerSec: number;
  byType: Record<string, number>;
}

export interface ShotLengthStats {
  median: number;
  p25: number;
  p75: number;
  min: number;
  max: number;
}

/**
 * Measured edit structure over the trimmed edit range (end cards, stingers,
 * and black tails excluded). This is the density/energy contract the compiler
 * and planner must match — genre defaults are not used when this exists.
 */
export interface EditorStructure {
  editRange: { startFrame: number; endFrame: number };
  events: EditEvent[];
  /** Per-second smoothed energy (events + motion), editRange.length entries. */
  energyCurve: number[];
  density: EditDensity;
  shotLengths: ShotLengthStats;
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
  /** Measured edit structure (events, energy, density, shot lengths). */
  structure?: EditorStructure;
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
  if (profile.structure) {
    const structure = profile.structure;
    const { startFrame, endFrame } = structure.editRange;
    if (!Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame) || startFrame < 0 || endFrame <= startFrame || endFrame > profile.durationFrames) {
      throw new Error("Edit structure editRange must be a half-open interval within the reference duration");
    }
    for (const event of structure.events) {
      if (!Number.isSafeInteger(event.frame) || event.frame <= startFrame || event.frame > endFrame) {
        throw new Error("Edit event frame must fall inside the edit range");
      }
      if (!Number.isSafeInteger(event.durationFrames) || event.durationFrames <= 0) throw new Error("Edit event duration must be positive");
      if (![event.intensity, event.confidence].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
        throw new Error("Edit event intensity/confidence must be between 0 and 1");
      }
      if (!["hard-cut", "flash", "dip", "whip", "dissolve", "zoom-punch", "shake-hit", "rgb-split", "blur", "speed-ramp", "split-panel"].includes(event.type)) {
        throw new Error("Invalid edit event type");
      }
      if (!["local-pixel-analysis", "ffmpeg-scene-score", "local-ocr", "local-transcription", "vision-model", "human"].includes(event.source)) {
        throw new Error("Invalid edit event source");
      }
    }
    if (structure.energyCurve.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("Energy curve values must be non-negative and finite");
    if (![structure.density.cutsPerSec, structure.density.eventsPerSec].every((value) => Number.isFinite(value) && value >= 0)) throw new Error("Density must be non-negative and finite");
  }
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
  if (!["local-pixel-analysis", "ffmpeg-scene-score", "local-ocr", "local-transcription", "vision-model", "human"].includes(evidence.source)) {
    throw new Error(`Invalid ${label} evidence source`);
  }
}

/** Convert source seconds only at input boundaries; keep all stored boundaries integer. */
export function quantizeShotBoundaries(seconds: readonly number[], fps: FrameRate, durationFrames: number): number[] {
  const frames = [...new Set([0, ...seconds.map((time) => secondsToFrame(time, fps)), durationFrames])].filter((frame) => frame >= 0 && frame <= durationFrames).sort((a, b) => a - b);
  return frames;
}

const CUT_EVENT_TYPES = new Set(["hard-cut", "whip"]);

/**
 * Compile measured evidence into the EditorStructure events/density/energy
 * model. Deterministic: identical evidence always yields identical structure.
 * Transition evidence types that the analyzer cannot distinguish (ffmpeg scene
 * candidates) are classified by matching flash/dip luma excursions; anything
 * left is a hard-cut candidate with reduced confidence. Event types with no
 * detector yet (whip, zoom-punch, shake-hit, rgb-split, blur, speed-ramp,
 * split-panel) are simply absent — they are never invented here.
 */
export function buildEditorStructure(
  input: Pick<ReferenceProfile, "shots" | "styleEvidence" | "fps" | "durationFrames"> & {
    editRange?: { startFrame: number; endFrame: number };
  },
): EditorStructure {
  const fpsNumber = input.fps.num / input.fps.den;
  const editRange = input.editRange
    ? { startFrame: Math.max(0, Math.min(input.editRange.startFrame, input.durationFrames)), endFrame: Math.max(1, Math.min(input.editRange.endFrame, input.durationFrames)) }
    : { startFrame: 0, endFrame: input.durationFrames };

  const lumaExcursionAt = new Map<number, { type: "flash" | "dip"; evidence: ReferenceEffectEvidence }>();
  for (const effect of input.styleEvidence?.effects ?? []) {
    if (effect.name !== "flash" && effect.name !== "dip") continue;
    lumaExcursionAt.set(effect.startFrame, { type: effect.name, evidence: effect });
  }

  const events: EditEvent[] = [];
  for (const transition of input.styleEvidence?.transitions ?? []) {
    // Transition evidence is the half-open range [startFrame, endFrame) around
    // the boundary; the event frame is the first frame after the boundary.
    const frame = transition.startFrame + 1;
    if (frame <= editRange.startFrame || frame > editRange.endFrame) continue;
    const excursion = lumaExcursionAt.get(frame) ?? lumaExcursionAt.get(transition.startFrame);
    if (excursion) {
      events.push({
        frame,
        type: excursion.type,
        durationFrames: Math.max(1, excursion.evidence.endFrame - excursion.evidence.startFrame),
        intensity: clamp01(Math.abs(excursion.evidence.parameterEstimates?.brightness ?? 100) / 100),
        confidence: Math.min(transition.confidence, excursion.evidence.confidence),
        source: transition.source,
      });
      continue;
    }
    if (transition.type === "dissolve" || transition.type === "fade") {
      events.push({
        frame,
        type: "dissolve",
        durationFrames: Math.max(2, transition.endFrame - transition.startFrame),
        intensity: 1,
        confidence: transition.confidence,
        source: transition.source,
      });
      continue;
    }
    // "unknown" scene-score candidates and "hard-cut" boundaries are both cut
    // candidates; the unknown ones keep their reduced measurement confidence.
    events.push({
      frame,
      type: "hard-cut",
      durationFrames: 1,
      intensity: 1,
      confidence: transition.type === "unknown" ? Math.min(transition.confidence, 0.6) : transition.confidence,
      source: transition.source,
    });
  }

  // Stand-alone luma excursions that did not coincide with a cut boundary.
  for (const [frame, excursion] of lumaExcursionAt) {
    if (frame <= editRange.startFrame || frame > editRange.endFrame) continue;
    if (events.some((event) => Math.abs(event.frame - frame) <= 1)) continue;
    events.push({
      frame,
      type: excursion.type,
      durationFrames: Math.max(1, excursion.evidence.endFrame - excursion.evidence.startFrame),
      intensity: clamp01(Math.abs(excursion.evidence.parameterEstimates?.brightness ?? 100) / 100),
      confidence: excursion.evidence.confidence,
      source: excursion.evidence.source,
    });
  }

  events.sort((left, right) => left.frame - right.frame || left.type.localeCompare(right.type));

  const rangeSeconds = Math.max(1, (editRange.endFrame - editRange.startFrame) / fpsNumber);
  const byType: Record<string, number> = {};
  let cuts = 0;
  for (const event of events) {
    byType[event.type] = (byType[event.type] ?? 0) + 1;
    if (CUT_EVENT_TYPES.has(event.type)) cuts += 1;
  }

  const energyCurve = buildEnergyCurve(input, events, editRange);

  return {
    editRange,
    events,
    energyCurve,
    density: {
      cutsPerSec: cuts / rangeSeconds,
      eventsPerSec: events.length / rangeSeconds,
      byType,
    },
    shotLengths: shotLengthStats(input.shots, editRange),
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Per-second energy over the edit range: normalized event pressure blended
 * with measured camera-motion magnitude, then smoothed with a 3-tap kernel.
 */
function buildEnergyCurve(
  input: Pick<ReferenceProfile, "shots" | "fps">,
  events: EditEvent[],
  editRange: { startFrame: number; endFrame: number },
): number[] {
  const fpsNumber = input.fps.num / input.fps.den;
  const seconds = Math.max(1, Math.round((editRange.endFrame - editRange.startFrame) / fpsNumber));

  const eventPressure = new Array<number>(seconds).fill(0);
  for (const event of events) {
    const index = Math.min(seconds - 1, Math.max(0, Math.floor((event.frame - editRange.startFrame) / fpsNumber)));
    eventPressure[index] += 0.5 + 0.5 * event.intensity;
  }
  let maxPressure = Math.max(...eventPressure, 1);

  // Motion magnitude per second from the camera-motion samples.
  const motionEnergy = new Array<number>(seconds).fill(0);
  const motionSamplesPerSecond = new Array<number>(seconds).fill(0);
  for (const shot of input.shots) {
    const samples = shot.cameraMotion?.samples ?? [];
    for (let i = 1; i < samples.length; i++) {
      const frame = samples[i]!.frame;
      if (frame <= editRange.startFrame || frame > editRange.endFrame) continue;
      const previous = samples[i - 1]!;
      const magnitude = Math.abs(samples[i]!.translateX - previous.translateX) +
        Math.abs(samples[i]!.translateY - previous.translateY) +
        Math.abs(samples[i]!.rotationRad - previous.rotationRad) +
        Math.abs(samples[i]!.scale - previous.scale);
      const index = Math.min(seconds - 1, Math.max(0, Math.floor((frame - editRange.startFrame) / fpsNumber)));
      motionEnergy[index] += magnitude;
      motionSamplesPerSecond[index] += 1;
    }
  }
  for (let i = 0; i < seconds; i++) {
    if (motionSamplesPerSecond[i]! > 0) motionEnergy[i] /= motionSamplesPerSecond[i]!;
  }
  const maxMotion = Math.max(...motionEnergy, 1);

  const raw = eventPressure.map((pressure, i) =>
    0.6 * (pressure / maxPressure) + 0.4 * (motionEnergy[i]! / maxMotion),
  );
  const smoothed: number[] = [];
  for (let i = 0; i < seconds; i++) {
    const previous = raw[Math.max(0, i - 1)]!;
    const next = raw[Math.min(seconds - 1, i + 1)]!;
    smoothed.push(0.25 * previous + 0.5 * raw[i]! + 0.25 * next);
  }
  return smoothed.map((value) => Math.round(value * 1000) / 1000);
}

/** Nearest-rank quantiles of shot lengths inside the edit range. */
export function shotLengthStats(shots: readonly ShotProfile[], editRange: { startFrame: number; endFrame: number }): ShotLengthStats {
  const lengths = shots
    .filter((shot) => shot.endFrame > editRange.startFrame && shot.startFrame < editRange.endFrame)
    .map((shot) => Math.min(shot.endFrame, editRange.endFrame) - Math.max(shot.startFrame, editRange.startFrame))
    .filter((length) => length > 0)
    .sort((left, right) => left - right);
  if (lengths.length === 0) return { median: 0, p25: 0, p75: 0, min: 0, max: 0 };
  const at = (fraction: number): number => lengths[Math.min(lengths.length - 1, Math.floor(fraction * lengths.length))]!;
  return {
    min: lengths[0]!,
    max: lengths[lengths.length - 1]!,
    median: at(0.5),
    p25: at(0.25),
    p75: at(0.75),
  };
}
