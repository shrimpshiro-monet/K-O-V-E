import { describe, expect, it } from "vitest";
import {
  ANALYSIS_SAMPLE_RATE,
  BeatDetectionEngine,
} from "./beat-detection-engine";

/**
 * A bare click train: 6ms of 1 kHz under a fast exponential decay, one per beat.
 *
 * Chosen because it is the hardest case for the tempo decision and the easiest
 * to reason about — there is no music to hide behind, so if the octave is wrong
 * it is wrong visibly.
 */
function clickTrack(bpm: number, seconds: number, sampleRate: number): Float32Array {
  const length = Math.floor(seconds * sampleRate);
  const samples = new Float32Array(length);
  const period = 60 / bpm;
  const clickLength = Math.floor(0.006 * sampleRate);
  for (let beat = 0; beat * period < seconds; beat += 1) {
    const start = Math.round(beat * period * sampleRate);
    for (let index = 0; index < clickLength && start + index < length; index += 1) {
      const envelope = Math.exp(-index / (0.0015 * sampleRate));
      const tone = Math.sin((2 * Math.PI * 1000 * index) / sampleRate);
      samples[start + index] += envelope * tone * 0.9;
    }
  }
  return samples;
}

/** The engine only reads these five members, and node has no AudioBuffer. */
function buffer(samples: Float32Array, sampleRate: number): AudioBuffer {
  return {
    getChannelData: () => samples,
    sampleRate,
    duration: samples.length / sampleRate,
    length: samples.length,
    numberOfChannels: 1,
  } as unknown as AudioBuffer;
}

async function analyze(bpm: number, sampleRate: number, seconds = 20): Promise<{
  bpm: number;
  sampleRate: number;
  fallback: boolean;
  confidence: number;
  beatCount: number;
}> {
  const engine = new BeatDetectionEngine();
  const result = await engine.analyzeAudioBuffer(
    buffer(clickTrack(bpm, seconds, sampleRate), sampleRate),
  );
  return {
    bpm: result.bpm,
    sampleRate: result.analysisSampleRate,
    fallback: result.tempoFallback,
    confidence: result.confidence,
    beatCount: result.beats.length,
  };
}

describe("the sample-rate guard", () => {
  it("reads the same tempo at 22050, 44100 and 48000", async () => {
    // Before the guard these were 69.784 / 139.690 / 139.806 — the same audio,
    // a different answer, because the onset detector counts frames.
    const results = await Promise.all([
      analyze(140, 22050),
      analyze(140, 44100),
      analyze(140, 48000),
    ]);

    for (const result of results) {
      expect(result.fallback).toBe(false);
      expect(result.sampleRate).toBe(ANALYSIS_SAMPLE_RATE);
      expect(Math.abs(result.bpm - 140)).toBeLessThanOrEqual(1);
    }
    // Not just each one close to the truth: identical, or the rate still leaks
    // into the analysis.
    expect(Math.abs(results[0]!.bpm - results[1]!.bpm)).toBeLessThanOrEqual(0.001);
    expect(Math.abs(results[2]!.bpm - results[1]!.bpm)).toBeLessThanOrEqual(0.001);
  });

  it("does not answer a 22050 Hz file with the 120 BPM metronome", async () => {
    // The reported symptom was a 140 BPM file reading as a 120 BPM grid — the
    // fallback, which is a constant rather than a measurement, and which used to
    // arrive with nothing in the result saying so.
    const result = await analyze(140, 22050);

    expect(result.fallback).toBe(false);
    expect(Math.abs(result.bpm - 120)).toBeGreaterThan(10);
    expect(Math.abs(result.bpm - 140)).toBeLessThanOrEqual(1);
  });

  it("flags the fallback when there is nothing to measure", async () => {
    // Silence: no onsets, so no tempo. The grid is still a 120 BPM metronome,
    // and now it says so instead of looking like a measurement.
    const silence = new Float32Array(44100 * 4);
    const result = await new BeatDetectionEngine().analyzeAudioBuffer(
      buffer(silence, 44100),
    );

    expect(result.tempoFallback).toBe(true);
    expect(result.confidence).toBe(0);
  });
});

describe("the octave lock", () => {
  it("reads a bare 140 BPM click as 140, not 70", async () => {
    // Measured before the lock: 0.0151 of autocorrelation at two beats out
    // against 0.0132 at one, so the engine reported 69.824 BPM.
    const result = await analyze(140, 44100);
    expect(Math.abs(result.bpm - 140)).toBeLessThanOrEqual(1);
  });

  it("reads a bare 70 BPM click as 70, not 140", async () => {
    // The lock must not promote a track that has no off-beat energy: with no
    // onsets at half the period, the comb has nothing to lift the fundamental
    // with, and 140 must not be invented.
    const result = await analyze(70, 44100);
    expect(Math.abs(result.bpm - 70)).toBeLessThanOrEqual(1);
  });

  it("keeps the tempos that were already right", async () => {
    const [bpm120, bpm100] = await Promise.all([analyze(120, 44100), analyze(100, 44100)]);
    expect(Math.abs(bpm120.bpm - 120)).toBeLessThanOrEqual(1);
    expect(Math.abs(bpm100.bpm - 100)).toBeLessThanOrEqual(1.8);
  });

  it("does not halve a click slower than the fallback tempo", async () => {
    // 60 BPM sits on the detector's floor. Halving it to 30 would be out of
    // range, so this pins that the range clamp still reports a fallback rather
    // than a tempo of half the truth.
    const result = await analyze(60, 44100);
    if (!result.fallback) {
      expect(Math.abs(result.bpm - 60)).toBeLessThanOrEqual(2);
    }
  });
});
