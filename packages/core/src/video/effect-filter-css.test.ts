import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Effect } from "../types/timeline";
import { cssFilterForEffect } from "./effect-filter-css";
import { VideoEffectsEngine } from "./video-effects-engine";
import { Canvas2DFallbackRenderer } from "./canvas2d-fallback-renderer";

function fx(type: string, params: Record<string, unknown>, enabled = true): Effect {
  return { id: `fx-${type}`, type, params, enabled };
}

describe("cssFilterForEffect — the one CSS interpretation", () => {
  it("renders brightness as a percent offset", () => {
    expect(cssFilterForEffect(fx("brightness", { value: 20 }))).toBe("brightness(1.2)");
    expect(cssFilterForEffect(fx("brightness", { value: -100 }))).toBe("brightness(0)");
    expect(cssFilterForEffect(fx("brightness", {}))).toBe("brightness(1)");
  });

  it("renders contrast/saturation as CSS multipliers and honors a legal zero", () => {
    expect(cssFilterForEffect(fx("contrast", { value: 1.2 }))).toBe("contrast(1.2)");
    // value 0 is a legal slider position (flat gray) — the old `value || 1`
    // falsy trap must not resurrect it as identity.
    expect(cssFilterForEffect(fx("contrast", { value: 0 }))).toBe("contrast(0)");
    expect(cssFilterForEffect(fx("saturation", { value: 0 }))).toBe("saturate(0)");
    expect(cssFilterForEffect(fx("contrast", {}))).toBe("contrast(1)");
    // Numeric strings coerce instead of silently becoming identity.
    expect(cssFilterForEffect(fx("contrast", { value: "1.2" }))).toBe("contrast(1.2)");
  });

  it("renders hue in degrees and blur in pixels", () => {
    expect(cssFilterForEffect(fx("hue", { rotation: -90 }))).toBe("hue-rotate(-90deg)");
    expect(cssFilterForEffect(fx("blur", { radius: 4 }))).toBe("blur(4px)");
  });

  it("returns nothing for disabled effects and non-CSS effect types", () => {
    expect(cssFilterForEffect(fx("brightness", { value: 20 }, false))).toBe("");
    expect(cssFilterForEffect(fx("sharpen", { amount: 80 }))).toBe("");
  });
});

const SAMPLES: Effect[] = [
  fx("brightness", { value: 20 }),
  fx("contrast", { value: 0 }),
  fx("saturation", { value: 1.2 }),
  fx("hue", { rotation: 45 }),
  fx("blur", { radius: 4 }),
];

describe("every CSS-routable engine renders the same string", () => {
  it("VideoEffectsEngine's CSS batch agrees with the shared interpretation", () => {
    const engine = new VideoEffectsEngine({ width: 8, height: 8, useGPU: false }) as unknown as {
      getCssFilterString(effects: Effect[]): string | null;
    };
    for (const sample of SAMPLES) {
      expect(engine.getCssFilterString([sample])).toBe(cssFilterForEffect(sample));
    }
  });

  describe("Canvas2DFallbackRenderer", () => {
    const drawImage = vi.fn();
    const context = {
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      scale: vi.fn(),
      setTransform: vi.fn(),
      drawImage,
      filter: "none",
      globalAlpha: 1,
      globalCompositeOperation: "source-over",
    };

    class MockImageBitmap {
      width = 320;
      height = 180;
    }

    class MockOffscreenCanvas {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return context;
      }
    }

    beforeEach(() => {
      vi.stubGlobal("ImageBitmap", MockImageBitmap);
      vi.stubGlobal("OffscreenCanvas", MockOffscreenCanvas);
      vi.stubGlobal("createImageBitmap", vi.fn(async () => new MockImageBitmap()));
      drawImage.mockClear();
      context.filter = "none";
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("agrees with the shared interpretation", async () => {
      const renderer = new Canvas2DFallbackRenderer({
        canvas: {} as HTMLCanvasElement,
        width: 640,
        height: 360,
      });
      await renderer.initialize();
      const bitmap = new MockImageBitmap() as unknown as ImageBitmap;
      for (const sample of SAMPLES) {
        context.filter = "none";
        const texture = renderer.applyEffects(bitmap, [sample]);
        renderer.beginFrame();
        renderer.renderLayer({
          texture,
          transform: {
            position: { x: 0, y: 0 },
            scale: { x: 1, y: 1 },
            rotation: 0,
            opacity: 1,
            anchor: { x: 0.5, y: 0.5 },
          },
          effects: [],
          opacity: 1,
          borderRadius: 0,
        });
        await renderer.endFrame();
        expect(context.filter).toBe(cssFilterForEffect(sample));
      }
    });
  });
});
