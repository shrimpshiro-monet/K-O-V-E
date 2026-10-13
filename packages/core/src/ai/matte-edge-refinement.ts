/**
 * Matte edge refinement.
 *
 * A rotoscoped matte is only as good as its edge. A single mask-wide feather
 * has to compromise: wide enough to look soft where the subject moves fast
 * (where sampled contours lag and motion blur already smears the silhouette),
 * tight enough to stay crisp where the subject is still. Because the matte is
 * already keyframed, the feather can be keyframed too.
 *
 * This module turns a rotoscope plan into per-keyframe edge values. It is pure
 * and canvas-free — the renderer (MaskEngine) is what turns them into pixels.
 */

import type { BezierPath } from "../video/mask-engine";

/**
 * The minimum a caller needs to describe a silhouette at one instant.
 *
 * `RotoscopeKeyframe` satisfies this, but so does anything derived from a mask
 * keyframe path — which is what lets refinement run on a matte that already
 * exists, without re-running segmentation.
 */
export interface MatteEdgeShapeSample {
  readonly timeMs: number;
  /** Fraction of the frame the silhouette covers, 0..1. */
  readonly coverage: number;
  /** Silhouette centre in normalized frame space, 0..1. */
  readonly centroid: { readonly x: number; readonly y: number };
}

export interface MatteEdgeSettings {
  /** Feather in pixels where the subject is still. */
  featherPx: number;
  /** Grow (+) or shrink (−) the silhouette, in pixels. */
  expansionPx: number;
  /** Knock the subject out instead of keeping it. */
  invert?: boolean;
  /** Matte opacity, 0..1. */
  opacity?: number;
  /**
   * How much motion widens the feather, 0..1. 0 keeps the feather uniform
   * (the pre-refinement behaviour); 1 lets the fastest keyframe reach the cap.
   * Default 0.6.
   */
  motionSensitivity?: number;
  /** Upper bound for the motion-widened feather, in pixels. Default 3× base. */
  maxFeatherPx?: number;
}

export interface MatteEdgeKeyframe {
  /** Source time of the rotoscope keyframe this belongs to, in ms. */
  timeMs: number;
  featherPx: number;
  expansionPx: number;
}

export interface MatteEdgePlan {
  keyframes: MatteEdgeKeyframe[];
  /** Per-keyframe motion score, 0..1, so callers can explain the variation. */
  motion: number[];
  warnings: string[];
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * Motion score per keyframe, normalized to 0..1.
 *
 * Combines how far the silhouette's centroid travelled with how much its area
 * changed between neighbouring keyframes — the two things that make a sampled
 * contour disagree with the real edge. Scores are normalized against the
 * busiest keyframe so the result is scale-free: a slow pan and a fast walk both
 * produce a usable 0..1 range rather than an absolute pixel velocity.
 */
export function matteMotionScores(
  keyframes: readonly Pick<MatteEdgeShapeSample, "coverage" | "centroid">[],
): number[] {
  if (keyframes.length === 0) return [];
  if (keyframes.length === 1) return [0];

  const raw: number[] = keyframes.map((_keyframe, index) => {
    const previous = keyframes[Math.max(0, index - 1)];
    const next = keyframes[Math.min(keyframes.length - 1, index + 1)];
    const travelX = next.centroid.x - previous.centroid.x;
    const travelY = next.centroid.y - previous.centroid.y;
    const travel = Math.hypot(travelX, travelY);
    const areaChange = Math.abs(next.coverage - previous.coverage);

    // Coverage is a fraction of the frame, so it is already normalized;
    // centroid travel is normalized too, but a diagonal crossing of the whole
    // frame is ~1.41, so scale it into a comparable 0..1 band.
    return travel * 0.7 + areaChange;
  });

  const peak = Math.max(...raw);
  if (peak <= 1e-6) return raw.map(() => 0);
  return raw.map((value) => clamp01(value / peak));
}

/**
 * Derive motion inputs from mask keyframe paths.
 *
 * A committed mask stores only a path per keyframe — the coverage and centroid
 * the rotoscope plan carried are gone. Both are recoverable from the closed
 * path: the centroid is the mean of its points, and coverage is its area via
 * the shoelace formula. Since a matte's keyframes all share topology (the
 * renderer interpolates point-for-point), comparing those numbers between
 * neighbouring keyframes measures the same thing the rotoscope plan did.
 */
export function shapeSamplesFromPaths(
  keyframes: readonly { readonly time: number; readonly path: BezierPath }[],
): MatteEdgeShapeSample[] {
  return keyframes.map((keyframe) => {
    const points = keyframe.path.points ?? [];
    if (points.length === 0) {
      return { timeMs: keyframe.time * 1000, coverage: 0, centroid: { x: 0.5, y: 0.5 } };
    }

    let sumX = 0;
    let sumY = 0;
    let twiceArea = 0;
    for (let index = 0; index < points.length; index += 1) {
      const current = points[index];
      const next = points[(index + 1) % points.length];
      sumX += current.x;
      sumY += current.y;
      twiceArea += current.x * next.y - next.x * current.y;
    }

    return {
      timeMs: keyframe.time * 1000,
      coverage: Math.abs(twiceArea) / 2,
      centroid: { x: sumX / points.length, y: sumY / points.length },
    };
  });
}

/**
 * Derive per-keyframe edge values from a rotoscope plan.
 *
 * The first keyframe always keeps the base feather, so a still subject gets an
 * unchanged, uniform edge. Motion widens it towards `maxFeatherPx`.
 */
export function planMatteEdgeRefinement(
  keyframes: readonly MatteEdgeShapeSample[],
  settings: MatteEdgeSettings,
): MatteEdgePlan {
  const warnings: string[] = [];

  const base = Math.max(0, settings.featherPx);
  const expansionPx = Math.max(-100, Math.min(100, settings.expansionPx));
  const sensitivity = clamp01(settings.motionSensitivity ?? 0.6);
  const cap = Math.max(base, settings.maxFeatherPx ?? base * 3);

  const scores = matteMotionScores(keyframes);
  const feather = scores.map((score) => base + (cap - base) * clamp01(score * sensitivity));

  if (keyframes.length === 0) {
    warnings.push("The matte has no keyframes, so there is no edge to refine.");
  }
  if (settings.invert && base > 0) {
    warnings.push(
      "Inverted mattes feather inwards: a wide feather can eat into the subject you kept.",
    );
  }
  if ((settings.opacity ?? 1) < 1 && base === 0) {
    warnings.push("Opacity below 1 with a hard edge will show a visible seam; add some feather.");
  }

  return {
    keyframes: keyframes.map((keyframe, index) => ({
      timeMs: keyframe.timeMs,
      featherPx: Math.round(feather[index] * 100) / 100,
      expansionPx,
    })),
    motion: scores,
    warnings,
  };
}
