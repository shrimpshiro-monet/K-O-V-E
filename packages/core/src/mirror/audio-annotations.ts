import { secondsToFrame } from "./timebase";
import { createReferenceProfile, type ReferenceProfile } from "./reference-profile";

/** Word-level timing in seconds from the reference start, as reported by the
 * local transcription worker. Pure data: no audio bytes enter EditDNA. */
export interface ReferenceWordTiming {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface AudioAnnotationInput {
  readonly words: readonly ReferenceWordTiming[];
  /** Beat times in milliseconds from the reference start. */
  readonly beatsMs: readonly number[];
}

export interface AudioAnnotationResult {
  readonly profile: ReferenceProfile;
  /** Words discarded because their timing was malformed, outside the
   * reference, or quantized to a zero-length frame window. */
  readonly droppedWords: number;
}

/** Attach transcribed word timings and a detected beat grid to a measured
 * profile. Pure: the caller supplies already-analyzed timings, so this stays
 * unit-testable without audio decode, workers, or WASM.
 *
 * - Each word becomes one caption window on the shot containing its start
 *   frame, clipped to that shot's bounds (words may span a cut).
 * - Beat times are deduplicated, trimmed to the reference duration, and sorted.
 * - The result is re-validated by createReferenceProfile. */
export function applyAudioAnnotations(
  profile: ReferenceProfile,
  input: AudioAnnotationInput,
): AudioAnnotationResult {
  const fps = profile.fps;
  const durationSeconds = (profile.durationFrames * fps.den) / fps.num;
  let droppedWords = 0;
  const windowsByShot = new Map<number, Array<{ startFrame: number; endFrame: number; text: string }>>();

  for (const word of input.words) {
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.end <= word.start) {
      droppedWords++;
      continue;
    }
    // Floor the start and ceil the end so the window always covers the word.
    const quantizedStart = Math.max(0, secondsToFrame(word.start, fps, "floor"));
    const quantizedEnd = Math.min(profile.durationFrames, secondsToFrame(word.end, fps, "ceil"));
    if (quantizedEnd <= quantizedStart) {
      droppedWords++;
      continue;
    }
    const shotIndex = profile.shots.findIndex(
      (shot) => quantizedStart >= shot.startFrame && quantizedStart < shot.endFrame,
    );
    if (shotIndex < 0) {
      droppedWords++;
      continue;
    }
    const shot = profile.shots[shotIndex]!;
    const startFrame = Math.max(quantizedStart, shot.startFrame);
    const endFrame = Math.min(quantizedEnd, shot.endFrame);
    if (endFrame <= startFrame) {
      droppedWords++;
      continue;
    }
    const text = word.text.trim();
    const windows = windowsByShot.get(shotIndex) ?? [];
    // Whisper can emit overlapping chunks; keep exact duplicates out.
    if (!windows.some((w) => w.startFrame === startFrame && w.endFrame === endFrame && w.text === text)) {
      windows.push({ startFrame, endFrame, text });
    }
    windowsByShot.set(shotIndex, windows);
  }

  const beatGridMs = [...new Set(input.beatsMs.filter((time) => Number.isFinite(time) && time >= 0 && time < durationSeconds * 1000))].sort((a, b) => a - b);

  const shots = profile.shots.map((shot, index) => ({
    ...shot,
    captionWindows: (windowsByShot.get(index) ?? []).sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame),
  }));

  const annotated = createReferenceProfile({
    fps: profile.fps,
    fpsSource: profile.fpsSource,
    durationFrames: profile.durationFrames,
    aspectRatio: profile.aspectRatio,
    shots,
    beatGridMs,
    ...(profile.sampleAspectRatio && { sampleAspectRatio: profile.sampleAspectRatio }),
    ...(profile.codedDimensions && { codedDimensions: profile.codedDimensions }),
    ...(profile.rotationDegrees !== undefined && { rotationDegrees: profile.rotationDegrees }),
    ...(profile.warnings && { warnings: profile.warnings }),
  });
  return { profile: annotated, droppedWords };
}
