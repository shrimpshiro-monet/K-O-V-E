import { describe, expect, it } from "vitest";
import {
  SUBJECT_SEPARATION_PRESETS,
  assessSeparation,
  backgroundRemovalSettingsFromSeparation,
  boxBlurRgba,
  composeSubjectSeparation,
  parseHexColor,
  planSubjectSeparation,
  subjectAlphaAt,
  type RgbaImage,
} from "./subject-separation";
import type { AlphaMask } from "./rotoscope";

const solidRgba = (width: number, height: number, rgba: [number, number, number, number]): RgbaImage => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data.set(rgba, index * 4);
  }
  return { data, width, height };
};

/** Left half covered, right half empty. */
const halfMask = (width: number, height: number, leftValue = 255): AlphaMask => {
  const data = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data[y * width + x] = x < width / 2 ? leftValue : 0;
    }
  }
  return { data, width, height };
};

const solidMask = (width: number, height: number, value = 255): AlphaMask => ({
  data: new Uint8ClampedArray(width * height).fill(value),
  width,
  height,
});

const pixelAt = (image: RgbaImage, x: number, y: number): number[] => {
  const index = (y * image.width + x) * 4;
  return [
    image.data[index],
    image.data[index + 1],
    image.data[index + 2],
    image.data[index + 3],
  ];
};

describe("parseHexColor", () => {
  it("parses 6-digit, 3-digit and unhashed forms", () => {
    expect(parseHexColor("#ff0080")).toEqual({ r: 255, g: 0, b: 128 });
    expect(parseHexColor("0f0")).toEqual({ r: 0, g: 255, b: 0 });
    expect(parseHexColor("0000ff")).toEqual({ r: 0, g: 0, b: 255 });
  });

  it("rejects malformed values", () => {
    expect(parseHexColor("green")).toBeNull();
    expect(parseHexColor("#12345")).toBeNull();
    expect(parseHexColor("#gggggg")).toBeNull();
  });
});

describe("planSubjectSeparation", () => {
  it("exposes a preset catalog for UI menus", () => {
    expect(SUBJECT_SEPARATION_PRESETS.map((preset) => preset.id)).toEqual([
      "cutout",
      "transparent",
      "blur-background",
      "color-background",
      "image-background",
    ]);
    for (const preset of SUBJECT_SEPARATION_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.description.length).toBeGreaterThan(0);
    }
  });

  it("maps cutout presets to a transparent background", () => {
    const plan = planSubjectSeparation({ preset: "cutout" });
    expect(plan.backgroundMode).toBe("transparent");
    expect(plan.summary).toContain("Isolate the subject");
  });

  it("clamps the blur radius and warns when it is a no-op", () => {
    const clamped = planSubjectSeparation({ preset: "blur-background", blurAmount: 500 });
    expect(clamped.blurRadiusPx).toBe(64);
    expect(clamped.warnings.some((warning) => warning.includes("clamped"))).toBe(true);

    const zero = planSubjectSeparation({ preset: "blur-background", blurAmount: 0 });
    expect(zero.blurRadiusPx).toBe(0);
    expect(zero.warnings.some((warning) => warning.includes("identical"))).toBe(true);
  });

  it("defaults color backgrounds to green and reports bad hex", () => {
    const plan = planSubjectSeparation({ preset: "color-background" });
    expect(plan.color).toEqual({ r: 0, g: 255, b: 0 });

    const bad = planSubjectSeparation({
      preset: "color-background",
      backgroundColor: "chartreuse",
    });
    expect(bad.color).toEqual({ r: 0, g: 255, b: 0 });
    expect(bad.warnings[0]).toContain("chartreuse");
  });

  it("falls back to a black background when image-background has no URL", () => {
    const plan = planSubjectSeparation({ preset: "image-background" });
    expect(plan.backgroundMode).toBe("color");
    expect(plan.color).toEqual({ r: 0, g: 0, b: 0 });
    expect(plan.warnings[0]).toContain("backgroundImageUrl");
  });

  it("keeps an image background when a URL is provided", () => {
    const plan = planSubjectSeparation({
      preset: "image-background",
      backgroundImageUrl: "https://cdn.example.com/plate.jpg",
    });
    expect(plan.backgroundMode).toBe("image");
    expect(plan.imageUrl).toBe("https://cdn.example.com/plate.jpg");
    expect(plan.warnings).toEqual([]);
  });

  it("clamps threshold, feather and opacity into range", () => {
    const plan = planSubjectSeparation({
      preset: "cutout",
      threshold: 5,
      feather: -1,
      opacity: 3,
      edgeShift: -9,
    });
    expect(plan.threshold).toBe(1);
    expect(plan.feather).toBe(0);
    expect(plan.opacity).toBe(1);
    expect(plan.edgeShift).toBe(-0.5);
  });
});

describe("subjectAlphaAt", () => {
  const plan = { threshold: 0.5, feather: 0, edgeShift: 0, invert: false, opacity: 1 };

  it("is binary with a zero-width band", () => {
    expect(subjectAlphaAt(0.2, plan)).toBe(0);
    expect(subjectAlphaAt(0.8, plan)).toBe(1);
  });

  it("ramps through the feather band", () => {
    const soft = { ...plan, feather: 0.25 };
    const low = subjectAlphaAt(0.3, soft);
    const mid = subjectAlphaAt(0.5, soft);
    const high = subjectAlphaAt(0.7, soft);
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
    expect(mid).toBeCloseTo(0.5, 1);
  });

  it("grows and shrinks the silhouette with edgeShift", () => {
    const soft = { ...plan, feather: 0.1 };
    const grown = subjectAlphaAt(0.45, { ...soft, edgeShift: 0.1 });
    const plain = subjectAlphaAt(0.45, soft);
    const shrunk = subjectAlphaAt(0.45, { ...soft, edgeShift: -0.1 });
    expect(grown).toBeGreaterThan(plain);
    expect(plain).toBeGreaterThan(shrunk);
  });

  it("inverts and scales with opacity", () => {
    expect(subjectAlphaAt(0.9, { ...plan, invert: true })).toBe(0);
    expect(subjectAlphaAt(0.9, { ...plan, opacity: 0.5 })).toBeCloseTo(0.5);
  });
});

describe("composeSubjectSeparation", () => {
  const source = solidRgba(4, 2, [255, 0, 0, 255]);

  it("keeps the subject and clears the background for cutout", () => {
    const plan = planSubjectSeparation({ preset: "cutout", feather: 0 });
    const output = composeSubjectSeparation({ source, matte: halfMask(4, 2) }, plan);
    expect(pixelAt(output, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(output, 3, 1)).toEqual([0, 0, 0, 0]);
  });

  it("fills the background with the chosen color", () => {
    const plan = planSubjectSeparation({
      preset: "color-background",
      backgroundColor: "#0000ff",
      feather: 0,
    });
    const output = composeSubjectSeparation({ source, matte: halfMask(4, 2) }, plan);
    expect(pixelAt(output, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(output, 3, 1)).toEqual([0, 0, 255, 255]);
  });

  it("composites over a background image", () => {
    const plan = planSubjectSeparation({
      preset: "image-background",
      backgroundImageUrl: "bg.png",
      feather: 0,
    });
    const background = solidRgba(4, 2, [0, 255, 0, 255]);
    const output = composeSubjectSeparation({ source, matte: halfMask(4, 2), background }, plan);
    expect(pixelAt(output, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(output, 3, 0)).toEqual([0, 255, 0, 255]);
  });

  it("throws when an image background is required but missing", () => {
    const plan = planSubjectSeparation({
      preset: "image-background",
      backgroundImageUrl: "bg.png",
    });
    expect(() => composeSubjectSeparation({ source, matte: halfMask(4, 2) }, plan)).toThrow(
      "background image",
    );
  });

  it("throws on a matte/source size mismatch", () => {
    const plan = planSubjectSeparation({ preset: "cutout" });
    expect(() =>
      composeSubjectSeparation({ source, matte: halfMask(8, 8) }, plan),
    ).toThrow("does not match");
  });

  it("leaves a uniform frame unchanged under blur", () => {
    const plan = planSubjectSeparation({ preset: "blur-background", blurAmount: 4, feather: 0 });
    const output = composeSubjectSeparation({ source, matte: halfMask(4, 2) }, plan);
    // Uniform red background blur is still red everywhere.
    expect(pixelAt(output, 3, 0)).toEqual([255, 0, 0, 255]);
  });

  it("honours opacity for the subject", () => {
    // Over a transparent background, opacity lands in the alpha channel and
    // the subject colour is preserved.
    const cutoutPlan = planSubjectSeparation({ preset: "cutout", feather: 0, opacity: 0.5 });
    const cutout = composeSubjectSeparation({ source, matte: halfMask(4, 2) }, cutoutPlan);
    const [r, , , a] = pixelAt(cutout, 0, 0);
    expect(r).toBeCloseTo(255, 0);
    expect(a).toBeCloseTo(128, 0);

    // Over an opaque background the composite stays opaque and the colour
    // blends toward the background.
    const colorPlan = planSubjectSeparation({
      preset: "color-background",
      backgroundColor: "#000000",
      feather: 0,
      opacity: 0.5,
    });
    const blended = composeSubjectSeparation({ source, matte: halfMask(4, 2) }, colorPlan);
    const [blendedR, , , blendedA] = pixelAt(blended, 0, 0);
    expect(blendedR).toBeCloseTo(128, 0);
    expect(blendedA).toBe(255);
  });
});

describe("boxBlurRgba", () => {
  it("preserves a uniform image and smooths an edge", () => {
    const uniform = solidRgba(5, 5, [10, 20, 30, 255]);
    const blurredUniform = boxBlurRgba(uniform, 2);
    expect(blurredUniform[0]).toBeCloseTo(10, 0);
    expect(blurredUniform[1]).toBeCloseTo(20, 0);

    const half = solidRgba(8, 1, [0, 0, 0, 255]);
    for (let x = 4; x < 8; x += 1) {
      half.data[x * 4] = 200;
    }
    const blurred = boxBlurRgba(half, 2);
    // Pixels within the 2px radius of the seam blend; deeper pixels do not.
    expect(blurred[3 * 4]).toBeGreaterThan(0);
    expect(blurred[3 * 4]).toBeLessThan(200);
    expect(blurred[4 * 4]).toBeGreaterThan(0);
    expect(blurred[4 * 4]).toBeLessThan(200);
    expect(blurred[0]).toBe(0);
    expect(blurred[7 * 4]).toBe(200);
  });

  it("returns the source unchanged for radius 0", () => {
    const image = solidRgba(3, 3, [5, 6, 7, 255]);
    expect(Array.from(boxBlurRgba(image, 0))).toEqual(Array.from(image.data));
  });
});

describe("backgroundRemovalSettingsFromSeparation", () => {
  it("maps presets onto the live engine's settings", () => {
    const plan = planSubjectSeparation({ preset: "blur-background", blurAmount: 22 });
    const settings = backgroundRemovalSettingsFromSeparation(plan, { blurAmount: 5 });
    expect(settings.enabled).toBe(true);
    expect(settings.mode).toBe("blur");
    expect(settings.blurAmount).toBe(22);
    expect(settings.threshold).toBe(plan.threshold);
  });

  it("carries the color and image through", () => {
    const colorPlan = planSubjectSeparation({
      preset: "color-background",
      backgroundColor: "#123456",
    });
    expect(backgroundRemovalSettingsFromSeparation(colorPlan).backgroundColor).toBe("#123456");

    const imagePlan = planSubjectSeparation({
      preset: "image-background",
      backgroundImageUrl: "plate.png",
    });
    const settings = backgroundRemovalSettingsFromSeparation(imagePlan);
    expect(settings.mode).toBe("image");
    expect(settings.backgroundImageUrl).toBe("plate.png");
  });

  it("maps feather onto the engine's edgeBlur percentage", () => {
    const plan = planSubjectSeparation({ preset: "cutout", feather: 0.25 });
    expect(backgroundRemovalSettingsFromSeparation(plan).edgeBlur).toBe(25);
  });
});

describe("assessSeparation", () => {
  const plan = { threshold: 0.5, feather: 0, edgeShift: 0, invert: false, opacity: 1 };

  it("reports solid, edge and coverage fractions", () => {
    const report = assessSeparation(halfMask(10, 10), plan);
    expect(report.solidSubject).toBeCloseTo(0.5, 5);
    expect(report.solidBackground).toBeCloseTo(0.5, 5);
    expect(report.edgePixels).toBe(0);
    expect(report.warnings).toEqual([]);
  });

  it("warns about an empty matte and a full-frame matte", () => {
    const empty = assessSeparation(halfMask(4, 4, 0), plan);
    expect(empty.averageCoverage).toBe(0);
    expect(empty.warnings[0]).toContain("almost none");

    const full = assessSeparation(solidMask(4, 4), { ...plan, threshold: 0 });
    expect(full.averageCoverage).toBe(1);
    expect(full.warnings[0]).toContain("almost the whole frame");
  });

  it("warns when the feathered band dominates the frame", () => {
    const matte = halfMask(10, 10, 128);
    const report = assessSeparation(matte, { ...plan, threshold: 0.5, feather: 0.5 });
    // Covered half sits mid-band; the empty half stays fully background.
    expect(report.edgePixels).toBeCloseTo(0.5, 5);
    expect(report.warnings.some((warning) => warning.includes("feathered band"))).toBe(true);
  });
});
