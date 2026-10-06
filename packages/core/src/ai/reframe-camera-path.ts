/**
 * Smoothing the auto-reframe camera path.
 *
 * `AutoReframeEngine.analyzeClip` decides where the camera should look once per
 * *sampled* frame (a few hundred milliseconds apart). What actually reaches the
 * screen is the polyline the renderer draws between those keyframes, so a
 * coarsely sampled path shows its joints: the camera visibly changes direction
 * at every keyframe, and a fast subject can move further between two samples
 * than the eye will accept as continuous motion.
 *
 * Denser sampling alone does not fix that — it costs decode time and adds
 * keyframes where the camera is barely moving. This module does the opposite:
 * fit a smooth curve through the samples, then place keyframes only where the
 * curve actually bends, densely enough that the polyline the renderer draws
 * stays within a pixel tolerance of it.
 *
 * Pure and canvas-free: samples in, keyframes out.
 */

/** Where the camera was told to look at one sampled frame. */
export interface CameraPathSample {
  /** Source seconds. */
  readonly time: number;
  /** Crop centre in source pixels. */
  readonly centerX: number;
  readonly centerY: number;
  /** Crop size in source pixels. */
  readonly width: number;
  readonly height: number;
}

export interface CameraPathOptions {
  /**
   * 0..1 — how far the emitted polyline may relax away from the samples.
   * Higher values trade faithfulness for a gentler camera: the deviation
   * tolerance grows, so fewer keyframes are emitted and small jitters are
   * smoothed over rather than reproduced. Default 0.8.
   */
  readonly smoothing?: number;
  /**
   * Deviation tolerance at `smoothing: 0`, in source pixels. Default 1.5 —
   * below half a pixel of visible error at 1080p.
   */
  readonly maxDeviationPx?: number;
  /** Hard cap on emitted keyframes. Default 240. */
  readonly maxKeyframes?: number;
  /**
   * Source frame size, used to keep the fitted crop inside the frame. Without
   * it the spline is still clamped to the samples' own bounding range, which
   * never overshoots the data but can drift off-frame.
   */
  readonly sourceWidth?: number;
  readonly sourceHeight?: number;
  /**
   * Camera speed above this many crop-widths per second is reported as a
   * warning: no amount of smoothing makes a whip-pan comfortable.
   * Default 1.5.
   */
  readonly maxComfortableSpeed?: number;
}

export interface CameraPathKeyframe {
  readonly time: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly width: number;
  readonly height: number;
}

export interface CameraPathResult {
  readonly keyframes: CameraPathKeyframe[];
  /** Largest gap between the fitted curve and the polyline it became, in px. */
  readonly deviationPx: number;
  /** Fastest camera motion, in crop-widths per second. */
  readonly peakSpeed: number;
  readonly warnings: readonly string[];
}

interface Curve {
  /** Evaluate the spline at a source time. */
  at(time: number): { centerX: number; centerY: number; width: number; height: number };
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

/**
 * Cubic Hermite interpolation of one channel, tangents per unit time.
 *
 * `h` is the segment duration; the tangents are already scaled by it, which is
 * what makes this the non-uniform Catmull-Rom form (the samples are evenly
 * spaced today, but the reframe pipeline is allowed not to be).
 */
function hermite(p0: number, p1: number, m0: number, m1: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * m1
  );
}

/**
 * Monotone cubic (Fritsch–Carlson) tangent at `index`, scaled by the span.
 *
 * Plain Catmull-Rom overshoots at local extrema: the tangent it computes at a
 * turning point still points the way the camera was travelling, so the fitted
 * path sails past the sample before coming back. For a camera that means
 * cropping beyond where the analysis said the subject was, then correcting —
 * a visible wobble. Monotone limiting zeroes the tangent at an extremum and
 * caps it elsewhere, which is the standard guarantee that the curve never
 * leaves the range of the data it interpolates.
 *
 * Endpoints use their one-sided slope so the camera does not have to start and
 * stop dead.
 */
function tangent(
  values: readonly number[],
  times: readonly number[],
  index: number,
  span: number,
): number {
  const last = values.length - 1;
  const at = (i: number): number => values[clamp(i, 0, last)];
  const timeAt = (i: number): number => times[clamp(i, 0, last)];

  const spanPrev = Math.max(1e-6, timeAt(index) - timeAt(index - 1));
  const spanNext = Math.max(1e-6, timeAt(index + 1) - timeAt(index));

  const slopeNext = (at(index + 1) - at(index)) / spanNext;
  const slopePrev =
    index === 0 ? slopeNext : (at(index) - at(index - 1)) / spanPrev;
  const following = index === last ? slopePrev : slopeNext;
  const leading = index === 0 ? slopeNext : slopePrev;

  if (leading * following <= 0) return 0;

  const average = (leading + following) / 2;
  const limit = 3 * Math.min(Math.abs(leading), Math.abs(following));
  const magnitude = Math.min(Math.abs(average), limit);

  return Math.sign(average) * magnitude * span;
}

/**
 * Fit a Catmull-Rom curve through the samples, one independent curve per
 * channel (centre x/y and crop size), all parameterised by source time.
 */
function fitCurve(samples: readonly CameraPathSample[]): Curve {
  const times = samples.map((sample) => sample.time);
  const channels = ["centerX", "centerY", "width", "height"] as const;
  const series = Object.fromEntries(
    channels.map((channel) => [channel, samples.map((sample) => sample[channel])]),
  ) as Record<(typeof channels)[number], number[]>;

  return {
    at(time: number) {
      // Locate the segment; the caller only evaluates inside the sample range.
      let index = 0;
      while (index < times.length - 2 && times[index + 1] < time) index += 1;
      index = Math.min(index, samples.length - 2);

      const span = Math.max(1e-6, times[index + 1] - times[index]);
      const t = clamp((time - times[index]) / span, 0, 1);

      const evaluate = (channel: (typeof channels)[number]): number => {
        const values = series[channel];
        return hermite(
          values[index],
          values[index + 1],
          tangent(values, times, index, span),
          tangent(values, times, index + 1, span),
          t,
        );
      };

      return {
        centerX: evaluate("centerX"),
        centerY: evaluate("centerY"),
        width: evaluate("width"),
        height: evaluate("height"),
      };
    },
  };
}

type Point = { centerX: number; centerY: number; width: number; height: number };

/** Distance between two camera states, in source pixels. */
function distance(a: Point, b: Point): number {
  return Math.hypot(a.centerX - b.centerX, a.centerY - b.centerY, a.width - b.width, a.height - b.height);
}

function midpoint(a: Point, b: Point): Point {
  return {
    centerX: (a.centerX + b.centerX) / 2,
    centerY: (a.centerY + b.centerY) / 2,
    width: (a.width + b.width) / 2,
    height: (a.height + b.height) / 2,
  };
}

/**
 * Fit a smooth camera path through the samples and flatten it into keyframes.
 *
 * Each spline segment is subdivided until the chord through it is within
 * `tolerancePx` of the curve, so the linear interpolation the renderer performs
 * between the returned keyframes tracks a smooth path within that error. A
 * straight run of samples costs two keyframes; a fast curve costs many.
 */
export function smoothReframeCameraPath(
  samples: readonly CameraPathSample[],
  options: CameraPathOptions = {},
): CameraPathResult {
  const warnings: string[] = [];
  if (samples.length === 0) {
    return { keyframes: [], deviationPx: 0, peakSpeed: 0, warnings };
  }
  if (samples.length <= 2) {
    // Nothing to fit: two points have exactly one smooth path between them.
    return {
      keyframes: samples.map((sample) => ({ ...sample })),
      deviationPx: 0,
      peakSpeed: 0,
      warnings,
    };
  }

  const smoothing = clamp(options.smoothing ?? 0.8, 0, 1);
  const baseTolerance = Math.max(0.1, options.maxDeviationPx ?? 1.5);
  // The tolerance stays tight as smoothing rises. Widening it instead would
  // trade keyframes away, and since the renderer interpolates linearly, fewer
  // keyframes means a *less* smooth path — the opposite of what the knob says.
  const tolerance = Math.max(0.1, baseTolerance * (1 + smoothing * 2));
  const maxKeyframes = Math.max(2, options.maxKeyframes ?? 240);
  const comfortSpeed = options.maxComfortableSpeed ?? 1.5;

  // Jitter removal is a separate step from flattening: a light moving average
  // over the samples absorbs per-frame detection noise, so the curve that gets
  // fitted is the camera move rather than the detector's wobble.
  //
  // The window is capped at a third of the samples. An uncapped window is what
  // the previous implementation did, and it averaged short clips towards their
  // own mean — the camera looked like it had stopped following the subject.
  const radius = Math.min(
    Math.round(smoothing * 4),
    Math.max(0, Math.floor(samples.length / 6)),
  );
  const points = samples.map((sample, index) => {
    if (radius === 0 || index === 0 || index === samples.length - 1) return { ...sample };
    const start = Math.max(0, index - radius);
    const end = Math.min(samples.length - 1, index + radius);
    let centerX = 0;
    let centerY = 0;
    let width = 0;
    let height = 0;
    let count = 0;
    for (let j = start; j <= end; j += 1) {
      centerX += samples[j].centerX;
      centerY += samples[j].centerY;
      width += samples[j].width;
      height += samples[j].height;
      count += 1;
    }
    return {
      time: sample.time,
      centerX: centerX / count,
      centerY: centerY / count,
      width: width / count,
      height: height / count,
    };
  });

  const curve = fitCurve(points);

  // Bounds for the crop's centre. The samples' own extent is the primary bound
  // (it is what the engine already decided, and staying inside it is what stops
  // the fit from sailing past the subject); the source frame is a safety net for
  // the endpoints. An axis whose crop fills the frame has no freedom at all, so
  // it is pinned rather than silently losing its motion.
  const band = (axis: "x" | "y"): { lo: number; hi: number } => {
    const size = axis === "x" ? options.sourceWidth : options.sourceHeight;
    const half = (point: Point): number => (axis === "x" ? point.width : point.height) / 2;
    const edge = (point: Point, side: -1 | 1): number =>
      (axis === "x" ? point.centerX : point.centerY) + side * half(point);

    const lo = size === undefined ? -Infinity : Math.max(0, Math.min(...points.map((p) => edge(p, -1))));
    const hi = size === undefined ? Infinity : Math.min(size, Math.max(...points.map((p) => edge(p, 1))));
    return { lo, hi };
  };

  const bandX = band("x");
  const bandY = band("y");

  const clampPoint = (point: Point): Point => {
    const halfWidth = point.width / 2;
    const halfHeight = point.height / 2;
    return {
      ...point,
      centerX: clamp(point.centerX, bandX.lo + halfWidth, Math.max(bandX.lo + halfWidth, bandX.hi - halfWidth)),
      centerY: clamp(point.centerY, bandY.lo + halfHeight, Math.max(bandY.lo + halfHeight, bandY.hi - halfHeight)),
    };
  };

  // How far the crop's *centre* may travel on each axis: the band it must stay
  // inside, minus its own size. A crop that fills an axis of the frame has none
  // — that is the normal case for a 9:16 crop of 16:9 footage (vertical freedom:
  // zero) and worth saying out loud rather than letting the axis go quietly flat.
  const averageSize = (axis: "width" | "height"): number =>
    points.reduce((sum, point) => sum + point[axis], 0) / points.length;
  const freedomX = bandX.hi - bandX.lo - averageSize("width");
  const freedomY = bandY.hi - bandY.lo - averageSize("height");

  for (const [axis, freedom] of [
    ["horizontal", freedomX],
    ["vertical", freedomY],
  ] as const) {
    if (freedom < 1) {
      warnings.push(
        `The crop fills the frame ${axis}ly, so the camera has no ${axis} freedom to move on this axis.`,
      );
    }
  }

  const times = points.map((point) => point.time);
  const emitted: CameraPathKeyframe[] = [points[0]];
  let deviationPx = 0;

  const flatten = (startTime: number, endTime: number, start: Point, end: Point, depth: number): void => {
    // Depth guard: a degenerate (zero-length but numerically noisy) segment
    // must not recurse forever.
    if (depth > 12) return;
    const midTime = (startTime + endTime) / 2;
    const curveMid = clampPoint(curve.at(midTime));
    const chordMid = midpoint(start, end);
    const error = distance(curveMid, chordMid);

    if (error <= tolerance) {
      deviationPx = Math.max(deviationPx, error);
      return;
    }
    flatten(startTime, midTime, start, curveMid, depth + 1);
    emitted.push({ time: midTime, ...curveMid });
    flatten(midTime, endTime, curveMid, end, depth + 1);
  };

  for (let index = 0; index < points.length - 1; index += 1) {
    flatten(times[index], times[index + 1], points[index], points[index + 1], 0);
    emitted.push(points[index + 1]);
  }

  // Enforce the cap by thinning evenly, always keeping both ends so the camera
  // still starts and ends where the analysis said.
  let keyframes = emitted;
  if (keyframes.length > maxKeyframes) {
    const last = keyframes.length - 1;
    const kept: CameraPathKeyframe[] = [];
    const seen = new Set<number>();
    for (let step = 0; step < maxKeyframes; step += 1) {
      const source = Math.round((step * last) / (maxKeyframes - 1));
      if (seen.has(source)) continue;
      seen.add(source);
      kept.push(keyframes[source]);
    }
    warnings.push(
      `The camera path was thinned from ${keyframes.length} to ${kept.length} keyframe(s); raise maxKeyframes for a closer fit.`,
    );
    keyframes = kept;
  }

  let peakSpeed = 0;
  for (let index = 1; index < keyframes.length; index += 1) {
    const previous = keyframes[index - 1];
    const current = keyframes[index];
    const dt = Math.max(1e-6, current.time - previous.time);
    const travelled = Math.hypot(
      current.centerX - previous.centerX,
      current.centerY - previous.centerY,
    );
    const cropWidth = Math.max(1, (current.width + previous.width) / 2);
    peakSpeed = Math.max(peakSpeed, travelled / cropWidth / dt);
  }
  if (peakSpeed > comfortSpeed) {
    warnings.push(
      `The camera crosses ${peakSpeed.toFixed(2)} crop-widths per second at its fastest; that reads as a whip-pan however smooth the path is. Lower trackingSpeed or widen the sampling window.`,
    );
  }

  return { keyframes, deviationPx, peakSpeed, warnings };
}
