/**
 * Turning an auto-reframe plan into clip transform keyframes.
 *
 * `AutoReframeEngine.analyzeClip` decides *where the camera should look*: for
 * every analyzed frame it emits a crop rectangle in normalized source space.
 * The renderer, though, knows nothing about crops — it draws a clip from its
 * `transform` (position, scale), interpolated over `position.x` / `position.y`
 * / `scale.x` / `scale.y` keyframes.
 *
 * This module is the bridge. It is deliberately pure: given the plan and the
 * geometry that matters to the renderer (media size, canvas size, fit mode), it
 * returns the transform keyframes, so the arithmetic can be unit-tested without
 * a canvas, a decoder or a browser.
 */

import type { ClipTimeMapping } from "./rotoscope";
import { sourceTimeToTimelineSeconds } from "./rotoscope";
import type { Keyframe } from "../types/timeline";

/** Only the parts of a `ReframeKeyframe` the mapping needs. */
export interface ReframeCropKeyframe {
  /** Source seconds this crop was chosen for. */
  readonly time: number;
  readonly cropX: number;
  readonly cropY: number;
  readonly cropWidth: number;
  readonly cropHeight: number;
}

export type ReframeFitMode = "contain" | "cover" | "stretch" | "none";

export interface ReframeApplyGeometry {
  /** Source media dimensions in pixels. */
  readonly mediaWidth: number;
  readonly mediaHeight: number;
  /** Project canvas dimensions in pixels. */
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  /**
   * How the renderer fits the media into the canvas before `transform.scale`
   * is applied. Matches `ClipTransform.fitMode`; `"none"` behaves like
   * `"contain"`, exactly as the renderer does.
   */
  readonly fitMode?: ReframeFitMode;
}

export interface ReframeApplyOptions {
  /**
   * Source→timeline mapping (clip start, in-point, speed, reverse). Reframe
   * keyframes live on the clip-local clock the renderer interpolates.
   */
  readonly timeMapping?: ClipTimeMapping;
  /** Id factory for the emitted keyframes. */
  readonly createId?: () => string;
  /**
   * A new keyframe is only emitted when at least one of its four values moves
   * by more than this (in normalized units). The engine already smooths its
   * crop path; this thins out the frames where nothing actually moved.
   * Default 0.002 (~2 px on a 1080-wide canvas).
   */
  readonly minChange?: number;
  /** Cap on emitted keyframes. The last one is always kept. */
  readonly maxKeyframes?: number;
}

/** Properties the renderer interpolates for a clip transform. */
export const REFRAME_KEYFRAME_PROPERTIES = [
  "position.x",
  "position.y",
  "scale.x",
  "scale.y",
] as const;

interface FitSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Size the media is drawn at before `transform.scale`, as a fraction of the
 * canvas. Mirrors the fit math in the preview renderer so a reframed clip lands
 * where the crop said it should.
 */
export function reframeBaseSize(
  geometry: ReframeApplyGeometry,
): FitSize {
  const { mediaWidth, mediaHeight, canvasWidth, canvasHeight } = geometry;
  const fitMode = !geometry.fitMode || geometry.fitMode === "none" ? "contain" : geometry.fitMode;
  const canvasAspect = canvasWidth / canvasHeight;
  const mediaAspect = mediaWidth / mediaHeight;

  if (fitMode === "stretch") return { width: 1, height: 1 };

  if (fitMode === "cover") {
    return mediaAspect > canvasAspect
      ? { width: mediaAspect / canvasAspect, height: 1 }
      : { width: 1, height: canvasAspect / mediaAspect };
  }

  // contain
  return mediaAspect > canvasAspect
    ? { width: 1, height: canvasAspect / mediaAspect }
    : { width: mediaAspect / canvasAspect, height: 1 };
}

interface TransformSample {
  positionX: number;
  positionY: number;
  scale: number;
}

/**
 * The transform that makes one crop rect fill the canvas.
 *
 * `position` is an offset from the canvas centre expressed as a fraction of the
 * canvas (the renderer translates by `position * canvasSize`), and the anchor
 * is the clip centre, so the shift that brings the crop centre to the middle of
 * the frame is the negated, scaled offset of that centre.
 */
export function reframeTransformForCrop(
  crop: ReframeCropKeyframe,
  geometry: ReframeApplyGeometry,
): TransformSample {
  const base = reframeBaseSize(geometry);
  const cropWidth = Math.max(1e-4, crop.cropWidth);
  const cropHeight = Math.max(1e-4, crop.cropHeight);

  // Cover rather than contain: never leave a letterbox inside the crop.
  const scale = Math.max(1 / (base.width * cropWidth), 1 / (base.height * cropHeight));

  const cropCenterX = crop.cropX + cropWidth / 2;
  const cropCenterY = crop.cropY + cropHeight / 2;

  return {
    positionX: -(cropCenterX - 0.5) * base.width * scale,
    positionY: -(cropCenterY - 0.5) * base.height * scale,
    scale,
  };
}

function isSameSample(a: TransformSample, b: TransformSample, tolerance: number): boolean {
  return (
    Math.abs(a.positionX - b.positionX) <= tolerance &&
    Math.abs(a.positionY - b.positionY) <= tolerance &&
    Math.abs(a.scale - b.scale) <= tolerance
  );
}

/**
 * Convert reframe crop keyframes into clip transform keyframes.
 *
 * Emits four keyframes per kept sample (one per animated property) so the
 * renderer's per-property interpolation applies. Consecutive samples that do
 * not move are dropped, and a plan that never moves at all produces a single
 * static keyframe per property (a centred, scaled clip) rather than hundreds.
 */
export function reframePlanToTransformKeyframes(
  cropKeyframes: readonly ReframeCropKeyframe[],
  geometry: ReframeApplyGeometry,
  options: ReframeApplyOptions = {},
): Keyframe[] {
  if (cropKeyframes.length === 0) return [];

  const createId = options.createId ?? (() => crypto.randomUUID());
  const tolerance = options.minChange ?? 0.002;
  const maxKeyframes = Math.max(1, options.maxKeyframes ?? 600);
  const timeMapping = options.timeMapping;

  const samples: { time: number; sample: TransformSample }[] = [];
  for (const crop of cropKeyframes) {
    const time = timeMapping
      ? sourceTimeToTimelineSeconds(crop.time, timeMapping)
      : crop.time;
    const sample = reframeTransformForCrop(crop, geometry);
    const previous = samples[samples.length - 1];
    if (previous && isSameSample(previous.sample, sample, tolerance)) continue;
    samples.push({ time, sample });
  }
  if (samples.length === 0 && cropKeyframes.length > 0) {
    samples.push({
      time: timeMapping ? sourceTimeToTimelineSeconds(cropKeyframes[0].time, timeMapping) : cropKeyframes[0].time,
      sample: reframeTransformForCrop(cropKeyframes[0], geometry),
    });
  }

  const dropped = samples.length - maxKeyframes;
  const kept =
    dropped > 0 ? samples.filter((_, index) => index % Math.ceil(samples.length / maxKeyframes) === 0) : samples;

  const result: Keyframe[] = [];
  for (const { time, sample } of kept) {
    const values: Record<(typeof REFRAME_KEYFRAME_PROPERTIES)[number], number> = {
      "position.x": round(sample.positionX),
      "position.y": round(sample.positionY),
      "scale.x": round(sample.scale),
      "scale.y": round(sample.scale),
    };
    for (const property of REFRAME_KEYFRAME_PROPERTIES) {
      result.push({
        id: createId(),
        time: round(time),
        property,
        value: values[property],
        easing: "linear",
      });
    }
  }
  return result;
}

/** Stable identity transform keyframes — what a "no movement" reframe writes. */
export function staticReframeKeyframes(
  timeSeconds: number,
  createId: () => string = () => crypto.randomUUID(),
): Keyframe[] {
  return REFRAME_KEYFRAME_PROPERTIES.map((property) => ({
    id: createId(),
    time: round(timeSeconds),
    property,
    value: property === "position.x" || property === "position.y" ? 0 : 1,
    easing: "linear" as const,
  }));
}

function round(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}
