import { getBeatDetectionEngine } from "@kove-advanced/core";
import { applyAudioAnnotations, type ReferenceWordTiming } from "@kove-advanced/core/mirror/audio-annotations";
import type { ReferenceProfile } from "@kove-advanced/core/mirror/reference-profile";
import { transcribeWithWordTimestamps } from "../multicam-transcription";

/** Enrich a measured reference profile with its audio-derived annotations:
 * caption windows (local Whisper word timings) and a beat grid (local beat
 * detection). Never throws and never blocks the measured profile: any stage
 * that fails degrades to a warning so cut/motion/color extraction stands.
 *
 * All analysis is local — word timings and beat times are numbers; no audio
 * bytes enter the EditDNA artifact. */
/**
 * How long the local transcription may take before the reference is used
 * without caption windows. The Whisper model is fetched from a remote host; a
 * host that accepts the connection but never answers would otherwise block
 * the whole reference turn forever.
 */
const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 180_000;

/**
 * Bounds a promise that may never settle. The transcription worker is
 * terminated by its own timeout; this is the outer guarantee that the
 * reference workflow always moves on, whatever the worker does.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function enrichReferenceWithAudio(
  file: Blob,
  profile: ReferenceProfile,
  options: {
    language?: string;
    onStatus?: (message: string) => void;
    /** Overrides the transcription ceiling (tests use a short one). */
    transcriptionTimeoutMs?: number;
  } = {},
): Promise<ReferenceProfile> {
  const baseWarnings = profile.warnings ?? [];
  let audioBuffer: AudioBuffer;
  try {
    const context = new AudioContext();
    try {
      audioBuffer = await context.decodeAudioData(await file.arrayBuffer());
    } finally {
      void context.close();
    }
  } catch {
    return {
      ...profile,
      warnings: [...baseWarnings, "Reference audio could not be decoded; caption windows and the beat grid were not extracted."],
    };
  }

  const stageWarnings: string[] = [];
  let beatsMs: number[] = [];
  try {
    options.onStatus?.("Detecting beats in the reference audio…");
    const analysis = await getBeatDetectionEngine().analyzeAudioBuffer(audioBuffer);
    beatsMs = analysis.beats.map((beat) => Math.round(beat.time * 1_000));
    if (analysis.confidence < 0.3 && beatsMs.length > 0) {
      stageWarnings.push(`Beat grid confidence is low (bpm ${Math.round(analysis.bpm)}); cut-to-beat scoring may be unreliable.`);
    }
  } catch {
    stageWarnings.push("Beat detection failed; the beat grid was left empty.");
  }

  let words: ReferenceWordTiming[] = [];
  const transcriptionTimeoutMs =
    options.transcriptionTimeoutMs ?? DEFAULT_TRANSCRIPTION_TIMEOUT_MS;
  try {
    options.onStatus?.("Transcribing reference audio locally for caption windows…");
    words = await withTimeout(
      transcribeWithWordTimestamps(audioBuffer, {
        model: "fast",
        language: options.language,
        onStatus: options.onStatus,
        timeoutMs: transcriptionTimeoutMs,
      }),
      transcriptionTimeoutMs,
      `timed out after ${Math.round(transcriptionTimeoutMs / 1000)}s`,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    stageWarnings.push(
      `Local transcription failed (${reason}); caption windows were not extracted.`,
    );
  }

  const { profile: annotated, droppedWords } = applyAudioAnnotations(profile, { words, beatsMs });
  if (droppedWords > 0) {
    stageWarnings.push(`${droppedWords} transcribed word(s) fell outside the reference or quantized to zero-length windows and were dropped.`);
  }
  return { ...annotated, warnings: [...(annotated.warnings ?? []), ...stageWarnings] };
}
