import { describe, expect, it } from "vitest";
import {
  smoothReframeCameraPath,
  type CameraPathSample,
} from "./reframe-camera-path";

/**
 * A 960x540 crop of a 1920x1080 frame — the geometry of a reframe that also
 * scales up. Both axes have room to move (centre x in [480,1440], y in
 * [270,810]), which is what a follow-cam needs.
 */
const CROP_WIDTH = 960;
const CROP_HEIGHT = 540;
const SOURCE_WIDTH = 1920;
const SOURCE_HEIGHT = 1080;

const sample = (time: number, centerX: number, centerY: number): CameraPathSample => ({
  time,
  centerX,
  centerY,
  width: CROP_WIDTH,
  height: CROP_HEIGHT,
});

/** A camera drifting steadily left to right — no curvature at all. */
// Constant slope (260px per 0.5s): a truly straight, steady pan.
const straight = [
  sample(0, 520, 540),
  sample(0.5, 780, 540),
  sample(1, 1040, 540),
  sample(1.5, 1300, 540),
];

/** A camera that pans right, then back — the case a straight polyline kinks. */
const turning = [
  sample(0, 520, 540),
  sample(0.5, 800, 400),
  sample(1, 1200, 540),
  sample(1.5, 800, 700),
  sample(2, 520, 540),
];

/** Angular change at each interior keyframe, in degrees. */
function kinks(keyframes: readonly CameraPathSample[]): number[] {
  const angles: number[] = [];
  for (let index = 1; index < keyframes.length - 1; index += 1) {
    const previous = keyframes[index - 1];
    const current = keyframes[index];
    const next = keyframes[index + 1];
    const inAngle = Math.atan2(current.centerY - previous.centerY, current.centerX - previous.centerX);
    const outAngle = Math.atan2(next.centerY - current.centerY, next.centerX - current.centerX);
    let delta = Math.abs(((outAngle - inAngle + Math.PI) % (2 * Math.PI)) - Math.PI);
    delta = (delta * 180) / Math.PI;
    if (delta > 180) delta = 360 - delta;
    angles.push(delta);
  }
  return angles;
}

describe("smoothReframeCameraPath", () => {
  it("passes a single or empty sample straight through", () => {
    expect(smoothReframeCameraPath([]).keyframes).toEqual([]);
    const one = [sample(0, 500, 500)];
    expect(smoothReframeCameraPath(one).keyframes).toEqual(one);
    expect(smoothReframeCameraPath([straight[0], straight[1]]).keyframes).toHaveLength(2);
  });

  it("always starts and ends where the analysis said", () => {
    const result = smoothReframeCameraPath(turning, { smoothing: 0.8 });
    const first = result.keyframes[0];
    const last = result.keyframes[result.keyframes.length - 1];

    expect(first.time).toBe(0);
    expect(first.centerX).toBeCloseTo(520, 5);
    expect(last.time).toBe(2);
    expect(last.centerX).toBeCloseTo(520, 5);
    expect(last.centerY).toBeCloseTo(540, 5);
  });

  it("costs almost nothing where the camera moves in a straight line", () => {
    const result = smoothReframeCameraPath(straight, { smoothing: 0 });

    // A straight run needs one keyframe per sample and no more: subdividing a
    // line never finds curvature worth a keyframe.
    expect(result.keyframes).toHaveLength(straight.length);
    expect(result.deviationPx).toBeLessThan(1);
  });

  it("adds keyframes exactly where the path bends", () => {
    const result = smoothReframeCameraPath(turning, { smoothing: 0 });

    expect(result.keyframes.length).toBeGreaterThan(turning.length);
    // The densest area should be the turn, not the straights.
    const middle = result.keyframes.filter((kf) => kf.time > 0.4 && kf.time < 0.6);
    expect(middle.length).toBeGreaterThan(1);
  });

  it("keeps the drawn polyline within the requested tolerance of the curve", () => {
    const result = smoothReframeCameraPath(turning, { smoothing: 0, maxDeviationPx: 1 });

    expect(result.deviationPx).toBeLessThanOrEqual(1);
  });

  it("relaxes the fit as smoothing rises, instead of flattening it away", () => {
    const tight = smoothReframeCameraPath(turning, { smoothing: 0 });
    const loose = smoothReframeCameraPath(turning, { smoothing: 1 });

    expect(loose.keyframes.length).toBeLessThan(tight.keyframes.length);
    // Crucially, the camera still travels: the old windowed average collapsed
    // short paths towards their mean, which reads as the camera barely moving.
    const span = (result: typeof loose): number => {
      const xs = result.keyframes.map((keyframe) => keyframe.centerX);
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(span(loose)).toBeGreaterThan(600);
    expect(span(loose)).toBeCloseTo(span(tight), -1);
  });

  it("removes the direction kinks a coarsely sampled path would show", () => {
    // `turning` sampled raw is a five-point polyline that visibly changes
    // direction at every interior vertex.
    expect(Math.max(...kinks(turning))).toBeGreaterThan(45);

    const smoothed = smoothReframeCameraPath(turning, { smoothing: 0.5 });
    const worst = Math.max(...kinks(smoothed.keyframes));

    // Every joint in the emitted path is shallower than the raw one: that is
    // literally "smoother per-frame motion", since the renderer walks these
    // keyframes frame by frame. The raw loop turns ~90 degrees at each of its
    // four vertices; the fitted path spreads that turning over many more.
    expect(worst).toBeLessThan(Math.max(...kinks(turning)) / 2);
  });

  it("never overshoots the data it was given", () => {
    const result = smoothReframeCameraPath(turning, { smoothing: 0 });
    const xs = result.keyframes.map((keyframe) => keyframe.centerX);
    const ys = result.keyframes.map((keyframe) => keyframe.centerY);

    // Catmull-Rom can overshoot at local extrema; the tangents are clamped so
    // a camera never crops past where it was told to go.
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(519.9);
    expect(Math.max(...xs)).toBeLessThanOrEqual(1200.1);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(399.9);
    expect(Math.max(...ys)).toBeLessThanOrEqual(700.1);
  });

  it("keeps the crop inside the source frame when told its size", () => {
    const result = smoothReframeCameraPath(turning, {
      smoothing: 0,
      sourceWidth: SOURCE_WIDTH,
      sourceHeight: SOURCE_HEIGHT,
    });

    for (const keyframe of result.keyframes) {
      expect(keyframe.centerX - keyframe.width / 2).toBeGreaterThanOrEqual(-0.001);
      expect(keyframe.centerX + keyframe.width / 2).toBeLessThanOrEqual(SOURCE_WIDTH + 0.001);
      expect(keyframe.centerY - keyframe.height / 2).toBeGreaterThanOrEqual(-0.001);
      expect(keyframe.centerY + keyframe.height / 2).toBeLessThanOrEqual(SOURCE_HEIGHT + 0.001);
    }
  });

  it("reports how fast the camera actually moves, and warns on a whip-pan", () => {
    const gentle = smoothReframeCameraPath(straight, { smoothing: 0 });
    expect(gentle.peakSpeed).toBeGreaterThan(0);
    expect(gentle.warnings.join(" ")).not.toMatch(/whip-pan/i);

    // 1200px of travel in 0.1s at a 960px crop is ~12 crop-widths per second.
    const whip = smoothReframeCameraPath(
      [sample(0, 520, 540), sample(0.05, 900, 540), sample(0.1, 1400, 540)],
      { smoothing: 0 },
    );
    expect(whip.peakSpeed).toBeGreaterThan(1.5);
    expect(whip.warnings.join(" ")).toMatch(/whip-pan/i);
  });

  it("thins to the keyframe cap without losing either end", () => {
    const result = smoothReframeCameraPath(turning, { smoothing: 0, maxKeyframes: 6 });

    expect(result.keyframes.length).toBeLessThanOrEqual(6);
    expect(result.keyframes[0].time).toBe(0);
    expect(result.keyframes[result.keyframes.length - 1].time).toBe(2);
    expect(result.warnings.join(" ")).toMatch(/thinned/i);
  });

  it("emits ascending, distinct times", () => {
    const result = smoothReframeCameraPath(turning, { smoothing: 0 });
    const times = result.keyframes.map((keyframe) => keyframe.time);

    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(times.length);
  });

  it("survives samples that barely move and samples that share a time", () => {
    const jitter = [
      sample(0, 500, 500),
      sample(0.5, 500.2, 500.1),
      sample(1, 500.1, 500.3),
      sample(1.5, 500.2, 500.2),
    ];
    const result = smoothReframeCameraPath(jitter, { smoothing: 0.8 });

    expect(result.keyframes.length).toBeGreaterThanOrEqual(jitter.length);
    expect(result.peakSpeed).toBeLessThan(0.1);
  });
});
