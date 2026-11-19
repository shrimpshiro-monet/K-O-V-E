import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { cubicBezier } from "@kove-advanced/core/animation/easing-functions";
import {
  fittedCardKeyframes,
  fittedEasing,
  loadMotionDna,
  parseMotionDna,
  steppedCardKeyframes,
} from "./motion-dna";

const DNA = resolve("../../evaluation-files/test-b/motion/dna/band-reveal.json");

const minimal = {
  role: "card",
  channel: "visibleHeight",
  from: 0,
  to: 1,
  durationFrames: 8,
  durationSeconds: 0.4444,
  fps: 18,
  profile: "smooth",
  fit: { family: "linear", params: {}, rmse: 0, bic: 0, samples: 2 },
  samples: [
    { t: 0, value: 0 },
    { t: 1, value: 1 },
  ],
} as const;

describe("motion dna", () => {
  it("rejects malformed dna instead of guessing defaults", () => {
    expect(parseMotionDna(minimal).samples).toHaveLength(2);
    expect(() => parseMotionDna({})).toThrow();
    expect(() => parseMotionDna({ ...minimal, samples: [{ t: 0, value: 0 }] })).toThrow();
    expect(() =>
      parseMotionDna({
        ...minimal,
        samples: [
          { t: 0.5, value: 0 },
          { t: 0.25, value: 1 },
        ],
      }),
    ).toThrow();
    expect(() => parseMotionDna({ ...minimal, profile: "ease" })).toThrow();
    expect(() => parseMotionDna({ ...minimal, fps: "18" })).toThrow();
    expect(() => parseMotionDna({ ...minimal, fps: 0 })).toThrow();
    expect(() =>
      parseMotionDna({
        ...minimal,
        samples: [
          { t: 0, value: 0 },
          { t: 0.4, value: 0.5 },
          { t: 1, value: 1 },
        ],
      }),
    ).toThrow();
  });

  it("loads the measured band reveal and exposes its fit", async () => {
    const dna = await loadMotionDna(DNA);
    expect(dna.channel).toBe("visibleHeight");
    expect(dna.samples).toHaveLength(9);
    expect(dna.durationFrames).toBe(8);
    expect(dna.fps).toBe(18);
    expect(dna.from).toBeCloseTo(0.0255, 4);
    expect(dna.to).toBe(1);
    expect(dna.profile).toBe("smooth");
    expect(dna.fit.family).toBe("bezier");
    expect(dna.fit.params).toEqual({ x1: 0.7368, y1: 0.2366, x2: 0, y2: 0.7419 });
  });

  it("plays the fitted bezier on the native sample grid", async () => {
    const dna = await loadMotionDna(DNA);
    const ease = fittedEasing(dna);
    const expected = cubicBezier(0.7368, 0.2366, 0, 0.7419);
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      expect(ease(t)).toBeCloseTo(expected(t), 10);
    }

    const baseScale = 2;
    const span = dna.durationFrames / dna.fps;
    const keyframes = fittedCardKeyframes(dna, { idPrefix: "t", baseScale, holdUntil: 2 });
    expect(keyframes).toHaveLength(20);
    for (const axis of ["x", "y"] as const) {
      const axisFrames = keyframes.filter((kf) => kf.property === `scale.${axis}`);
      expect(axisFrames).toHaveLength(10);
      for (let i = 0; i <= 8; i++) {
        expect(axisFrames[i]!.time).toBeCloseTo((i / 8) * span, 10);
        expect(axisFrames[i]!.easing).toBe("hold");
        expect(axisFrames[i]!.value).toBeCloseTo(
          baseScale * (dna.from + (dna.to - dna.from) * expected(i / 8)),
          10,
        );
      }
      expect(axisFrames[9]!.time).toBe(2);
      expect(axisFrames[9]!.value).toBe(baseScale);
      expect(axisFrames[9]!.easing).toBe("linear");
    }
  });

  it("plays the raw samples exactly when asked", async () => {
    const dna = await loadMotionDna(DNA);
    const baseScale = 2;
    const span = dna.durationFrames / dna.fps;
    const keyframes = steppedCardKeyframes(dna, { idPrefix: "raw", baseScale });
    expect(keyframes).toHaveLength(18);
    const axisFrames = keyframes.filter((kf) => kf.property === "scale.y");
    expect(axisFrames).toHaveLength(9);
    dna.samples.forEach((sample, i) => {
      expect(axisFrames[i]!.time).toBeCloseTo((i / 8) * span, 10);
      expect(axisFrames[i]!.value).toBeCloseTo(
        baseScale * (dna.from + (dna.to - dna.from) * sample.value),
        10,
      );
      expect(axisFrames[i]!.easing).toBe("hold");
    });
  });
});
