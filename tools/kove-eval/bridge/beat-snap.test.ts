/**
 * Craft-eval bridge: lets the Python harness call production planner code.
 *
 * The harness could reimplement beat snapping in Python in twenty lines. It
 * deliberately does not: `snapPlanToBeatGrid` is the algorithm that ships, and a
 * scorecard that measures a different algorithm is measuring nothing. So the
 * harness writes a job to disk, runs this file through the repo's own vitest, and
 * reads the answer back.
 *
 *   KOVE_CRAFT_JOB=/path/to/job.json   (in)
 *   KOVE_CRAFT_OUT=/path/to/out.json   (out)
 *
 * Operations:
 *   snap    — snapPlanToBeatGrid(plan, segmentMap, options) → {plan, report}
 *   measure — measureTimelineBeatAlignment(plan, grid, subdivisionBeats) → number|null
 *   grid    — resolveTimelineBeatGrid(plan, segmentMap, options) → TimelineBeatGrid|null
 *   align   — cut times against a beat list, using the shipped tolerance
 *   detect-beats — run the product's own BeatDetectionEngine over a wav and
 *             report its beats, intervals and offset from known-true beats
 *
 * Run with:
 *   cd packages/creation-schema
 *   ./node_modules/.bin/vitest run --config vitest.craft.config.ts
 */
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import {
  BEAT_TOLERANCE_SECONDS,
  beatGridPoints,
  inferSubdivisionBeats,
  measureTimelineBeatAlignment,
  resolveTimelineBeatGrid,
  snapPlanToBeatGrid,
  type TimelineBeatGrid,
} from "../../../packages/creation-schema/src/director/beat-snap";
import type { EditPlan } from "../../../packages/creation-schema/src/director/edit-plan";
import type { SegmentMap } from "../../../packages/creation-schema/src/director/segment-map";

interface Job {
  readonly op: "snap" | "measure" | "grid" | "align" | "points" | "detect-beats";
  readonly plan?: EditPlan;
  readonly segmentMap?: SegmentMap;
  readonly options?: {
    readonly cutOffsetSeconds?: number;
    readonly subdivisionBeats?: number;
    readonly referenceShotLengthsInBeats?: readonly number[];
  };
  /** `align`: explicit cut times to judge. */
  readonly cuts?: readonly number[];
  /** `measure`/`points`: an explicit grid to judge against. */
  readonly grid?: TimelineBeatGrid | null;
  /** `detect-beats`: a 16-bit mono PCM wav to analyse. */
  readonly wav?: string;
  /** `detect-beats`: the true beat times, to measure the detector against. */
  readonly truthBeats?: readonly number[];
}

/** Nearest grid distance and signed offset, mirroring the shipped tolerance. */
function judgeCuts(cuts: readonly number[], points: readonly number[]) {
  const offsets: number[] = [];
  if (points.length > 0) {
    for (const cut of cuts) {
      let best = Number.POSITIVE_INFINITY;
      let bestPoint = points[0]!;
      for (const point of points) {
        const distance = Math.abs(point - cut);
        if (distance < best) {
          best = distance;
          bestPoint = point;
        }
      }
      offsets.push(cut - bestPoint);
    }
  }
  const onBeat = offsets.filter((o) => Math.abs(o) <= BEAT_TOLERANCE_SECONDS).length;
  const sorted = [...offsets].sort((a, b) => a - b);
  const median = sorted.length
    ? sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2]!
      : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2
    : null;
  return {
    toleranceSeconds: BEAT_TOLERANCE_SECONDS,
    evaluated: cuts.length,
    onBeat,
    onBeatRatio: cuts.length ? onBeat / cuts.length : null,
    medianOffsetSeconds: median,
    meanAbsOffsetSeconds: offsets.length
      ? offsets.reduce((sum, o) => sum + Math.abs(o), 0) / offsets.length
      : null,
    pointsCount: points.length,
  };
}

/**
 * Read a 16-bit mono PCM wav into the Float32Array the detector expects.
 *
 * Chunks are walked rather than assumed at offset 44 — ffmpeg writes a LIST chunk
 * for some encoders, and a blind 44-byte skip then decodes metadata as audio.
 */
function readWavMono(path: string): { samples: Float32Array; sampleRate: number } {
  const buffer = readFileSync(path);
  let offset = 12;
  let sampleRate = 0;
  let data: Buffer | null = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      sampleRate = buffer.readUInt32LE(body + 4);
      const channels = buffer.readUInt16LE(body + 2);
      if (channels !== 1) throw new Error(`expected mono, got ${channels} channels`);
    } else if (id === "data") {
      data = buffer.subarray(body, Math.min(body + size, buffer.length));
    }
    offset = body + size + (size % 2);
  }
  if (!data) throw new Error(`no data chunk in ${path}`);
  const count = Math.floor(data.length / 2);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) samples[i] = data.readInt16LE(i * 2) / 32768;
  return { samples, sampleRate };
}

/**
 * Run the PRODUCT's beat detector over a known-pulse track.
 *
 * The scorecard can measure the Python engine's tracker, but that is not the
 * tracker the product uses. `BeatDetectionEngine` is, and until this op existed
 * nobody had measured its phase error against a pulse that is known exactly. The
 * engine wants an `AudioBuffer`; a channel array plus a sample rate is all the
 * analysis path actually reads, so that is what it gets.
 */
async function detectBeats(wavPath: string, truthBeats: readonly number[]) {
  const { samples, sampleRate } = readWavMono(wavPath);
  const { BeatDetectionEngine } = await import(
    "../../../packages/core/src/audio/beat-detection-engine"
  );
  const engine = new BeatDetectionEngine();
  const fakeBuffer = {
    getChannelData: () => samples,
    sampleRate,
    duration: samples.length / sampleRate,
    length: samples.length,
    numberOfChannels: 1,
  } as unknown as AudioBuffer;
  // Reach into the private onset detector. It is the layer where a silent
  // failure actually happens: `analyzeAudioBuffer` returns a confident-looking
  // grid whether it found 200 onsets or none, because `generateBeats` falls back
  // to a fixed 120 BPM metronome when there are no onsets at all. Reporting the
  // count is the difference between measuring that and guessing at it.
  const internal = engine as unknown as {
    detectOnsets: (data: Float32Array, rate: number) => number[];
    config: { windowSize: number; hopSize: number; sensitivity: number };
  };
  let onsetCount: number | null = null;
  let onsets: number[] = [];
  try {
    onsets = internal.detectOnsets(samples, sampleRate);
    onsetCount = onsets.length;
  } catch {
    onsetCount = null;
  }

  const result = await engine.analyzeAudioBuffer(fakeBuffer);

  const detected = result.beats.map((beat) => beat.time);
  const gaps: number[] = [];
  for (let i = 1; i < detected.length; i++) gaps.push(detected[i]! - detected[i - 1]!);
  const meanGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const medianGap = sortedGaps.length ? sortedGaps[Math.floor(sortedGaps.length / 2)]! : 0;

  // Phase: the distance from each detected beat to the nearest true beat. A
  // correct tempo with a wrong phase shows up here and nowhere else.
  let nearest: number[] = [];
  if (truthBeats.length > 0) {
    nearest = detected.map((time) => {
      let best = Number.POSITIVE_INFINITY;
      for (const truth of truthBeats) {
        const distance = Math.abs(truth - time);
        if (distance < best) best = distance;
      }
      return time - truthBeats.reduce((closest, truth) =>
        Math.abs(truth - time) < Math.abs(closest - time) ? truth : closest,
      truthBeats[0]!);
    });
  }
  const sortedOffsets = [...nearest].sort((a, b) => a - b);
  const medianOffset = sortedOffsets.length
    ? sortedOffsets[Math.floor(sortedOffsets.length / 2)]!
    : null;
  const onTrueBeat = nearest.filter((o) => Math.abs(o) <= BEAT_TOLERANCE_SECONDS).length;

  return {
    detectedBpm: result.bpm,
    confidence: result.confidence,
    beats: detected,
    beatCount: detected.length,
    onsetCount,
    firstOnsets: onsets.slice(0, 6),
    config: internal.config,
    meanIntervalSeconds: meanGap,
    medianIntervalSeconds: medianGap,
    bpmFromMeanInterval: meanGap > 0 ? 60 / meanGap : null,
    bpmFromMedianInterval: medianGap > 0 ? 60 / medianGap : null,
    firstBeats: detected.slice(0, 6),
    truthBeatCount: truthBeats.length,
    medianOffsetToTruthSeconds: medianOffset,
    meanAbsOffsetToTruthSeconds: nearest.length
      ? nearest.reduce((sum, o) => sum + Math.abs(o), 0) / nearest.length
      : null,
    onTrueBeatRatio: nearest.length ? onTrueBeat / nearest.length : null,
    downbeats: result.downbeats.slice(0, 4),
  };
}

describe("craft bridge", () => {
  const jobPath = process.env.KOVE_CRAFT_JOB;
  const outPath = process.env.KOVE_CRAFT_OUT;

  it.runIf(Boolean(jobPath))("runs the requested operation", async () => {
    expect(outPath, "KOVE_CRAFT_OUT must be set alongside KOVE_CRAFT_JOB").toBeTruthy();
    const job = JSON.parse(readFileSync(jobPath!, "utf8")) as Job;
    const options = job.options ?? {};

    let payload: unknown;
    switch (job.op) {
      case "snap": {
        const plan = job.plan as EditPlan;
        const requestedUnit = inferSubdivisionBeats(
          options.referenceShotLengthsInBeats ?? [],
          options.subdivisionBeats ?? 1,
        );
        const grid = resolveTimelineBeatGrid(plan, job.segmentMap, options);
        const result = snapPlanToBeatGrid(plan, job.segmentMap, options);
        payload = {
          plan: result.plan,
          report: result.report,
          requestedUnit,
          grid,
        };
        break;
      }
      case "measure": {
        payload = {
          onBeatRatio: measureTimelineBeatAlignment(
            job.plan as EditPlan,
            job.grid ?? null,
            options.subdivisionBeats ?? 1,
          ),
        };
        break;
      }
      case "grid": {
        payload = {
          grid: resolveTimelineBeatGrid(job.plan as EditPlan, job.segmentMap, options),
        };
        break;
      }
      case "points": {
        const grid = job.grid ?? null;
        payload = {
          points: grid ? beatGridPoints(grid, options.subdivisionBeats ?? 1) : [],
        };
        break;
      }
      case "align": {
        const grid = job.grid ?? null;
        const points = grid ? beatGridPoints(grid, options.subdivisionBeats ?? 1) : [];
        payload = judgeCuts(job.cuts ?? [], points);
        break;
      }
      case "detect-beats": {
        payload = await detectBeats(job.wav!, job.truthBeats ?? []);
        break;
      }
      default:
        throw new Error(`unknown op: ${String(job.op)}`);
    }

    writeFileSync(outPath!, JSON.stringify(payload, null, 2));
    expect(payload).toBeTruthy();
  });

  it("always exposes the shipped tolerance", () => {
    // Guards against a silent change to the tolerance the scorecard reports
    // against: the harness reads it from here, so the two cannot drift apart.
    expect(BEAT_TOLERANCE_SECONDS).toBeCloseTo(0.04, 6);
  });
});
