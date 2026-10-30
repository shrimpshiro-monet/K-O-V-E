import type { ReferenceProfile, ShotProfile } from "@kove-advanced/core/mirror/reference-profile";
import type { CameraMotionSample } from "@kove-advanced/core/vision/camera-motion-extractor";

export interface BoundaryFidelity {
  readonly truePositives: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly meanAbsoluteErrorFrames: number | null;
}

export interface IntervalFidelity {
  readonly referenceCount: number;
  readonly predictedCount: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly meanMatchedIoU: number | null;
}

export interface CameraCurveFidelity {
  readonly sampleCount: number;
  readonly normalizedRmse: number | null;
  readonly correlation: number | null;
  readonly similarity: number | null;
}

export interface ReferenceFidelityReport {
  readonly shotBoundaries: BoundaryFidelity;
  readonly cutTimingMaeFrames: number | null;
  readonly cameraMotion: CameraCurveFidelity;
  readonly textOverlayWindows: IntervalFidelity;
}

interface TimedInterval {
  readonly start: number;
  readonly end: number;
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

export function scoreShotBoundaries(
  referenceFrames: readonly number[],
  predictedFrames: readonly number[],
  toleranceFrames: number,
): BoundaryFidelity {
  if (!Number.isSafeInteger(toleranceFrames) || toleranceFrames < 0) {
    throw new RangeError("Boundary tolerance must be a non-negative integer frame count.");
  }
  validateOrderedFrames(referenceFrames, "Reference boundaries");
  validateOrderedFrames(predictedFrames, "Predicted boundaries");

  const errors: number[] = [];
  let referenceIndex = 0;
  let predictedIndex = 0;
  while (referenceIndex < referenceFrames.length && predictedIndex < predictedFrames.length) {
    const error = predictedFrames[predictedIndex]! - referenceFrames[referenceIndex]!;
    if (Math.abs(error) <= toleranceFrames) {
      errors.push(Math.abs(error));
      referenceIndex++;
      predictedIndex++;
    } else if (error < 0) {
      predictedIndex++;
    } else {
      referenceIndex++;
    }
  }
  const truePositives = errors.length;
  const precision = predictedFrames.length === 0
    ? referenceFrames.length === 0 ? 1 : 0
    : truePositives / predictedFrames.length;
  const recall = referenceFrames.length === 0
    ? predictedFrames.length === 0 ? 1 : 0
    : truePositives / referenceFrames.length;
  return {
    truePositives,
    precision: round4(precision),
    recall: round4(recall),
    f1: round4(f1(precision, recall)),
    meanAbsoluteErrorFrames: errors.length
      ? round4(errors.reduce((sum, error) => sum + error, 0) / errors.length)
      : null,
  };
}

export function scoreIntervals(
  reference: readonly TimedInterval[],
  predicted: readonly TimedInterval[],
  iouThreshold = 0.5,
): IntervalFidelity {
  if (!Number.isFinite(iouThreshold) || iouThreshold < 0 || iouThreshold > 1) {
    throw new RangeError("Interval IoU threshold must be between zero and one.");
  }
  validateIntervals(reference, "Reference");
  validateIntervals(predicted, "Predicted");

  const pairs: Array<{ reference: number; predicted: number; iou: number }> = [];
  reference.forEach((truth, referenceIndex) => {
    predicted.forEach((candidate, predictedIndex) => {
      const iou = intervalIoU(truth, candidate);
      if (iou >= iouThreshold) pairs.push({ reference: referenceIndex, predicted: predictedIndex, iou });
    });
  });
  pairs.sort((a, b) => b.iou - a.iou);
  const candidatesByReference = reference.map((_, referenceIndex) =>
    pairs.filter((pair) => pair.reference === referenceIndex),
  );
  const matchedByPrediction = new Map<number, { reference: number; iou: number }>();
  const assign = (referenceIndex: number, visited: Set<number>): boolean => {
    for (const pair of candidatesByReference[referenceIndex]!) {
      if (visited.has(pair.predicted)) continue;
      visited.add(pair.predicted);
      const previous = matchedByPrediction.get(pair.predicted);
      if (!previous || assign(previous.reference, visited)) {
        matchedByPrediction.set(pair.predicted, { reference: referenceIndex, iou: pair.iou });
        return true;
      }
    }
    return false;
  };
  for (let referenceIndex = 0; referenceIndex < reference.length; referenceIndex++) {
    assign(referenceIndex, new Set());
  }
  const matchedIous = [...matchedByPrediction.values()].map((match) => match.iou);
  const truePositives = matchedByPrediction.size;
  const precision = predicted.length === 0 ? reference.length === 0 ? 1 : 0 : truePositives / predicted.length;
  const recall = reference.length === 0 ? predicted.length === 0 ? 1 : 0 : truePositives / reference.length;
  return {
    referenceCount: reference.length,
    predictedCount: predicted.length,
    precision: round4(precision),
    recall: round4(recall),
    f1: round4(f1(precision, recall)),
    meanMatchedIoU: matchedIous.length
      ? round4(matchedIous.reduce((sum, iou) => sum + iou, 0) / matchedIous.length)
      : null,
  };
}

export function scoreCameraMotion(
  referenceShots: readonly ShotProfile[],
  predictedShots: readonly ShotProfile[],
  durationFrames: number,
  aspectRatio: { readonly width: number; readonly height: number },
  gridSize = 100,
): CameraCurveFidelity {
  if (!Number.isSafeInteger(durationFrames) || durationFrames <= 0 ||
      !Number.isFinite(aspectRatio.width) || aspectRatio.width <= 0 ||
      !Number.isFinite(aspectRatio.height) || aspectRatio.height <= 0 ||
      !Number.isSafeInteger(gridSize) || gridSize < 2) {
    throw new RangeError("Camera comparison needs positive duration/dimensions and at least two samples.");
  }
  const reference = flattenMotionSamples(referenceShots);
  const predicted = flattenMotionSamples(predictedShots);
  if (reference.length === 0 && predicted.length === 0) {
    return { sampleCount: 0, normalizedRmse: null, correlation: null, similarity: null };
  }
  if (reference.length < 2 || predicted.length < 2) {
    return { sampleCount: Math.min(reference.length, predicted.length), normalizedRmse: null, correlation: null, similarity: null };
  }

  const properties = [
    { key: "translateX", scale: aspectRatio.width },
    { key: "translateY", scale: aspectRatio.height },
    { key: "rotationRad", scale: 1 },
    { key: "scale", scale: 1 },
  ] as const;
  const errors: number[] = [];
  const correlations: number[] = [];
  for (const property of properties) {
    const refValues = sampleMotionCurve(reference, durationFrames, gridSize, property.key, property.scale);
    const predictedValues = sampleMotionCurve(predicted, durationFrames, gridSize, property.key, property.scale);
    const magnitude = Math.max(
      ...refValues.map(Math.abs),
      ...predictedValues.map(Math.abs),
      1e-6,
    );
    const rmse = Math.sqrt(mean(refValues.map((value, index) => ((value - predictedValues[index]!) / magnitude) ** 2)));
    errors.push(Math.min(1, rmse));
    correlations.push(pearson(refValues, predictedValues));
  }
  const normalizedRmse = mean(errors);
  const correlation = mean(correlations);
  return {
    sampleCount: gridSize,
    normalizedRmse: round4(normalizedRmse),
    correlation: round4(correlation),
    similarity: round4(Math.max(0, Math.min(1, 0.5 * (1 - normalizedRmse) + 0.5 * (correlation + 1) / 2))),
  };
}

export function evaluateReferenceProfiles(
  reference: ReferenceProfile,
  predicted: ReferenceProfile,
  options: { readonly boundaryToleranceFrames?: number; readonly captionIouThreshold?: number } = {},
): ReferenceFidelityReport {
  if (reference.fps.num !== predicted.fps.num || reference.fps.den !== predicted.fps.den) {
    throw new Error("Reference and predicted profiles must use the same rational frame clock.");
  }
  if (reference.durationFrames !== predicted.durationFrames ||
      reference.aspectRatio.width !== predicted.aspectRatio.width ||
      reference.aspectRatio.height !== predicted.aspectRatio.height) {
    throw new Error("Reference and predicted profiles must share the same duration and frame dimensions.");
  }
  const refBoundaries = reference.shots.slice(1).map((shot) => shot.startFrame);
  const predictedBoundaries = predicted.shots.slice(1).map((shot) => shot.startFrame);
  const shotBoundaries = scoreShotBoundaries(
    refBoundaries,
    predictedBoundaries,
    options.boundaryToleranceFrames ?? 1,
  );
  const refCaptions = textIntervals(reference);
  const predictedCaptions = textIntervals(predicted);
  return {
    shotBoundaries,
    cutTimingMaeFrames: shotBoundaries.meanAbsoluteErrorFrames,
    cameraMotion: scoreCameraMotion(
      reference.shots,
      predicted.shots,
      reference.durationFrames,
      reference.aspectRatio,
    ),
    textOverlayWindows: scoreIntervals(
      refCaptions,
      predictedCaptions,
      options.captionIouThreshold ?? 0.5,
    ),
  };
}

function textIntervals(profile: ReferenceProfile): TimedInterval[] {
  const overlays = profile.styleEvidence?.textOverlays ?? [];
  if (overlays.length > 0) {
    return overlays.map((overlay) => ({
      start: overlay.startFrame / profile.fps.num * profile.fps.den,
      end: overlay.endFrame / profile.fps.num * profile.fps.den,
    }));
  }
  return profile.shots.flatMap((shot) => shot.captionWindows.map((window) => ({
    start: window.startFrame / profile.fps.num * profile.fps.den,
    end: window.endFrame / profile.fps.num * profile.fps.den,
  })));
}

function flattenMotionSamples(shots: readonly ShotProfile[]): CameraMotionSample[] {
  return shots.flatMap((shot) => shot.cameraMotion?.samples ?? [])
    .sort((a, b) => a.frame - b.frame);
}

type MotionProperty = "translateX" | "translateY" | "rotationRad" | "scale";

function sampleMotionCurve(
  samples: readonly CameraMotionSample[],
  durationFrames: number,
  gridSize: number,
  property: MotionProperty,
  unitScale: number,
): number[] {
  return Array.from({ length: gridSize }, (_, index) => {
    const frame = index * (durationFrames - 1) / (gridSize - 1);
    const upperIndex = samples.findIndex((sample) => sample.frame >= frame);
    if (upperIndex < 0) return motionValue(samples[samples.length - 1]!, property, unitScale);
    if (upperIndex === 0) return motionValue(samples[0]!, property, unitScale);
    const before = samples[upperIndex - 1]!;
    const after = samples[upperIndex]!;
    const span = after.frame - before.frame;
    const ratio = span === 0 ? 0 : (frame - before.frame) / span;
    const start = motionValue(before, property, unitScale);
    return start + (motionValue(after, property, unitScale) - start) * ratio;
  });
}

function motionValue(sample: CameraMotionSample, property: MotionProperty, unitScale: number): number {
  const value = sample[property];
  return property === "scale" ? value - 1 : value / unitScale;
}

function validateOrderedFrames(values: readonly number[], label: string): void {
  let previous = -1;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value <= previous) {
      throw new RangeError(`${label} must be strictly increasing non-negative integer frames.`);
    }
    previous = value;
  }
}

function validateIntervals(values: readonly TimedInterval[], label: string): void {
  for (const interval of values) {
    if (!Number.isFinite(interval.start) || !Number.isFinite(interval.end) ||
        interval.start < 0 || interval.end <= interval.start) {
      throw new RangeError(`${label} intervals must have finite non-negative starts and positive durations.`);
    }
  }
}

function intervalIoU(a: TimedInterval, b: TimedInterval): number {
  const intersection = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const union = (a.end - a.start) + (b.end - b.start) - intersection;
  return union > 0 ? intersection / union : 0;
}

function f1(precision: number, recall: number): number {
  return precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function pearson(a: readonly number[], b: readonly number[]): number {
  const avgA = mean(a);
  const avgB = mean(b);
  const centeredA = a.map((value) => value - avgA);
  const centeredB = b.map((value) => value - avgB);
  const denominator = Math.sqrt(
    mean(centeredA.map((value) => value ** 2)) *
    mean(centeredB.map((value) => value ** 2)),
  );
  if (denominator < 1e-12) {
    return mean(a.map((value, index) => Math.abs(value - b[index]!))) < 1e-12 ? 1 : 0;
  }
  return mean(centeredA.map((value, index) => value * centeredB[index]!)) / denominator;
}
