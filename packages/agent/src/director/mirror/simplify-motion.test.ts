import { describe, expect, it } from "vitest";
import type { CameraMotionSample } from "@kove-advanced/core/vision/camera-motion-extractor";
import { integrateMotionSeries, MAX_KEYFRAME_TIMES_PER_SHOT, simplifyMotionKeyframes } from "./simplify-motion";

const fps = { num: 30, den: 1 } as const;
const aspect = { width: 1080, height: 1920 };
const bounds = (startFrame: number, endFrame: number) => ({ startFrame, endFrame, captionWindows: [] as never[] });
const sample = (frame: number, translateX = 2, translateY = 0, rotationRad = 0, scale = 1): CameraMotionSample => ({ frame, translateX, translateY, rotationRad, scale });
const times = (keyframes: Array<{ time: number }>) => [...new Set(keyframes.map((k) => k.time))].sort((a, b) => a - b);
const lastTime = (frames: number) => frames / fps.num;

describe("integrateMotionSeries", () => {
  it("integrates inverted translated motion from the t=0 seed", () => {
    const series = integrateMotionSeries([sample(5), sample(15)], bounds(0, 30), fps, aspect);
    expect(series[0]).toEqual({ time: 0, x: 0, y: 0, angle: 0, zoom: 1 });
    expect(series[1].x).toBeCloseTo(-2 / 1080, 12);
    expect(series[1].time).toBeCloseTo(5 / 30, 12);
    expect(series[2].x).toBeCloseTo(-4 / 1080, 12);
    expect(series[2].zoom).toBe(1);
  });

  it("advances accumulators for out-of-shot frames but only publishes in-shot times", () => {
    const series = integrateMotionSeries(
      [sample(0), sample(10, 3), sample(35)],
      bounds(0, 30),
      fps,
      aspect,
    );
    // frame 0 lands exactly on t=0 (filtered), frame 35 lands past the end (filtered),
    // but both still move the accumulators — so the surviving middle entry holds both deltas.
    expect(series).toHaveLength(2);
    expect(series[1].x).toBeCloseTo(-(2 + 3) / 1080, 12);
    expect(series[1].time).toBeCloseTo(10 / 30, 12);
  });

  it("drops the whole return when every sampled frame is out of shot", () => {
    const series = integrateMotionSeries([sample(50)], bounds(0, 30), fps, aspect);
    expect(series).toHaveLength(1);
    expect(simplifyMotionKeyframes(series)).toEqual([]);
  });
});

describe("simplifyMotionKeyframes", () => {
  it("drops near-static excursions entirely", () => {
    // 3 × 0.2px on a 1080-wide frame = 0.0006 of width: below the invisible threshold.
    const samples = Array.from({ length: 3 }, (_, i) => sample(i + 1, 0.2));
    const series = integrateMotionSeries(samples, bounds(0, 30), fps, aspect);
    expect(simplifyMotionKeyframes(series)).toEqual([]);
  });

  it("keeps first/last times and a mid-curve spike on a dense measured shot", () => {
    // 118 in-shot samples across frames 4..121 — a per-frame handheld camera with
    // a large swing at frame 60; a frame-by-frame compile would wall the clip.
    const samples = Array.from({ length: 118 }, (_, i): CameraMotionSample => {
      const frame = i + 4;
      return sample(frame, frame === 60 ? 3 + 0.3 * aspect.width : 3, 0, 0, 1.0005 ** frame);
    });
    const series = integrateMotionSeries(samples, bounds(0, 121), fps, aspect);
    const keyframes = simplifyMotionKeyframes(series);
    const keptTimes = times(keyframes);
    expect(keptTimes[0]).toBe(0);
    expect(keptTimes.at(-1)).toBeCloseTo(lastTime(121), 10);
    expect(keyframes.length).toBeGreaterThan(10);
    const spike = keyframes.find((k) => k.property === "position.x" && k.time > 59 / 30 && k.time < 61 / 30);
    expect(spike).toBeDefined();
    expect(spike!.value).toBeLessThan(-0.25);
    for (const time of keptTimes) {
      for (const property of ["position.x", "position.y", "rotation", "scale.x", "scale.y"]) {
        expect(keyframes.some((k) => k.time === time && k.property === property)).toBe(true);
      }
    }
  });

  it("caps keyframe times regardless of sample density", () => {
    // Bouncing handheld motion: nonmonotonic integrated trajectory whose every
    // intermediate point deviates above tolerance, forcing cap escalation.
    const samples = Array.from({ length: 300 }, (_, i) => {
      const swing = i % 2 === 0 ? 1 : -1;
      return sample(i + 1, 13 * swing, 0, 0.05 * swing, 1.002 ** (i % 5));
    });
    const series = integrateMotionSeries(samples, bounds(0, 301), fps, aspect);
    expect(times(simplifyMotionKeyframes(series)).length).toBeLessThanOrEqual(MAX_KEYFRAME_TIMES_PER_SHOT);
  });
});
