import { describe, expect, it, afterEach } from "vitest";
import {
  computeRenderSampleTimes,
  measureFramePixels,
  sampleRenderedDraft,
} from "./render-observation";
import { reviewRenderedDraft } from "@kove-advanced/creation-schema";
import { HeadlessHost } from "../headless-host";
import { makeEmptyProject } from "../test-fixtures";
import {
  installPixelShim,
  isPixelShimActive,
  patternFrameDataUrl,
  restorePixelShim,
} from "../test-pixel-shim";
import type { EditPlan, RenderedFrameObservation } from "@kove-advanced/creation-schema";
import type { EditingHost, HostFeatures, TimelineFrame, TimelineFrameRequest } from "../host";
import type { PixelSpec } from "../test-pixel-shim";

function basePlan(segments: number): EditPlan {
  return {
    segments: Array.from({ length: segments }, (_, index) => ({
      sourceVideoId: "video-1",
      sourceStartTime: index * 2,
      sourceEndTime: index * 2 + 2,
      trackIndex: 0,
      targetPosition: index * 2,
      speed: 1,
      effects: [],
      effectSpecs: [],
      rationale: `shot ${index}`,
    })),
    textElements: [],
    effects: [],
    transitions: [],
    audioDecisions: [],
    metadata: { targetDuration: segments * 2, targetPlatform: "social", genre: "highlight-reel", pacing: "fast", rationale: "test" },
  } as unknown as EditPlan;
}

describe("computeRenderSampleTimes", () => {
  it("covers the opening and every segment midpoint", () => {
    const plan = basePlan(3);
    const placement = [0, 2, 4];
    const times = computeRenderSampleTimes(plan, placement);
    expect(times[0]).toBeCloseTo(0.15);
    for (let index = 0; index < 3; index += 1) {
      expect(times).toContain(index * 2 + 1);
    }
  });

  it("includes text overlay windows and transition junction posts", () => {
    const plan = {
      ...basePlan(2),
      textElements: [{ content: "hello", style: "title" as const, startTime: 1, duration: 2, rationale: "x" }],
      transitions: [{ afterSegmentIndex: 0, type: "crossfade", duration: 0.5, rationale: "x" }],
    } as EditPlan;
    const placement = [0, 2];
    const times = computeRenderSampleTimes(plan, placement);
    expect(times).toContain(2); // text middle at startTime + duration/2
    expect(times).toContain(2 + Math.min(0.25, 1 / 4)); // junction post
  });

  it("respects the sample cap and stays sorted without duplicates", () => {
    const plan = basePlan(40);
    const placement = Array.from({ length: 40 }, (_, index) => index * 2);
    const times = computeRenderSampleTimes(plan, placement);
    expect(times.length).toBeLessThanOrEqual(8);
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i]).toBeGreaterThan(times[i - 1]);
    }
  });
});

describe("sampleRenderedDraft honesty", () => {
  it("returns undefined when the host cannot render timeline frames", async () => {
    const host = new HeadlessHost(makeEmptyProject());
    const sampling = await sampleRenderedDraft(host, basePlan(2));
    expect(sampling).toBeUndefined();
  });
});

// ---- measureFramePixels: real math over synthetic buffers -------------------

const W = 64;
const H = 32;

function frameBuffer(fill: (x: number, y: number) => number, width = W, height = H): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = fill(x, y);
      const index = (y * width + x) * 4;
      pixels[index] = value;
      pixels[index + 1] = value;
      pixels[index + 2] = value;
      pixels[index + 3] = 255;
    }
  }
  return pixels;
}

/** Deterministic pseudo-noise (no test import cycle with the shim's RNG). */
const noiseValue = (x: number, y: number): number => {
  let seed = (x * 73856093 ^ y * 19349663) & 0x7fffffff;
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return (seed >>> 16) & 0xff;
};

describe("measureFramePixels", () => {
  it("reads a black frame as black and unsharp — the failed-render signature", () => {
    const measurement = measureFramePixels(frameBuffer(() => 0), W, H, undefined);
    expect(measurement.hasBlackFrame).toBe(true);
    expect(measurement.sharpness).toBe(0);
    expect(measurement.subjectVisibility).toBe(0);
    expect(measurement.textLegibility).toBe(1);
  });

  it("sees flat gray as NOT black but blank — visibility is a texture proxy", () => {
    const measurement = measureFramePixels(frameBuffer(() => 128), W, H, undefined);
    expect(measurement.hasBlackFrame).toBe(false);
    expect(measurement.sharpness).toBeLessThan(0.05);
    expect(measurement.subjectVisibility).toBe(0);
  });

  it("scores textured pixels as sharp and visible", () => {
    const measurement = measureFramePixels(frameBuffer(noiseValue), W, H, undefined);
    expect(measurement.hasBlackFrame).toBe(false);
    expect(measurement.sharpness).toBeGreaterThan(0.3);
    expect(measurement.subjectVisibility).toBeGreaterThan(0.5);
  });

  it("measures text legibility at the stated overlay position: flat band over noise is unreadable, noise band over flat is sharp", () => {
    const at: { x: number; y: number } = { x: 0.5, y: 0.5 };
    // The measured patch is x in [32-11, 32+11], y in [16-1, 16+1] (its
    // boundary rows/cols sample one pixel OUTSIDE, compactly); paint the
    // patch two pixels wider on every side so the measured interior is
    // homogeneous (no fake edges from the fill boundary).
    const x0 = Math.floor(at.x * W) - Math.floor(W * 0.18) - 2;
    const x1 = Math.floor(at.x * W) + Math.floor(W * 0.18) + 2;
    const y0 = Math.floor(at.y * H) - Math.floor(H * 0.06) - 2;
    const y1 = Math.floor(at.y * H) + Math.floor(H * 0.06) + 2;
    const inPatch = (x: number, y: number): boolean => x >= x0 && x <= x1 && y >= y0 && y <= y1;

    const flatBandOverNoise = measureFramePixels(
      frameBuffer((x, y) => (inPatch(x, y) ? 128 : noiseValue(x, y))),
      W,
      H,
      at,
    );
    expect(flatBandOverNoise.textLegibility).toBeLessThan(0.05);

    const noiseBandOverFlat = measureFramePixels(
      frameBuffer((x, y) => (inPatch(x, y) ? noiseValue(x, y) : 128)),
      W,
      H,
      at,
    );
    expect(noiseBandOverFlat.textLegibility).toBeGreaterThan(0.6);

    // No stated position → no guess, never punished.
    const noOverlay = measureFramePixels(frameBuffer(noiseValue), W, H, undefined);
    expect(noOverlay.textLegibility).toBe(1);
  });
});

// ---- sampleRenderedDraft end-to-end over synthetic pixels -------------------

afterEach(() => restorePixelShim());

/**
 * Host whose renderTimelineFrame serves pixel-shim pattern frames. The
 * measurement pipeline (decode → luma → gradients) runs for REAL; only the
 * image encoding is synthetic.
 */
function patternHost(patternForTime: (time: number) => PixelSpec): { host: EditingHost; requested: number[] } {
  const requested: number[] = [];
  const host = {
    features: () => ({ renderTimelineFrame: true }) as unknown as HostFeatures,
    renderTimelineFrame: async (request: TimelineFrameRequest): Promise<TimelineFrame> => {
      requested.push(request.time);
      const spec = patternForTime(request.time);
      return {
        dataUrl: patternFrameDataUrl(spec),
        mimeType: "image/jpeg",
        width: spec.width ?? 96,
        height: spec.height ?? 64,
        renderer: "pixel-shim",
      };
    },
  };
  return { host: host as unknown as EditingHost, requested };
}

describe("sampleRenderedDraft measures real pixels", () => {
  it("black renders throughout: observations report actual darkness and the review score collapses", async () => {
    installPixelShim();
    expect(isPixelShimActive()).toBe(true);
    const { host, requested } = patternHost(() => ({ pattern: "black" }));
    const plan = basePlan(2);

    const sampling = await sampleRenderedDraft(host, plan);

    // opening + two segment midpoints
    expect(sampling?.sampleTimes).toEqual([0.15, 1, 3]);
    expect(requested).toEqual([0.15, 1, 3]);
    expect(sampling?.frames.map((frame) => frame.videoId)).toEqual(["rendered-timeline", "rendered-timeline", "rendered-timeline"]);
    expect(sampling?.observations.every((observation) => observation.hasBlackFrame === true)).toBe(true);
    expect(sampling?.observations.every((observation) => observation.sharpness === 0)).toBe(true);

    const review = reviewRenderedDraft(sampling?.observations as RenderedFrameObservation[]);
    expect(review.method).toBe("heuristic-pixel-proxies");
    expect(review.score).toBeCloseTo(0.35, 5);
    expect(review.issues.some((issue) => issue.includes("black or empty"))).toBe(true);
  });

  it("healthy renders: sharp textured pixels, no issues, full score, honest method label", async () => {
    installPixelShim();
    const { host } = patternHost(() => ({ pattern: "noise" }));
    const sampling = await sampleRenderedDraft(host, basePlan(2));

    expect(sampling?.observations.every((observation) => observation.sharpness > 0.9)).toBe(true);
    expect(sampling?.observations.every((observation) => observation.subjectVisibility > 0.9)).toBe(true);
    expect(sampling?.observations.every((observation) => observation.textLegibility === 1)).toBe(true);

    const review = reviewRenderedDraft(sampling?.observations as RenderedFrameObservation[]);
    expect(review.score).toBe(1);
    expect(review.issues).toHaveLength(0);
    // The review carries its method even when everything passes — it must
    // never be quoted as comprehensive visual QA.
    expect(review.method).toBe("heuristic-pixel-proxies");
  });

  it("flat blank renders: not black, but the texture/gradient proxies flag the emptiness", async () => {
    installPixelShim();
    const { host } = patternHost(() => ({ pattern: "flat" }));
    const sampling = await sampleRenderedDraft(host, basePlan(2));

    expect(sampling?.observations.every((observation) => observation.hasBlackFrame === false)).toBe(true);
    expect(sampling?.observations.every((observation) => observation.subjectVisibility === 0)).toBe(true);

    const review = reviewRenderedDraft(sampling?.observations as RenderedFrameObservation[]);
    expect(review.score).toBeLessThan(1);
    const text = review.issues.join(" ");
    expect(text).toContain("(texture-coverage proxy, not semantic subject detection)");
    expect(text).toContain("(gradient-energy proxy)");
  });

  it("a stated overlay position actually shifts where legibility is measured (noise patch on flat base reads as sharp)", async () => {
    installPixelShim();
    // Flat base + noise painted inside the overlay rect → the ONLY textured
    // region is the "text patch". Legibility must be measured THERE.
    const { host } = patternHost((time) => (time === 1 ? { pattern: "flat", overlay: { x: 0.5, y: 0.5 } } : { pattern: "flat" }));
    const plan = {
      ...basePlan(2),
      textElements: [{ content: "title", style: "title" as const, startTime: 0.5, duration: 1, position: { x: 0.5, y: 0.5 }, rationale: "x" }],
    } as unknown as EditPlan;

    const sampling = await sampleRenderedDraft(host, plan);
    const atText = sampling?.observations.find((observation) => observation.timestamp === 1);
    const elsewhere = sampling?.observations.find((observation) => observation.timestamp !== 1);
    expect(atText?.textLegibility).toBeGreaterThan(0.5);
    // No overlay at that instant → legibility is vacuously fine.
    expect(elsewhere?.textLegibility).toBe(1);
  });

  it("render failures degrade to silence, never to invented metrics", async () => {
    installPixelShim();
    const failingHost = {
      features: () => ({ renderTimelineFrame: true }) as unknown as HostFeatures,
      renderTimelineFrame: async (): Promise<TimelineFrame> => {
        throw new Error("GPU went home");
      },
    } as unknown as EditingHost;
    const sampling = await sampleRenderedDraft(failingHost, basePlan(2));
    expect(sampling).toBeUndefined();
  });
});
