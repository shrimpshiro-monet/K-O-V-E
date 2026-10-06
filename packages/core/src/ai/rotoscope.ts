/**
 * AI-assisted rotoscoping.
 *
 * Turns per-frame subject mattes (the alpha masks produced by
 * `PersonSegmentationEngine`) into keyframed Bezier paths that `MaskEngine`
 * can animate — the missing link between "we have a matte" and "the clip has
 * a tracked mask".
 *
 * Everything here is pure and canvas-free: alpha buffers in, paths out. That
 * keeps the geometry testable without WebGL/WASM and lets both the browser
 * panel and the agent path share one implementation.
 */

import type { BezierPath } from "../video/mask-engine";

export interface AlphaMask {
  /** Single-channel coverage, 0..255, row-major. */
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export interface ContourPoint {
  x: number;
  y: number;
}

export interface Contour {
  points: ContourPoint[];
  /** |shoelace area| in pixels. */
  area: number;
  /** Outer boundaries are positive, holes negative (signed shoelace area). */
  signedArea: number;
  isHole: boolean;
}

export interface ContourOptions {
  /** Coverage at or above this counts as subject. Default 128. */
  threshold?: number;
  /** Contours smaller than this fraction of the frame are dropped. Default 0.0005. */
  minAreaRatio?: number;
  /** Hard cap on contours returned, largest first. Default 4. */
  maxContours?: number;
}

export interface MaskStats {
  /** Fraction of the frame covered by the subject, 0..1. */
  coverage: number;
  /** Normalized centroid (0..1). */
  centroid: { x: number; y: number };
  /** Normalized bounding box of covered pixels. */
  boundingBox: { x: number; y: number; width: number; height: number };
}

const DEFAULT_CONTOUR_OPTIONS: Required<ContourOptions> = {
  threshold: 128,
  minAreaRatio: 0.0005,
  maxContours: 4,
};

function isForeground(value: number, threshold: number): boolean {
  return value >= threshold;
}

function shoelaceArea(points: readonly ContourPoint[]): number {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    sum += current.x * next.y - next.x * current.y;
  }
  return sum / 2;
}

// Clockwise Moore neighborhood starting from the west neighbour. Index k is
// opposite to index (k + 4) % 8, which the tracer relies on to keep the
// backtrack direction consistent across steps.
const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
];

/**
 * Moore-neighbor boundary tracing over a binarized mask.
 *
 * Only boundary pixels (foreground with at least one background neighbour)
 * start a trace, so the interior of a thick silhouette is never walked. A
 * trace stops when it re-enters a (pixel, entry-direction) state it already
 * visited — the state space is finite (8 per pixel), which guarantees
 * termination even on malformed mattes. Separate loops come out of a single
 * component when it has interior holes.
 */
function traceContours(mask: AlphaMask, threshold: number): ContourPoint[][] {
  const { data, width, height } = mask;
  if (width <= 0 || height <= 0 || data.length < width * height) return [];

  const index = (x: number, y: number): number => y * width + x;
  const fg = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && isForeground(data[index(x, y)], threshold);
  const isBoundary = (x: number, y: number): boolean => {
    if (!fg(x, y)) return false;
    for (const [dx, dy] of NEIGHBOURS) {
      if (!fg(x + dx, y + dy)) return true;
    }
    return false;
  };

  // One bit per (pixel, entry direction); marks states consumed by any loop.
  const stateSeen = new Uint8Array(width * height * 8);
  const pixelTraversed = new Uint8Array(width * height);
  const contours: ContourPoint[][] = [];
  const maxSteps = width * height * 8 + 16;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!isBoundary(x, y) || pixelTraversed[index(x, y)]) continue;

      // Enter from any background neighbour so the walk starts on the outside.
      const entry = NEIGHBOURS.findIndex(([dx, dy]) => !fg(x + dx, y + dy));
      if (entry < 0) continue;

      const startX = x;
      const startY = y;
      let currentX = x;
      let currentY = y;
      let entryDir = entry;
      const contour: ContourPoint[] = [];
      pixelTraversed[index(x, y)] = 1;

      for (let step = 0; step < maxSteps; step += 1) {
        contour.push({ x: currentX, y: currentY });

        let moved = false;
        for (let offset = 1; offset <= NEIGHBOURS.length; offset += 1) {
          const candidate = (entryDir + offset) % NEIGHBOURS.length;
          const [dx, dy] = NEIGHBOURS[candidate];
          const nextX = currentX + dx;
          const nextY = currentY + dy;
          if (!fg(nextX, nextY)) continue;

          // The neighbour just before the one we stepped to is the new
          // backtrack; from the next pixel it lies in the opposite direction.
          const nextEntryDir = (candidate + 4) % NEIGHBOURS.length;
          const stateIndex = index(nextX, nextY) * 8 + nextEntryDir;
          if (stateSeen[stateIndex]) {
            moved = false;
            break;
          }
          stateSeen[stateIndex] = 1;
          pixelTraversed[index(nextX, nextY)] = 1;
          currentX = nextX;
          currentY = nextY;
          entryDir = nextEntryDir;
          moved = true;
          break;
        }
        if (!moved) break;

        if (currentX === startX && currentY === startY) break;
      }

      if (contour.length >= 3) contours.push(contour);
    }
  }

  return contours;
}

/**
 * Classifies loops by orientation. Outer boundaries of every component share
 * one signed-area sign; interior holes run the opposite way, so the sign of
 * the largest loop calibrates the rest instead of hard-coding a winding.
 */
function orientContours(
  loops: ContourPoint[][],
): Array<ContourPoint[] & { isHole: boolean }> {
  let outerSign = 1;
  let largestArea = -1;
  for (const loop of loops) {
    const area = Math.abs(shoelaceArea(loop));
    if (area > largestArea) {
      largestArea = area;
      const sign = shoelaceArea(loop);
      outerSign = sign === 0 ? 1 : Math.sign(sign);
    }
  }
  return loops.map((loop) => {
    const marked = loop as ContourPoint[] & { isHole: boolean };
    const sign = shoelaceArea(loop);
    marked.isHole = sign !== 0 && Math.sign(sign) !== outerSign;
    return marked;
  });
}

/** Extracts closed contours from a single-channel matte, largest first. */
export function alphaToContours(
  mask: AlphaMask,
  options: ContourOptions = {},
): Contour[] {
  const config = { ...DEFAULT_CONTOUR_OPTIONS, ...options };
  const minArea = Math.max(0, config.minAreaRatio) * mask.width * mask.height;
  return orientContours(traceContours(mask, config.threshold))
    .map((points): Contour => {
      const signedArea = shoelaceArea(points);
      return {
        points,
        area: Math.abs(signedArea),
        signedArea,
        isHole: points.isHole,
      };
    })
    .filter((contour) => contour.area >= minArea)
    .sort((a, b) => b.area - a.area)
    .slice(0, Math.max(1, config.maxContours));
}

/** Ramer–Douglas–Peucker on pixel-space points. */
export function simplifyContour(
  points: readonly ContourPoint[],
  tolerance: number,
): ContourPoint[] {
  if (points.length <= 3 || tolerance <= 0) return [...points];
  const epsilon = tolerance * tolerance;

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    if (last <= first + 1) continue;
    const a = points[first];
    const b = points[last];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;

    let farthest = -1;
    let farthestDistance = 0;
    for (let index = first + 1; index < last; index += 1) {
      const point = points[index];
      let distance: number;
      if (lengthSquared === 0) {
        distance = (point.x - a.x) ** 2 + (point.y - a.y) ** 2;
      } else {
        const t = Math.max(
          0,
          Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared),
        );
        distance = (point.x - (a.x + t * dx)) ** 2 + (point.y - (a.y + t * dy)) ** 2;
      }
      if (distance > farthestDistance) {
        farthestDistance = distance;
        farthest = index;
      }
    }

    if (farthest > 0 && farthestDistance > epsilon) {
      keep[farthest] = 1;
      stack.push([first, farthest], [farthest, last]);
    }
  }

  return points.filter((_, index) => keep[index] === 1);
}

export interface PathFromContourOptions {
  /** Frame size the contour points refer to. */
  width: number;
  height: number;
  /** Fit smooth Catmull-Rom bezier handles instead of straight segments. Default true. */
  smooth?: boolean;
  /** Handle length as a fraction of the neighbour span. Default 1/6. */
  tension?: number;
}

/**
 * Converts a pixel-space contour into a normalized (0..1) closed BezierPath,
 * the coordinate space `MaskEngine` expects.
 */
export function contourToBezierPath(
  contour: readonly ContourPoint[],
  options: PathFromContourOptions,
): BezierPath {
  const { width, height } = options;
  const smooth = options.smooth ?? true;
  const tension = options.tension ?? 1 / 6;
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const normalized = contour.map((point) => ({
    x: Math.max(0, Math.min(1, point.x / safeWidth)),
    y: Math.max(0, Math.min(1, point.y / safeHeight)),
  }));

  if (!smooth || normalized.length < 3) {
    return { points: normalized, closed: true };
  }

  const count = normalized.length;
  return {
    closed: true,
    points: normalized.map((point, index) => {
      const previous = normalized[(index - 1 + count) % count];
      const next = normalized[(index + 1) % count];
      const tangentX = (next.x - previous.x) * tension;
      const tangentY = (next.y - previous.y) * tension;
      return {
        x: point.x,
        y: point.y,
        ...(index === 0 ? {} : {}),
        handleIn: { x: point.x - tangentX, y: point.y - tangentY },
        handleOut: { x: point.x + tangentX, y: point.y + tangentY },
      };
    }),
  };
}

/**
 * Extracts a single-channel matte from RGBA pixels.
 *
 * `PersonSegmentationEngine` and `BackgroundRemovalEngine` both pack coverage
 * into the alpha channel of an `ImageData`; this is the bridge into the
 * geometry helpers above.
 */
export function alphaFromRgba(image: {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}): AlphaMask {
  const { data, width, height } = image;
  const alpha = new Uint8ClampedArray(width * height);
  for (let index = 0; index < width * height; index += 1) {
    alpha[index] = data[index * 4 + 3];
  }
  return { data: alpha, width, height };
}

/** Coverage, centroid and bounding box of a matte, all normalized. */
export function maskStats(mask: AlphaMask, threshold = 128): MaskStats {
  const { data, width, height } = mask;
  const total = Math.max(1, width * height);
  let covered = 0;
  let sumX = 0;
  let sumY = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!isForeground(data[y * width + x], threshold)) continue;
      covered += 1;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (covered === 0) {
    return {
      coverage: 0,
      centroid: { x: 0, y: 0 },
      boundingBox: { x: 0, y: 0, width: 0, height: 0 },
    };
  }

  return {
    coverage: covered / total,
    centroid: {
      x: sumX / covered / width,
      y: sumY / covered / height,
    },
    boundingBox: {
      x: minX / width,
      y: minY / height,
      width: (maxX - minX + 1) / width,
      height: (maxY - minY + 1) / height,
    },
  };
}

export interface RotoscopeSample {
  timeMs: number;
  mask: AlphaMask;
}

export interface RotoscopeOptions {
  /** Coverage at or above this is subject. Default 128. */
  threshold?: number;
  /** Contours below this fraction of the frame are ignored. Default 0.002. */
  minAreaRatio?: number;
  /** Frames whose subject covers less than this are treated as "no subject". Default 0.004. */
  minCoverage?: number;
  /** Simplification tolerance in normalized units. Default 0.008. */
  simplifyTolerance?: number;
  /** Keep at most this many points per path. Default 48. */
  maxPointsPerPath?: number;
  /** A new keyframe is kept when coverage changes by more than this (absolute). Default 0.02. */
  coverageDeltaThreshold?: number;
  /** A new keyframe is kept when the centroid moves more than this (normalized). Default 0.01. */
  centroidDeltaThreshold?: number;
  /** Hard cap; extra frames are decimated evenly. Default 60. */
  maxKeyframes?: number;
  /** Smooth bezier handles. Default true. */
  smooth?: boolean;
}

export interface RotoscopeKeyframe {
  timeMs: number;
  /** Normalized closed path for MaskEngine. */
  path: BezierPath;
  coverage: number;
  centroid: { x: number; y: number };
  pointCount: number;
}

export interface RotoscopePlan {
  keyframes: RotoscopeKeyframe[];
  /** Frames sampled from the source. */
  sampledFrames: number;
  /** Frames that produced no usable subject. */
  missedFrames: number;
  averageCoverage: number;
  /** Union bounding box across kept keyframes (normalized). */
  boundingBox: { x: number; y: number; width: number; height: number };
  warnings: string[];
}

const DEFAULT_ROTOSCOPE: Required<RotoscopeOptions> = {
  threshold: 128,
  minAreaRatio: 0.002,
  minCoverage: 0.004,
  simplifyTolerance: 0.008,
  maxPointsPerPath: 48,
  coverageDeltaThreshold: 0.02,
  centroidDeltaThreshold: 0.01,
  maxKeyframes: 60,
  smooth: true,
};

function decimateKeyframes(
  keyframes: readonly RotoscopeKeyframe[],
  maxKeyframes: number,
): RotoscopeKeyframe[] {
  if (keyframes.length <= maxKeyframes) return [...keyframes];
  const last = keyframes.length - 1;
  const kept: RotoscopeKeyframe[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < maxKeyframes; index += 1) {
    const sourceIndex = Math.round((index * last) / (maxKeyframes - 1));
    if (seen.has(sourceIndex)) continue;
    seen.add(sourceIndex);
    kept.push(keyframes[sourceIndex]);
  }
  return kept;
}

/**
 * Builds a keyframed matte plan from per-frame masks.
 *
 * Keyframes are the *changed* frames: the first sample always becomes a
 * keyframe, later ones only when coverage, centroid or sampled shape moves
 * past the thresholds (or when the contour topology changes enough to alter
 * the point count). This keeps a static-subject shot at 1 keyframe and a
 * walking subject at roughly the sampling rate, instead of always emitting
 * one keyframe per sampled frame.
 */
export function planRotoscope(
  samples: readonly RotoscopeSample[],
  options: RotoscopeOptions = {},
): RotoscopePlan {
  const config = { ...DEFAULT_ROTOSCOPE, ...options };
  const warnings: string[] = [];
  const ordered = [...samples].sort((a, b) => a.timeMs - b.timeMs);

  const keyframes: RotoscopeKeyframe[] = [];
  let missedFrames = 0;
  let coverageSum = 0;
  let coverageCount = 0;
  let unionBox: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  let lastKeptSignature: { coverage: number; centroid: { x: number; y: number }; points: number } | null =
    null;

  for (const sample of ordered) {
    const stats = maskStats(sample.mask, config.threshold);
    if (stats.coverage < config.minCoverage) {
      missedFrames += 1;
      continue;
    }
    coverageSum += stats.coverage;
    coverageCount += 1;

    const contours = alphaToContours(sample.mask, {
      threshold: config.threshold,
      minAreaRatio: config.minAreaRatio,
    });
    const subject = contours.find((contour) => !contour.isHole);
    if (!subject) {
      missedFrames += 1;
      continue;
    }
    const holes = contours.filter((contour) => contour.isHole).length;

    const tolerancePixels =
      config.simplifyTolerance * Math.max(sample.mask.width, sample.mask.height);
    let simplified = simplifyContour(subject.points, tolerancePixels);
    if (simplified.length > config.maxPointsPerPath) {
      // Uniform decimation as a hard ceiling; RDP already removed flat runs.
      const step = simplified.length / config.maxPointsPerPath;
      simplified = Array.from(
        { length: config.maxPointsPerPath },
        (_, index) => simplified[Math.min(simplified.length - 1, Math.floor(index * step))],
      );
    }
    if (simplified.length < 3) continue;

    const path = contourToBezierPath(simplified, {
      width: sample.mask.width,
      height: sample.mask.height,
      smooth: config.smooth,
    });

    const changed =
      lastKeptSignature === null ||
      Math.abs(stats.coverage - lastKeptSignature.coverage) >
        config.coverageDeltaThreshold ||
      Math.hypot(
        stats.centroid.x - lastKeptSignature.centroid.x,
        stats.centroid.y - lastKeptSignature.centroid.y,
      ) > config.centroidDeltaThreshold ||
      Math.abs(simplified.length - lastKeptSignature.points) > config.maxPointsPerPath * 0.5;

    if (!changed) continue;

    keyframes.push({
      timeMs: sample.timeMs,
      path,
      coverage: stats.coverage,
      centroid: stats.centroid,
      pointCount: path.points.length,
    });
    lastKeptSignature = {
      coverage: stats.coverage,
      centroid: stats.centroid,
      points: simplified.length,
    };

    const box = stats.boundingBox;
    unionBox = unionBox
      ? {
          minX: Math.min(unionBox.minX, box.x),
          minY: Math.min(unionBox.minY, box.y),
          maxX: Math.max(unionBox.maxX, box.x + box.width),
          maxY: Math.max(unionBox.maxY, box.y + box.height),
        }
      : { minX: box.x, minY: box.y, maxX: box.x + box.width, maxY: box.y + box.height };

    if (holes > 0) {
      warnings.push(
        `Frame at ${Math.round(sample.timeMs)}ms has ${holes} hole(s) inside the subject; mattes are exported as their outer contour only.`,
      );
    }
  }

  if (keyframes.length === 0) {
    warnings.push(
      ordered.length === 0
        ? "No frames were sampled."
        : "No usable subject was found in any sampled frame.",
    );
    return {
      keyframes,
      sampledFrames: ordered.length,
      missedFrames,
      averageCoverage: 0,
      boundingBox: { x: 0, y: 0, width: 0, height: 0 },
      warnings,
    };
  }

  const decimated = decimateKeyframes(keyframes, Math.max(2, config.maxKeyframes));
  if (decimated.length < keyframes.length) {
    warnings.push(
      `Matte decimated from ${keyframes.length} to ${decimated.length} keyframes (maxKeyframes=${config.maxKeyframes}); raise maxKeyframes for long, fast-moving subjects.`,
    );
  }
  if (missedFrames > 0) {
    warnings.push(
      `${missedFrames} sampled frame(s) had no subject; the matte holds its last good shape across those gaps.`,
    );
  }

  return {
    keyframes: decimated,
    sampledFrames: ordered.length,
    missedFrames,
    averageCoverage: coverageSum / Math.max(1, coverageCount),
    boundingBox: unionBox
      ? {
          x: unionBox.minX,
          y: unionBox.minY,
          width: unionBox.maxX - unionBox.minX,
          height: unionBox.maxY - unionBox.minY,
        }
      : { x: 0, y: 0, width: 0, height: 0 },
    warnings,
  };
}

/** Where a rotoscoped matte is written. `MaskEngine` satisfies this shape. */
export interface RotoscopeKeyframeSink {
  addMaskKeyframe(
    maskId: string,
    timeSeconds: number,
    path: BezierPath,
  ): { id: string } | null;
}

export interface ClipTimeMapping {
  /** Timeline seconds at which the clip starts. */
  startTime: number;
  /** Source seconds shown at the clip's first frame. */
  inPoint: number;
  /** Playback speed (> 0). */
  speed: number;
  /** Source seconds at the clip's last frame; required for reversed clips. */
  outPoint?: number;
  reversed?: boolean;
}

/** Maps a source timestamp to the timeline clock used by `MaskKeyframe.time`. */
export function sourceTimeToTimelineSeconds(
  sourceSeconds: number,
  mapping: ClipTimeMapping,
): number {
  const speed = Math.max(0.001, mapping.speed);
  const offset = mapping.reversed
    ? ((mapping.outPoint ?? sourceSeconds) - sourceSeconds) / speed
    : (sourceSeconds - mapping.inPoint) / speed;
  return mapping.startTime + Math.max(0, offset);
}

export interface ApplyRotoscopeOptions {
  maskId: string;
  /** Clip-local time mapping for the sampled source times. */
  timeMapping?: ClipTimeMapping;
  /** When the samples carry analysis-relative times, the analysis origin. */
  sampleOriginMs?: number;
  /** Existing keyframe times to merge with; used for idempotent re-application. */
  replaceExisting?: boolean;
}

/**
 * Writes a plan into a mask through `sink`. Returns the number of keyframes
 * written and the timeline range covered.
 */
export function applyRotoscopePlan(
  plan: RotoscopePlan,
  sink: RotoscopeKeyframeSink,
  options: ApplyRotoscopeOptions,
): { written: number; firstTimeSeconds: number | null; lastTimeSeconds: number | null } {
  const originMs = options.sampleOriginMs ?? 0;
  let written = 0;
  let first: number | null = null;
  let last: number | null = null;

  for (const keyframe of plan.keyframes) {
    const sourceSeconds = (keyframe.timeMs - originMs) / 1000;
    const timeSeconds = options.timeMapping
      ? sourceTimeToTimelineSeconds(sourceSeconds, options.timeMapping)
      : sourceSeconds;
    if (sink.addMaskKeyframe(options.maskId, timeSeconds, keyframe.path)) {
      written += 1;
      if (first === null || timeSeconds < first) first = timeSeconds;
      if (last === null || timeSeconds > last) last = timeSeconds;
    }
  }

  return { written, firstTimeSeconds: first, lastTimeSeconds: last };
}
