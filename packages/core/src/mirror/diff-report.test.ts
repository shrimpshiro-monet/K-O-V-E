import { describe, expect, it } from "vitest";
import { buildDiffReport, compareCutFrames, pearson } from "./diff-report";
import { buildEditorStructure, type ReferenceProfile } from "./reference-profile";
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
  }));

const realFlashEffects = groundTruth.flashFrames
  .filter((frame) => frame < groundTruth.editEndFrameApprox)
  .map((frame) => ({
    startFrame: frame,
    endFrame: frame + 1,
    name: "flash",
    source: "local-pixel-analysis" as const,
    confidence: 0.8,
    parameterEstimates: { brightness: 60 },
  }));

const shotBoundaries = [0, ...realTransitions.map((transition) => transition.startFrame + 1), groundTruth.editEndFrameApprox];
const realShots = shotBoundaries.slice(0, -1).map((startFrame, index) => ({
  startFrame,
  endFrame: shotBoundaries[index + 1]!,
  captionWindows: [],
}));

const buildReference = (): ReferenceProfile =>
  ({
    version: "kove.mirror.v3",
    fps: FPS,
    aspectRatio: { width: 9, height: 16 },
    durationFrames: groundTruth.editEndFrameApprox,
    shots: realShots,
    rhythmCurve: realShots.map((shot) => shot.endFrame - shot.startFrame),
    beatGridMs: [],
    styleEvidence: {
      transitions: realTransitions,
      textOverlays: [],
      effects: realFlashEffects,
    },
    structure: buildEditorStructure({
      shots: realShots,
      styleEvidence: {
        transitions: realTransitions,
        textOverlays: [],
        effects: realFlashEffects,
      },
      fps: FPS,
      durationFrames: groundTruth.editEndFrameApprox,
    }),
  }) as unknown as ReferenceProfile;

describe("diff report on real Captain Price fixture data", () => {
  const reference = buildReference();
  const referenceCuts = reference.structure!.events
    .filter((event) => event.type === "hard-cut")
    .map((event) => event.frame);
  const accents = reference.structure!.events
    .filter((event) => event.type !== "hard-cut")
    .map((event) => event.frame);

  it("matches cuts within tolerance and reports misses and extras", () => {
    // A ≤1-frame-off copy of the real cut list: perfect match expected.
    const output = referenceCuts.map((frame) => frame + (frame % 2 === 0 ? 1 : 0));
    const report = compareCutFrames(referenceCuts, output, 2);
    expect(report.missedFrames).toEqual([]);
    expect(report.extraFrames).toEqual([]);
    expect(report.meanAbsoluteDeltaFrames).toBeLessThanOrEqual(1);
    // Dropping half the cuts leaves the rest unmatched.
    const half = compareCutFrames(referenceCuts, referenceCuts.slice(0, Math.floor(referenceCuts.length / 2)), 2);
    expect(half.matchedFrames.length).toBe(Math.floor(referenceCuts.length / 2));
    expect(half.missedFrames.length).toBe(referenceCuts.length - half.matchedFrames.length);
  });

  it("scores a faithful output high and a 4x-slower output much lower", () => {
    const faithful = buildDiffReport({ reference, outputCutFrames: referenceCuts });
    expect(faithful.score.rhythm).toBe(40);
    expect(faithful.score.total).toBeGreaterThanOrEqual(55);

    const sparse = referenceCuts.filter((_, index) => index % 4 === 0);
    const slow = buildDiffReport({ reference, outputCutFrames: sparse });
    expect(slow.score.rhythm).toBeLessThan(15);
    expect(slow.score.total).toBeLessThan(faithful.score.total);
    expect(slow.shotLengths.output.median).toBeGreaterThan(faithful.shotLengths.output.median);
  });

  it("credits accent coverage and correlates energy shape", () => {
    const covered = buildDiffReport({
      reference,
      outputCutFrames: referenceCuts,
      referenceAccentFrames: accents,
      outputAccentFrames: accents,
      outputEnergyCurve: reference.structure!.energyCurve,
    });
    expect(covered.transitionCoverage.covered).toBe(accents.length);
    expect(covered.transitionCoverage.uncoveredFrames).toEqual([]);
    expect(covered.score.energyShape).toBe(15);
    expect(covered.score.total).toBeGreaterThan(covered.score.rhythm + covered.score.treatmentCoverage);

    const uncovered = buildDiffReport({
      reference,
      outputCutFrames: referenceCuts,
      referenceAccentFrames: accents,
      outputAccentFrames: [],
    });
    expect(uncovered.transitionCoverage.covered).toBe(0);
    expect(uncovered.score.treatmentCoverage).toBe(0);
  });

  it("returns a flat correlation when one series is constant", () => {
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 5);
  });
});
