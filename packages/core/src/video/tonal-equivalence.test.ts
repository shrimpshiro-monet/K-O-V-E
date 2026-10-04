import { describe, expect, it } from "vitest";
import { VideoEffectsEngine } from "./video-effects-engine";

/**
 * applyTonal was rewritten from per-pixel smoothsteps to a 256-entry luma LUT
 * (~10x at 1080p). This pins output equivalence with the original algorithm:
 * the only allowed difference is ±1 level from luma quantization.
 */

function originalApplyTonal(
  data: Uint8ClampedArray,
  shadows: number,
  midtones: number,
  highlights: number,
): void {
  const smoothstep = (a: number, b: number, x: number): number => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    const shadowWeight = 1 - smoothstep(0, 0.33, luma);
    const highlightWeight = smoothstep(0.66, 1, luma);
    const midtoneWeight = Math.max(0, 1 - shadowWeight - highlightWeight);
    const adjustment =
      shadows * shadowWeight * 0.3 +
      midtones * midtoneWeight * 0.3 +
      highlights * highlightWeight * 0.3;
    data[i] = Math.round(Math.max(0, Math.min(255, (r + adjustment) * 255)));
    data[i + 1] = Math.round(
      Math.max(0, Math.min(255, (g + adjustment) * 255)),
    );
    data[i + 2] = Math.round(
      Math.max(0, Math.min(255, (b + adjustment) * 255)),
    );
  }
}

function makeEngine(): {
  applyTonal: (
    data: Uint8ClampedArray,
    shadows: number,
    midtones: number,
    highlights: number,
  ) => void;
} {
  const engine = Object.create(VideoEffectsEngine.prototype) as unknown as {
    applyTonal: (
      data: Uint8ClampedArray,
      shadows: number,
      midtones: number,
      highlights: number,
    ) => void;
  };
  return { applyTonal: engine.applyTonal.bind(engine) };
}

function randomFrame(width: number, height: number, seed = 7): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  let s = seed;
  const rand = (): number => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.floor(rand() * 256);
    data[i + 1] = Math.floor(rand() * 256);
    data[i + 2] = Math.floor(rand() * 256);
    data[i + 3] = 255;
  }
  return data;
}

describe("applyTonal LUT equivalence", () => {
  const cases: Array<[number, number, number]> = [
    [-1, -1, -0.4], // color-bw-crushed recipe
    [1, 0.5, 0.3], // shadow lift
    [0, 0, 0], // identity
    [-0.5, 0.2, -0.8], // mixed
  ];

  it.each(cases)(
    "matches the original within ±1 level for shadows=%s midtones=%s highlights=%s",
    (shadows, midtones, highlights) => {
      const a = randomFrame(192, 108);
      const b = Uint8ClampedArray.from(a);
      makeEngine().applyTonal(a, shadows, midtones, highlights);
      originalApplyTonal(b, shadows, midtones, highlights);
      let maxDelta = 0;
      for (let i = 0; i < a.length; i++) {
        maxDelta = Math.max(maxDelta, Math.abs(a[i] - b[i]));
      }
      expect(maxDelta).toBeLessThanOrEqual(1);
    },
  );
});
