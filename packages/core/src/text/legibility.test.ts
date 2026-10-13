import { describe, expect, it } from "vitest";
import {
  applyLegibilityDefaults,
  clampToSafeArea,
} from "./legibility";

const HD = { width: 1920, height: 1080 };

describe("applyLegibilityDefaults", () => {
  it("fills stroke, shadow and a frame-relative font floor for a bare caption", () => {
    const { style } = applyLegibilityDefaults({ color: "#ffffff" }, HD, "caption");
    expect(style.fontSize).toBe(Math.round(1080 * 0.045)); // 49 px, not 12
    expect(style.strokeColor).toBe("#111827");
    expect(style.strokeWidth).toBeGreaterThanOrEqual(2);
    expect(style.shadowColor).toBe("rgba(0, 0, 0, 0.6)");
    expect(style.shadowBlur).toBeGreaterThanOrEqual(8);
    expect(style.shadowOffsetY).toBeGreaterThanOrEqual(2);
  });

  it("scales stroke and shadow with the font size instead of staying at 2 px", () => {
    const { style } = applyLegibilityDefaults({ fontSize: 100 }, HD, "title");
    expect(style.fontSize).toBe(100);
    expect(style.strokeWidth!).toBeGreaterThan(2); // 2 px vanishes under a 100 px title
    expect(style.shadowBlur!).toBeGreaterThanOrEqual(12);
  });

  it("floors tiny font sizes by role (the Edit v1 tiny-caption failure)", () => {
    const caption = applyLegibilityDefaults({ fontSize: 12 }, HD, "caption").style;
    const title = applyLegibilityDefaults({ fontSize: 12 }, HD, "title").style;
    expect(caption.fontSize).toBe(Math.round(1080 * 0.045));
    expect(title.fontSize).toBe(Math.round(1080 * 0.06));
    expect(title.fontSize!).toBeGreaterThan(caption.fontSize!);
  });

  it("never overrides explicit stroke/shadow choices", () => {
    const explicit = {
      strokeColor: "#ff0000",
      strokeWidth: 7,
      shadowColor: "rgba(255,0,0,0.9)",
      shadowBlur: 3,
      shadowOffsetY: 1,
    };
    const { style } = applyLegibilityDefaults(explicit, HD, "caption");
    expect(style).toEqual({ ...explicit, fontSize: Math.round(1080 * 0.045) });
  });

  it("lifts explicit font sizes below the role floor (documented exception)", () => {
    // An explicit 12 px caption on 1080p IS the Edit v1 failure — the floor
    // is a hard minimum, everything else stays fill-only.
    const { style } = applyLegibilityDefaults({ fontSize: 12 }, HD, "caption");
    expect(style.fontSize).toBe(Math.round(1080 * 0.045));
  });

  it("treats non-finite sizes as unset", () => {
    const { style } = applyLegibilityDefaults(
      { fontSize: Number.NaN, strokeWidth: Number.NaN },
      HD,
      "caption",
    );
    expect(Number.isFinite(style.fontSize)).toBe(true);
    expect(Number.isFinite(style.strokeWidth)).toBe(true);
  });

  it("degenerate frames fall back to 1080p-relative minima", () => {
    const { style } = applyLegibilityDefaults({}, { width: 0, height: Number.NaN }, "caption");
    expect(style.fontSize).toBe(Math.round(1080 * 0.045));
  });
});

describe("clampToSafeArea", () => {
  it("keeps positions inside the 5% inset", () => {
    expect(clampToSafeArea({ x: 0.0, y: 0.0 }, "title")).toEqual({ x: 0.05, y: 0.05 });
    expect(clampToSafeArea({ x: 1.0, y: 1.0 }, "title")).toEqual({ x: 0.95, y: 0.95 });
  });

  it("keeps captions out of the bottom band vertical platform UI covers", () => {
    const clamped = clampToSafeArea({ x: 0.5, y: 0.92 }, "caption");
    expect(clamped.y).toBeLessThanOrEqual(0.85);
    // Non-caption roles may use the full lower area (lower-thirds exist).
    expect(clampToSafeArea({ x: 0.5, y: 0.92 }, "lower-third").y).toBeGreaterThan(0.85);
  });

  it("passes centred positions through untouched", () => {
    expect(clampToSafeArea({ x: 0.5, y: 0.5 }, "caption")).toEqual({ x: 0.5, y: 0.5 });
  });

  it("maps non-finite input to frame centre rather than off-screen", () => {
    expect(clampToSafeArea({ x: Number.NaN, y: 0.5 }, "caption")).toEqual({ x: 0.5, y: 0.5 });
  });
});
