import type { CameraMotionSample } from "@kove-advanced/core/vision/camera-motion-extractor";
import type { ReferenceProfile, ShotProfile } from "@kove-advanced/core/mirror/reference-profile";
import { frameToSeconds, shotDurationFrames } from "@kove-advanced/core/mirror/timebase";

/** Per-frame motion measurement compiled into the editable transform the timeline writes.
 * One entry per kept keyframe TIME; all properties share the same times because the
 * integrator's move is one coupled transform, so the inspector sees one curve. */
export interface IntegratedSample {
  readonly time: number;
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly zoom: number;
}

export interface KeyframeDraft {
  readonly time: number;
  readonly property: string;
  readonly value: number;
}

/** Invisible-motion thresholds, one per component. x/y are fractions of the
 * frame's width/height, angle is degrees, zoom is a ratio. A trajectory whose
 * total excursion stays within these is invisible; keyframing it only adds
 * inspector noise and render cost, so it is dropped entirely. */
const TOLERANCE = { x: 0.015, y: 0.015, angle: 2, zoom: 0.015 } as const;

/** Five transform properties are written per time; three times caps a shot at 15 keyframes. */
export const MAX_KEYFRAME_TIMES_PER_SHOT = 3;

export const MIN_MOTION_MAGNITUDE = 0.015;

/** Compiles a shot's measured camera-motion samples into the same integrated
 * transform series `applyEditDNA` writes, preserving the original integration
 * order (inverted reference-frame motion) and its validity filtering. The
 * result always starts with the t=0 baseline. */
export function integrateMotionSeries(
  samples: readonly CameraMotionSample[],
  shot: ShotProfile,
  fps: ReferenceProfile["fps"],
  aspectRatio: ReferenceProfile["aspectRatio"],
): IntegratedSample[] {
  const duration = frameToSeconds(shotDurationFrames(shot), fps);
  // Seed replicates the former t=0 baseline so simplification endpoints anchor the curve.
  const series: IntegratedSample[] = [{ time: 0, x: 0, y: 0, angle: 0, zoom: 1 }];
  let x = 0, y = 0, angle = 0, zoom = 1;
  for (const sample of samples) {
    // Invert reference frame motion to reproduce the camera's virtual move on new footage.
    x -= sample.translateX / aspectRatio.width;
    y -= sample.translateY / aspectRatio.height;
    angle -= sample.rotationRad * 180 / Math.PI;
    zoom /= sample.scale || 1;
    const time = frameToSeconds(sample.frame - shot.startFrame, fps);
    if (time <= 0 || time > duration || ![x, y, angle, zoom].every(Number.isFinite)) continue;
    series.push({ time, x, y, angle, zoom });
  }
  return series;
}

/** Compiles the integrated series into timeline keyframes across the five
 * transform properties. Near-static shots produce none; dynamic shots keep
 * their first/last times and peak excursions, with the number of keyframe
 * times capped by escalating the error budget. */
export function simplifyMotionKeyframes(
  series: readonly IntegratedSample[],
): KeyframeDraft[] {
  if (series.length <= 1) return [];
  const components = [
    series.map((point) => point.x),
    series.map((point) => point.y),
    series.map((point) => point.angle),
    series.map((point) => point.zoom),
  ] as const;
  // Entire-shot static: compare each component's total excursion against its
  // invisible-motion threshold. (Angle and zoom baselines differ from x/y.)
  const baselines = [0, 0, 0, 1] as const;
  const tolerances = [TOLERANCE.x, TOLERANCE.y, TOLERANCE.angle, TOLERANCE.zoom] as const;
  const isStatic = components.every((values, component) =>
    values.every((value) => Math.abs(value - baselines[component]) <= tolerances[component]));
  if (isStatic) return [];
  const toleranceFor = (component: number): number => tolerances[component];
  // Ramer–Douglas–Peucker over the four coupled components: a point is kept
  // when ANY component deviates from the linear chord between kept neighbours
  // by more than `epsilon` tolerance-units (component error normalized by its
  // threshold so one epsilon spans degrees, zoom, and frame fractions).
  const deviation = (lo: number, hi: number, index: number): number => {
    const from = series[lo], to = series[hi], current = series[index];
    const span = to.time - from.time;
    const t = span > 0 ? (current.time - from.time) / span : 0;
    let worst = 0;
    for (let component = 0; component < 4; component++) {
      const key = COMPONENT_KEYS[component];
      const expected = from[key] + (to[key] - from[key]) * t;
      const actual = components[component][index];
      worst = Math.max(worst, Math.abs(actual - expected) / toleranceFor(component));
    }
    return worst;
  };
  const kept = new Set<number>([0, series.length - 1]);
  let strongestInteriorIndex = -1;
  let strongestInteriorStep = 0;
  for (let index = 1; index < series.length - 1; index++) {
    let step = 0;
    for (let component = 0; component < components.length; component++) {
      step = Math.max(
        step,
        Math.abs(components[component][index] - components[component][index - 1]) /
          tolerances[component],
      );
    }
    if (step > strongestInteriorStep) {
      strongestInteriorStep = step;
      strongestInteriorIndex = index;
    }
  }
  if (strongestInteriorStep > 1 && strongestInteriorIndex >= 0) kept.add(strongestInteriorIndex);
  if (series.length > 2) {
    const split = (lo: number, hi: number): void => {
      let worstIndex = -1, worstDeviation = 0;
      for (let index = lo + 1; index < hi; index++) {
        const value = deviation(lo, hi, index);
        if (value > worstDeviation) { worstDeviation = value; worstIndex = index; }
      }
      if (worstDeviation > epsilonFor()) {
        kept.add(worstIndex);
        split(lo, worstIndex);
        split(worstIndex, hi);
      }
    };
    // Start with the invisible-motion budget (=1 since deviations are already
    // normalized by tolerance), then escalate until the count fits the cap.
    let epsilon = 1;
    const epsilonFor = (): number => epsilon;
    split(0, series.length - 1);
    while (kept.size > MAX_KEYFRAME_TIMES_PER_SHOT) {
      epsilon *= 1.5;
      if (epsilon > 1e12) throw new Error("Motion keyframe simplification failed to converge");
      kept.clear();
      kept.add(0);
      kept.add(series.length - 1);
      if (strongestInteriorStep > 1 && strongestInteriorIndex >= 0) kept.add(strongestInteriorIndex);
      split(0, series.length - 1);
    }
  }
  return [...kept].sort((a, b) => a - b).flatMap((index) => {
    const point = series[index];
    return ([
      ["position.x", point.x], ["position.y", point.y], ["rotation", point.angle],
      ["scale.x", point.zoom], ["scale.y", point.zoom],
    ] as const).map(([property, value]) => ({ time: point.time, property, value }));
  });
}

/** Convert normalized motion to canvas pixels and retain enough overscan to
 * cover every canvas corner throughout the measured transform curve. */
export function coverSafeMotionKeyframes(
  keyframes: readonly KeyframeDraft[],
  series: readonly IntegratedSample[],
  source: { readonly width: number; readonly height: number },
  canvas: { readonly width: number; readonly height: number },
): KeyframeDraft[] {
  if (!keyframes.length) return [];
  if (
    ![source.width, source.height, canvas.width, canvas.height].every(Number.isFinite) ||
    source.width <= 0 ||
    source.height <= 0 ||
    canvas.width <= 0 ||
    canvas.height <= 0
  ) {
    throw new Error("Cannot calculate motion overscan without valid source and canvas dimensions");
  }

  const coverScale = Math.max(canvas.width / source.width, canvas.height / source.height);
  const drawWidth = source.width * coverScale;
  const drawHeight = source.height * coverScale;
  let overscan = 1;
  for (const point of series) {
    if (![point.x, point.y, point.angle, point.zoom].every(Number.isFinite) || point.zoom <= 0) {
      throw new Error("Cannot calculate motion overscan from an invalid transform sample");
    }
    const positionX = point.x * canvas.width;
    const positionY = point.y * canvas.height;
    const cos = Math.cos((point.angle * Math.PI) / 180);
    const sin = Math.sin((point.angle * Math.PI) / 180);
    for (const cornerX of [-canvas.width / 2, canvas.width / 2]) {
      for (const cornerY of [-canvas.height / 2, canvas.height / 2]) {
        const x = cornerX - positionX;
        const y = cornerY - positionY;
        const sourceX = cos * x + sin * y;
        const sourceY = -sin * x + cos * y;
        overscan = Math.max(
          overscan,
          Math.abs(sourceX) / (drawWidth * point.zoom / 2),
          Math.abs(sourceY) / (drawHeight * point.zoom / 2),
        );
      }
    }
  }
  overscan *= 1.005;

  return keyframes.map((keyframe) => ({
    ...keyframe,
    value:
      keyframe.property === "position.x"
        ? keyframe.value * canvas.width
        : keyframe.property === "position.y"
          ? keyframe.value * canvas.height
          : keyframe.property === "scale.x" || keyframe.property === "scale.y"
            ? keyframe.value * overscan
            : keyframe.value,
  }));
}

const COMPONENT_KEYS = ["x", "y", "angle", "zoom"] as const;
