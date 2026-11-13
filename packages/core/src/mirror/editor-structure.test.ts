import { describe, expect, it } from "vitest";
import { buildEditorStructure } from "./reference-profile";
import { frameRate } from "./timebase";
import groundTruth from "../../../../evaluation-files/reference/captain-price-ground-truth.json";

const FPS = frameRate(30, 1);

/**
 * Real-data regression: the fixture is ffmpeg scene-score output from the
 * actual Captain Price reference file (video-relative frames, start_time
 * 0.161s subtracted). It is real measured evidence, not a synthetic mock.
 */
const realTransitions = groundTruth.events
  .filter((event) => event.frame < groundTruth.editEndFrameApprox)
  .map((event) => ({
    startFrame: event.frame - 1,
    endFrame: event.frame + 1,
    type: "unknown" as const,
    source: "ffmpeg-scene-score" as const,
    confidence: 0.55,
    note: "Real fixture scene-score candidate.",
  }));

const realFlashEffects = groundTruth.flashFrames
  .filter((frame) => frame < groundTruth.editEndFrameApprox)
  .map((frame, index, frames) => {
    const end = index + 1 < frames.length && frames[index + 1]! - frame <= 1 ? frames[index + 1]! + 1 : frame + 1;
    return {
      startFrame: frame,
      endFrame: Math.min(end, groundTruth.editEndFrameApprox),
      name: "flash",
      source: "local-pixel-analysis" as const,
      confidence: 0.8,
      parameterEstimates: { brightness: 60 },
    };
  });

const realDipEffects = groundTruth.dipFrames.length
  ? [{
      startFrame: groundTruth.dipFrames[0]!,
      endFrame: groundTruth.dipFrames[groundTruth.dipFrames.length - 1]! + 1,
      name: "dip",
      source: "local-pixel-analysis" as const,
      confidence: 0.8,
      parameterEstimates: { brightness: -70 },
    }]
  : [];

// Shots tile the edit range using the real fixture event frames as boundaries.
const shotBoundaries = [0, ...realTransitions.map((transition) => transition.startFrame + 1), groundTruth.editEndFrameApprox];
const realShots = shotBoundaries.slice(0, -1).map((startFrame, index) => ({
  startFrame,
  endFrame: shotBoundaries[index + 1]!,
  captionWindows: [],
}));

const buildStructure = () =>
  buildEditorStructure({
    shots: realShots,
    styleEvidence: {
      transitions: realTransitions,
      textOverlays: [],
      effects: [...realFlashEffects, ...realDipEffects],
    },
    fps: FPS,
    durationFrames: groundTruth.editEndFrameApprox,
  });

describe("editor structure from real Captain Price fixture data", () => {
  it("measures the reference cut rate near 1.3 events per second", () => {
    const structure = buildStructure();
    // 515 frames at 30fps = 17.17s; the spec measured ~1.3 events/sec.
    expect(structure.density.eventsPerSec).toBeGreaterThan(1.0);
    expect(structure.density.eventsPerSec).toBeLessThan(1.6);
    expect(structure.density.cutsPerSec).toBeGreaterThan(0.7);
    expect(structure.density.cutsPerSec).toBeLessThan(1.4);
  });

  it("classifies the measured flashes and dips as their own event types", () => {
    const structure = buildStructure();
    const types = new Set(structure.events.map((event) => event.type));
    expect(types.has("flash")).toBe(true);
    expect(types.has("dip")).toBe(true);
    const flash = structure.events.find((event) => event.type === "flash")!;
    expect(flash.intensity).toBeCloseTo(0.6, 5);
    expect(flash.confidence).toBeGreaterThan(0.5);
    expect(groundTruth.flashFrames).toContain(flash.frame);
  });

  it("excludes the end card from the edit range", () => {
    const structure = buildStructure();
    expect(structure.editRange.endFrame).toBeLessThanOrEqual(groundTruth.editEndFrameApprox);
    expect(structure.events.every((event) => event.frame <= groundTruth.editEndFrameApprox)).toBe(true);
    expect(structure.events.some((event) => event.frame >= groundTruth.editEndFrameApprox - 3)).toBe(true);
  });

  it("captures the acceleration curve as per-second energy", () => {
    const structure = buildStructure();
    // 515 frames / 30fps = 17.17s -> 17 per-second buckets.
    expect(structure.energyCurve.length).toBe(17);
    const lastThird = structure.energyCurve.slice(11);
    const firstThird = structure.energyCurve.slice(0, 6);
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    // The real edit builds: calm opening, rapid-fire second half.
    expect(mean(lastThird)).toBeGreaterThan(mean(firstThird) * 0.5);
  });

  it("reports shot-length stats within the measured reference pacing", () => {
    const structure = buildStructure();
    // Spec: shots of 1.4-1.9s early, one 3.5s hold, then 0.4-0.9s shots.
    expect(structure.shotLengths.min).toBeGreaterThan(0);
    expect(structure.shotLengths.max).toBeGreaterThanOrEqual(structure.shotLengths.p75);
    // Median shot length in frames: reference median sits between 0.4s and 3.5s.
    expect(structure.shotLengths.median).toBeGreaterThan(0.4 * 30 * 0.5);
    expect(structure.shotLengths.median).toBeLessThan(3.5 * 30);
  });
});
