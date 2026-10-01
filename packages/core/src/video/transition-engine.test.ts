import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransitionEngine } from "./transition-engine";
import type { Clip } from "../types/timeline";

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: "clip-1",
    mediaId: "media-1",
    trackId: "track-1",
    startTime: 0,
    duration: 5,
    inPoint: 0,
    outPoint: 5,
    effects: [],
    audioEffects: [],
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      opacity: 1,
      anchorPoint: { x: 0, y: 0 },
    },
    volume: 1,
    ...overrides,
  } as Clip;
}

/** A canvas 2D context stub covering every call the transition renderers make. */
function makeMockContext(overrides: Record<string, unknown> = {}) {
  const gradient = { addColorStop: vi.fn() };
  return {
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillRect: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    setTransform: vi.fn(),
    createLinearGradient: vi.fn(() => gradient),
    getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4),
      width: w,
      height: h,
    })),
    putImageData: vi.fn(),
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    imageSmoothingEnabled: true,
    filter: "none",
    fillStyle: "black",
    strokeStyle: "black",
    lineWidth: 1,
    ...overrides,
  };
}

function stubOffscreenCanvas(context: unknown): void {
  class MockOffscreenCanvas {
    width: number;
    height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }
    getContext() {
      return context;
    }
  }
  vi.stubGlobal("OffscreenCanvas", MockOffscreenCanvas);
}

describe("TransitionEngine", () => {
  let engine: TransitionEngine;

  beforeEach(() => {
    engine = new TransitionEngine({ width: 1920, height: 1080 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("validateTransition", () => {
    it("accepts adjacent clips on the same track", () => {
      const a = makeClip({ id: "a", startTime: 0, duration: 5 });
      const b = makeClip({ id: "b", startTime: 5, duration: 5 });
      const result = engine.validateTransition(a, b, 1);
      expect(result.valid).toBe(true);
    });

    it("rejects non-adjacent clips", () => {
      const a = makeClip({ id: "a", startTime: 0, duration: 5 });
      const b = makeClip({ id: "b", startTime: 6, duration: 5 });
      const result = engine.validateTransition(a, b, 1);
      expect(result.valid).toBe(false);
    });

    it("rejects clips on different tracks", () => {
      const a = makeClip({ id: "a", trackId: "t1", startTime: 0, duration: 5 });
      const b = makeClip({ id: "b", trackId: "t2", startTime: 5, duration: 5 });
      const result = engine.validateTransition(a, b, 1);
      expect(result.valid).toBe(false);
    });

    it("warns when duration exceeds available range", () => {
      const a = makeClip({ id: "a", startTime: 0, duration: 1 });
      const b = makeClip({ id: "b", startTime: 1, duration: 1 });
      const result = engine.validateTransition(a, b, 10);
      expect(result.valid).toBe(true);
      expect(result.warning).toBeDefined();
      expect(result.maxDuration).toBe(2);
    });

    it("rejects zero or negative durations", () => {
      const a = makeClip({ id: "a", startTime: 0, duration: 5 });
      const b = makeClip({ id: "b", startTime: 5, duration: 5 });
      expect(engine.validateTransition(a, b, 0).valid).toBe(false);
      expect(engine.validateTransition(a, b, -1).valid).toBe(false);
    });
  });

  describe("isTimeInTransition / calculateTransitionProgress", () => {
    const a = makeClip({ id: "a", startTime: 0, duration: 5 });
    const transition = {
      id: "t",
      clipAId: "a",
      clipBId: "b",
      type: "crossfade" as const,
      duration: 1,
      params: {},
    };

    it("centers the transition on the cut point", () => {
      // Cut at t=5, duration=1, window should be [4.5, 5.5]
      expect(engine.isTimeInTransition(transition, a, 4.4)).toBe(false);
      expect(engine.isTimeInTransition(transition, a, 4.5)).toBe(true);
      expect(engine.isTimeInTransition(transition, a, 5.0)).toBe(true);
      expect(engine.isTimeInTransition(transition, a, 5.5)).toBe(true);
      expect(engine.isTimeInTransition(transition, a, 5.6)).toBe(false);
    });

    it("reports 0 progress at start and 1 at end", () => {
      expect(engine.calculateTransitionProgress(transition, a, 4.5)).toBe(0);
      expect(engine.calculateTransitionProgress(transition, a, 5.0)).toBeCloseTo(
        0.5,
        5,
      );
      expect(engine.calculateTransitionProgress(transition, a, 5.5)).toBe(1);
    });

    it("uses the clip start window for intro edge transitions", () => {
      const intro = {
        id: "intro",
        clipAId: "a",
        edge: "in" as const,
        type: "crossfade" as const,
        duration: 1,
        params: {},
      };

      expect(engine.isTimeInTransition(intro, a, -0.1)).toBe(false);
      expect(engine.isTimeInTransition(intro, a, 0)).toBe(true);
      expect(engine.isTimeInTransition(intro, a, 1)).toBe(true);
      expect(engine.isTimeInTransition(intro, a, 1.1)).toBe(false);
      expect(engine.calculateTransitionProgress(intro, a, 0.5)).toBeCloseTo(0.5);
    });

    it("uses the clip end window for outro edge transitions", () => {
      const outro = {
        id: "outro",
        clipAId: "a",
        edge: "out" as const,
        type: "crossfade" as const,
        duration: 1,
        params: {},
      };

      expect(engine.isTimeInTransition(outro, a, 3.9)).toBe(false);
      expect(engine.isTimeInTransition(outro, a, 4)).toBe(true);
      expect(engine.isTimeInTransition(outro, a, 5)).toBe(true);
      expect(engine.isTimeInTransition(outro, a, 5.1)).toBe(false);
      expect(engine.calculateTransitionProgress(outro, a, 4.5)).toBeCloseTo(0.5);
    });
  });

  describe("createTransition", () => {
    it("returns a transition with both clip IDs and default params", () => {
      const a = makeClip({ id: "a", startTime: 0, duration: 5 });
      const b = makeClip({ id: "b", startTime: 5, duration: 5 });
      const t = engine.createTransition(a, b, "crossfade", 1);
      expect(t).not.toBeNull();
      expect(t!.clipAId).toBe("a");
      expect(t!.clipBId).toBe("b");
      expect(t!.type).toBe("crossfade");
      expect(t!.duration).toBe(1);
      expect(t!.params).toEqual({ curve: "ease" });
    });

    it("provides adjustable defaults for blur and radial motion transitions", () => {
      expect(engine.getDefaultParams("blur")).toEqual({ intensity: 1 });
      expect(engine.getDefaultParams("whipPan")).toEqual({
        direction: "left",
        blurIntensity: 1,
      });
      expect(engine.getDefaultParams("radialWipe")).toEqual({
        startAngle: -90,
        clockwise: true,
      });
      expect(engine.getDefaultParams("circleReveal")).toEqual({
        center: { x: 0.5, y: 0.5 },
      });
      expect(engine.getDefaultParams("diamondReveal")).toEqual({
        center: { x: 0.5, y: 0.5 },
      });
    });

    it("clamps to maxDuration when requested duration is too long", () => {
      const a = makeClip({ id: "a", startTime: 0, duration: 1 });
      const b = makeClip({ id: "b", startTime: 1, duration: 1 });
      const t = engine.createTransition(a, b, "crossfade", 10);
      expect(t!.duration).toBe(2);
    });

    it("creates a single-clip edge transition without a second clip id", () => {
      const a = makeClip({ id: "a", startTime: 0, duration: 1 });
      const t = engine.createClipEdgeTransition(a, "out", "crossfade", 10);
      expect(t).not.toBeNull();
      expect(t!.clipAId).toBe("a");
      expect(t!.clipBId).toBeUndefined();
      expect(t!.edge).toBe("out");
      expect(t!.duration).toBe(1);
    });
  });

  describe("renderTransitionToCanvas", () => {
    it("renders soft wipes as a feathered series of blended slices", async () => {
      const drawImage = vi.fn();
      const rect = vi.fn();
      const context = makeMockContext({ drawImage, rect });
      stubOffscreenCanvas(context);
      const softWipeEngine = new TransitionEngine({ width: 320, height: 180 });
      const source = { width: 320, height: 180 } as CanvasImageSource;

      await softWipeEngine.renderTransitionToCanvas(
        source,
        source,
        {
          id: "soft-wipe",
          clipAId: "a",
          clipBId: "b",
          type: "wipe",
          duration: 1,
          params: { direction: "left", softness: 0.45 },
        },
        0.5,
      );

      expect(rect.mock.calls.length).toBeGreaterThan(10);
      expect(drawImage.mock.calls.length).toBeGreaterThan(10);
    });

    it("runs every expanded transition family through a distinct canvas path", async () => {
      const drawImage = vi.fn();
      const rect = vi.fn();
      const lineTo = vi.fn();
      const context = makeMockContext({ drawImage, rect, lineTo });
      stubOffscreenCanvas(context);
      const expanded = new TransitionEngine({ width: 320, height: 180 });
      const source = { width: 320, height: 180 } as CanvasImageSource;

      for (const type of [
        "pixelate",
        "glitch",
        "blinds",
        "diamondReveal",
        "spin",
        "flip",
        "splitReveal",
        "flash",
        "filmBurn",
        "mosaic",
        "ripple",
        "pageTurn",
        "colorSplit",
        "crossZoom",
        "zoomBlur",
        "motionSmear",
        "strobeCut",
        "impactShake",
        "lumaWipe",
        "inkBleed",
        "tileFlip",
        "sliceSlide",
        "lightLeak",
        "vhsScan",
        "paperBurn",
        "pixelSort",
        "filmRoll",
      ] as const) {
        drawImage.mockClear();
        rect.mockClear();
        lineTo.mockClear();
        await expanded.renderTransitionToCanvas(
          source,
          source,
          {
            id: type,
            clipAId: "a",
            clipBId: "b",
            type,
            duration: 1,
            params: expanded.getDefaultParams(type),
          },
          0.5,
        );
        expect(drawImage.mock.calls.length, type).toBeGreaterThanOrEqual(
          type === "flip" ? 1 : 2,
        );
        if (type === "glitch") {
          expect(drawImage.mock.calls.length).toBeGreaterThan(10);
        }
        if (type === "blinds") {
          expect(rect.mock.calls.length).toBe(8);
        }
        if (type === "diamondReveal") {
          expect(lineTo.mock.calls.length).toBe(3);
        }
        if (type === "mosaic") {
          expect(rect.mock.calls.length).toBeGreaterThan(4);
        }
        if (type === "ripple") {
          expect(drawImage.mock.calls.length).toBeGreaterThan(32);
        }
        // Each second-wave transition must actually put pixels on the canvas
        // (a silent no-op would sail through a "does not throw" test).
        if (
          type === "crossZoom" ||
          type === "zoomBlur" ||
          type === "motionSmear" ||
          type === "strobeCut" ||
          type === "impactShake" ||
          type === "lumaWipe" ||
          type === "inkBleed" ||
          type === "tileFlip" ||
          type === "sliceSlide" ||
          type === "lightLeak" ||
          type === "vhsScan" ||
          type === "paperBurn" ||
          type === "pixelSort" ||
          type === "filmRoll"
        ) {
          expect(drawImage.mock.calls.length, type).toBeGreaterThan(1);
        }
        if (type === "zoomBlur") {
          // Radial streaks: one draw per sample, plus the crossfade tail.
          expect(drawImage.mock.calls.length).toBeGreaterThanOrEqual(12);
        }
        if (type === "motionSmear") {
          expect(drawImage.mock.calls.length).toBeGreaterThanOrEqual(8);
        }
        if (type === "tileFlip") {
          // One clipped draw per tile (6 columns × 3 rows at 320×180).
          expect(rect.mock.calls.length).toBeGreaterThanOrEqual(18);
        }
      }
    });
  });

    it("advertises defaults for every expanded transition family", () => {
    expect(engine.getAvailableTransitionTypes()).toEqual(
      expect.arrayContaining([
        "pixelate",
        "glitch",
        "blinds",
        "diamondReveal",
        "spin",
        "flip",
        "splitReveal",
        "flash",
        "filmBurn",
        "mosaic",
        "ripple",
        "pageTurn",
        "colorSplit",
      ]),
    );
    expect(engine.getDefaultParams("pixelate")).toEqual({ maxPixelSize: 48 });
    expect(engine.getDefaultParams("glitch")).toEqual({
      intensity: 0.08,
      slices: 12,
    });
    expect(engine.getDefaultParams("blinds")).toEqual({
      count: 8,
      direction: "vertical",
    });
    expect(engine.getDefaultParams("spin")).toEqual({ rotations: 1 });
    expect(engine.getDefaultParams("flip")).toEqual({ axis: "horizontal" });
    expect(engine.getDefaultParams("splitReveal")).toEqual({
      orientation: "horizontal",
    });
    expect(engine.getDefaultParams("flash")).toEqual({ intensity: 1 });
    expect(engine.getDefaultParams("filmBurn")).toEqual({
      intensity: 1,
      warmth: 0.75,
    });
    expect(engine.getDefaultParams("mosaic")).toEqual({
      tiles: 8,
      randomness: 0.85,
    });
    expect(engine.getDefaultParams("ripple")).toEqual({
      amplitude: 0.04,
      waves: 3,
    });
    expect(engine.getDefaultParams("pageTurn")).toEqual({
      direction: "left",
      shadow: 0.55,
    });
    expect(engine.getDefaultParams("colorSplit")).toEqual({
      maxOffset: 18,
      angle: 0,
    });
  });

  it("advertises defaults for the second wave of transitions", () => {
    expect(engine.getAvailableTransitionTypes()).toEqual(
      expect.arrayContaining([
        "crossZoom",
        "zoomBlur",
        "motionSmear",
        "strobeCut",
        "impactShake",
        "lumaWipe",
        "inkBleed",
        "tileFlip",
        "sliceSlide",
        "lightLeak",
        "vhsScan",
        "paperBurn",
        "pixelSort",
        "filmRoll",
      ]),
    );
    expect(engine.getDefaultParams("crossZoom")).toEqual({
      strength: 2.2,
      center: { x: 0.5, y: 0.5 },
    });
    expect(engine.getDefaultParams("zoomBlur")).toEqual({ streaks: 12, strength: 0.35 });
    expect(engine.getDefaultParams("motionSmear")).toEqual({ direction: "left", distance: 0.25 });
    expect(engine.getDefaultParams("strobeCut")).toEqual({ strobes: 6 });
    expect(engine.getDefaultParams("impactShake")).toEqual({ intensity: 1, flash: 0.55 });
    expect(engine.getDefaultParams("lumaWipe")).toEqual({ softness: 0.25, invert: false });
    expect(engine.getDefaultParams("inkBleed")).toEqual({
      lobes: 7,
      softness: 0.35,
      center: { x: 0.5, y: 0.5 },
    });
    expect(engine.getDefaultParams("tileFlip")).toEqual({
      columns: 6,
      stagger: 0.6,
      axis: "horizontal",
    });
    expect(engine.getDefaultParams("sliceSlide")).toEqual({
      slices: 9,
      direction: "left",
      gap: 0,
    });
    expect(engine.getDefaultParams("lightLeak")).toEqual({
      intensity: 1,
      warmth: 0.7,
      direction: "right",
    });
    expect(engine.getDefaultParams("vhsScan")).toEqual({ intensity: 0.8, slices: 14 });
    expect(engine.getDefaultParams("paperBurn")).toEqual({
      softness: 0.3,
      center: { x: 0.5, y: 0.5 },
    });
    expect(engine.getDefaultParams("pixelSort")).toEqual({
      amount: 1,
      threshold: 0.55,
      direction: "right",
    });
    expect(engine.getDefaultParams("filmRoll")).toEqual({ direction: "up", barWidth: 0.06 });
  });

  it("keys the incoming frame by the outgoing frame's luminance in lumaWipe", async () => {
    const putImageData = vi.fn();
    const context = makeMockContext({
      // Half dark, half bright, so the key has something to sort on.
      getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => {
        const data = new Uint8ClampedArray(w * h * 4);
        for (let index = 0; index < data.length; index += 4) {
          const bright = (index / 4) % w > w / 2;
          const value = bright ? 240 : 12;
          data[index] = value;
          data[index + 1] = value;
          data[index + 2] = value;
          data[index + 3] = 255;
        }
        return { data, width: w, height: h };
      }),
      putImageData,
    });
    stubOffscreenCanvas(context);
    const keyed = new TransitionEngine({ width: 320, height: 180 });
    const source = { width: 320, height: 180 } as CanvasImageSource;

    await keyed.renderTransitionToCanvas(
      source,
      source,
      {
        id: "luma",
        clipAId: "a",
        clipBId: "b",
        type: "lumaWipe",
        duration: 1,
        params: keyed.getDefaultParams("lumaWipe"),
      },
      0.5,
    );

    // The key is written back and then used as the incoming frame's mask.
    expect(putImageData).toHaveBeenCalled();
    expect(context.drawImage.mock.calls.length).toBeGreaterThan(2);
  });

  it("smears bright pixels along the sort axis in pixelSort", async () => {
    const putImageData = vi.fn();
    let sampled: { data: Uint8ClampedArray; width: number; height: number } | null = null;
    const context = makeMockContext({
      getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => {
        const data = new Uint8ClampedArray(w * h * 4);
        for (let index = 0; index < data.length; index += 4) {
          // A single bright column, everything else mid-dark.
          const column = (index / 4) % w;
          const bright = column === Math.floor(w / 3);
          data[index] = bright ? 255 : 40;
          data[index + 1] = bright ? 255 : 40;
          data[index + 2] = bright ? 255 : 40;
          data[index + 3] = 255;
        }
        sampled = { data, width: w, height: h };
        return sampled;
      }),
      putImageData,
    });
    stubOffscreenCanvas(context);
    const sorted = new TransitionEngine({ width: 320, height: 180 });
    const source = { width: 320, height: 180 } as CanvasImageSource;

    await sorted.renderTransitionToCanvas(
      source,
      source,
      {
        id: "sort",
        clipAId: "a",
        clipBId: "b",
        type: "pixelSort",
        duration: 1,
        params: sorted.getDefaultParams("pixelSort"),
      },
      0.25,
    );

    expect(putImageData).toHaveBeenCalled();
    // The smear runs on the reduced-resolution key, so the assertion has to use
    // the dimensions the engine actually sampled.
    const sample = sampled as unknown as { data: Uint8ClampedArray; width: number; height: number };
    expect(sample.width).toBeLessThan(320);
    const brightColumn = Math.floor(sample.width / 3);
    const row = 2;
    const brightPixel = (row * sample.width + brightColumn) * 4;
    const smearedPixel = (row * sample.width + brightColumn + 5) * 4;
    expect(sample.data[brightPixel]).toBe(255);
    expect(sample.data[smearedPixel]).toBeGreaterThan(40);
  });

  it("falls back to a drawn reveal when ImageData is unavailable", async () => {
    const context = makeMockContext({ getImageData: undefined, putImageData: undefined });
    stubOffscreenCanvas(context);
    const noImageData = new TransitionEngine({ width: 320, height: 180 });
    const source = { width: 320, height: 180 } as CanvasImageSource;

    for (const type of ["lumaWipe", "pixelSort"] as const) {
      context.drawImage.mockClear();
      await noImageData.renderTransitionToCanvas(
        source,
        source,
        {
          id: type,
          clipAId: "a",
          clipBId: "b",
          type,
          duration: 1,
          params: noImageData.getDefaultParams(type),
        },
        0.5,
      );
      expect(context.drawImage.mock.calls.length, type).toBeGreaterThan(1);
    }
  });

  it("renders Film Burn warmth from cool blue to warm orange", async () => {
    const fillStyles: string[] = [];
    const context = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      fillRect: vi.fn(),
      globalAlpha: 1,
      globalCompositeOperation: "source-over",
      _fillStyle: "",
      set fillStyle(value: string) {
        this._fillStyle = value;
        fillStyles.push(value);
      },
      get fillStyle() {
        return this._fillStyle;
      },
    };
    class MockOffscreenCanvas {
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        return context;
      }
    }
    vi.stubGlobal("OffscreenCanvas", MockOffscreenCanvas);
    const filmBurnEngine = new TransitionEngine({ width: 320, height: 180 });
    const source = { width: 320, height: 180 } as CanvasImageSource;

    await filmBurnEngine.renderTransitionToCanvas(
      source,
      source,
      {
        id: "cool-burn",
        clipAId: "a",
        clipBId: "b",
        type: "filmBurn",
        duration: 1,
        params: { intensity: 1, warmth: 0 },
      },
      0.5,
    );
    expect(fillStyles).toContain("rgb(70, 180, 255)");

    fillStyles.length = 0;
    await filmBurnEngine.renderTransitionToCanvas(
      source,
      source,
      {
        id: "warm-burn",
        clipAId: "a",
        clipBId: "b",
        type: "filmBurn",
        duration: 1,
        params: { intensity: 1, warmth: 1 },
      },
      0.5,
    );
    expect(fillStyles).toContain("rgb(255, 75, 15)");
  });

  describe("areClipsAdjacent", () => {
    it("returns true for clips with negligible gap", () => {
      const a = makeClip({ id: "a", startTime: 0, duration: 5 });
      const b = makeClip({ id: "b", startTime: 5.0005, duration: 5 });
      expect(engine.areClipsAdjacent(a, b)).toBe(true);
    });

    it("returns false for clips with a real gap", () => {
      const a = makeClip({ id: "a", startTime: 0, duration: 5 });
      const b = makeClip({ id: "b", startTime: 5.1, duration: 5 });
      expect(engine.areClipsAdjacent(a, b)).toBe(false);
    });

    it("returns false for clips on different tracks", () => {
      const a = makeClip({ id: "a", trackId: "t1", startTime: 0, duration: 5 });
      const b = makeClip({ id: "b", trackId: "t2", startTime: 5, duration: 5 });
      expect(engine.areClipsAdjacent(a, b)).toBe(false);
    });
  });
});
