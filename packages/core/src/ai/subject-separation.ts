/**
 * Subject segmentation/separation.
 *
 * `person-segmentation-engine` produces the matte; this module decides what to
 * *do* with it. Two output paths share one settings model:
 *
 *  - Live preview: `backgroundRemovalSettingsFromSeparation()` maps a preset
 *    onto `BackgroundRemovalSettings` for the existing real-time engine.
 *  - Deterministic batch/agent path: `composeSubjectSeparation()` composites
 *    RGBA buffers with no canvas or GPU, so it is unit-testable and usable
 *    headlessly.
 */

import type { AlphaMask } from "./rotoscope";
import type {
  BackgroundMode,
  BackgroundRemovalSettings,
} from "./background-removal-engine";
import { DEFAULT_BACKGROUND_SETTINGS } from "./background-removal-engine";

export type SubjectSeparationPreset =
  | "cutout"
  | "transparent"
  | "blur-background"
  | "color-background"
  | "image-background";

export interface SubjectSeparationSettings {
  preset: SubjectSeparationPreset;
  /** Gaussian-equivalent blur radius for `blur-background`, 0..64 px at 1080p. */
  blurAmount?: number;
  /** `#rgb`/`#rrggbb` for `color-background`. */
  backgroundColor?: string;
  /** Required by `image-background`. */
  backgroundImageUrl?: string;
  /** Matte threshold, 0..1. Default 0.5. */
  threshold?: number;
  /** Soft edge width around the threshold, 0..1. Default 0.12. */
  feather?: number;
  /** Grow (+) or shrink (−) the subject silhouette in matte units. Default 0. */
  edgeShift?: number;
  /** Keep the subject (false) or knock it out and keep the background (true). */
  invert?: boolean;
  /** Subject opacity, 0..1. Default 1. */
  opacity?: number;
}

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface SubjectSeparationPlan {
  preset: SubjectSeparationPreset;
  /** Background treatment; `null` for cutout-style output. */
  backgroundMode: BackgroundMode | null;
  blurRadiusPx: number;
  color: RgbColor | null;
  imageUrl: string | null;
  threshold: number;
  feather: number;
  edgeShift: number;
  invert: boolean;
  opacity: number;
  /** Human-readable one-liner for UI/agent summaries. */
  summary: string;
  warnings: string[];
}

export interface RgbaImage {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export const SUBJECT_SEPARATION_PRESETS: ReadonlyArray<{
  id: SubjectSeparationPreset;
  label: string;
  description: string;
}> = [
  {
    id: "cutout",
    label: "Subject cutout",
    description: "Subject only, everything else fully transparent (alpha export).",
  },
  {
    id: "transparent",
    label: "Transparent background",
    description: "Subject kept opaque, background transparent — same output, explicit naming.",
  },
  {
    id: "blur-background",
    label: "Blur background",
    description: "Depth-of-field look: subject sharp, background blurred.",
  },
  {
    id: "color-background",
    label: "Solid color background",
    description: "Replace the background with a flat color (e.g. brand green).",
  },
  {
    id: "image-background",
    label: "Image background",
    description: "Composite the subject over a still image.",
  },
];

export function parseHexColor(value: string): RgbColor | null {
  const hex = value.trim().replace(/^#/, "");
  const expanded =
    hex.length === 3
      ? hex
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) return null;
  return {
    r: Number.parseInt(expanded.slice(0, 2), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    b: Number.parseInt(expanded.slice(4, 6), 16),
  };
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/** Validates and resolves separation settings into a concrete plan. */
export function planSubjectSeparation(
  settings: SubjectSeparationSettings,
): SubjectSeparationPlan {
  const warnings: string[] = [];
  const threshold = clamp01(settings.threshold ?? 0.5);
  const feather = Math.max(0, Math.min(0.5, settings.feather ?? 0.12));
  const edgeShift = Math.max(-0.5, Math.min(0.5, settings.edgeShift ?? 0));
  const opacity = clamp01(settings.opacity ?? 1);
  const invert = settings.invert === true;

  let backgroundMode: BackgroundMode | null = null;
  let blurRadiusPx = 0;
  let color: RgbColor | null = null;
  let imageUrl: string | null = null;

  switch (settings.preset) {
    case "cutout":
    case "transparent":
      backgroundMode = "transparent";
      break;
    case "blur-background": {
      backgroundMode = "blur";
      const requested = settings.blurAmount ?? 15;
      blurRadiusPx = Math.max(0, Math.min(64, requested));
      if (requested > 64) {
        warnings.push("blurAmount clamped to 64px.");
      }
      if (blurRadiusPx === 0) {
        warnings.push("blurAmount is 0 — the background will be identical to the source.");
      }
      break;
    }
    case "color-background": {
      backgroundMode = "color";
      const parsed = parseHexColor(settings.backgroundColor ?? "#00ff00");
      if (!parsed) {
        warnings.push(
          `backgroundColor "${settings.backgroundColor}" is not a hex color; falling back to #00ff00.`,
        );
        color = parseHexColor("#00ff00");
      } else {
        color = parsed;
      }
      break;
    }
    case "image-background": {
      backgroundMode = "image";
      imageUrl = settings.backgroundImageUrl ?? null;
      if (!imageUrl) {
        backgroundMode = "color";
        color = { r: 0, g: 0, b: 0 };
        warnings.push(
          "image-background needs backgroundImageUrl; falling back to a black background.",
        );
      }
      break;
    }
  }

  if (invert && settings.preset === "cutout") {
    warnings.push(
      "invert with a cutout preset keeps the background and drops the subject — use color-background if you want to see the plate.",
    );
  }
  if (feather === 0) {
    warnings.push("feather is 0 — matte edges will be hard/aliased.");
  }

  const summary = (() => {
    const subject = invert ? "background" : "subject";
    switch (settings.preset) {
      case "cutout":
      case "transparent":
        return `Isolate the ${subject} with a transparent background.`;
      case "blur-background":
        return `Keep the ${subject} sharp over a ${Math.round(blurRadiusPx)}px blurred background.`;
      case "color-background": {
        const hex = color
          ? `#${[color.r, color.g, color.b]
              .map((channel) => channel.toString(16).padStart(2, "0"))
              .join("")}`
          : "#00ff00";
        return `Keep the ${subject} over a solid ${hex} background.`;
      }
      case "image-background":
        return `Composite the ${subject} over a still image.`;
    }
  })();

  return {
    preset: settings.preset,
    backgroundMode,
    blurRadiusPx,
    color,
    imageUrl,
    threshold,
    feather,
    edgeShift,
    invert,
    opacity,
    summary,
    warnings,
  };
}

/**
 * Maps a separation plan onto the live `BackgroundRemovalEngine` settings so
 * the inspector preview and the batch path stay visually consistent.
 */
export function backgroundRemovalSettingsFromSeparation(
  plan: SubjectSeparationPlan,
  base: Partial<BackgroundRemovalSettings> = {},
): BackgroundRemovalSettings {
  const merged: BackgroundRemovalSettings = {
    ...DEFAULT_BACKGROUND_SETTINGS,
    ...base,
    enabled: true,
    threshold: plan.threshold,
    edgeBlur: Math.max(0, Math.round(plan.feather * 100)),
  };
  if (plan.backgroundMode === null) return merged;
  merged.mode = plan.backgroundMode;
  if (plan.backgroundMode === "blur") {
    merged.blurAmount = plan.blurRadiusPx;
  }
  if (plan.backgroundMode === "color" && plan.color) {
    merged.backgroundColor = `#${[plan.color.r, plan.color.g, plan.color.b]
      .map((channel) => channel.toString(16).padStart(2, "0"))
      .join("")}`;
  }
  if (plan.backgroundMode === "image" && plan.imageUrl) {
    merged.backgroundImageUrl = plan.imageUrl;
  }
  return merged;
}

/**
 * Effective subject alpha (0..1) for one matte value, applying threshold,
 * feather band, edge shift, invert and opacity.
 *
 * `edgeShift` moves the 50% crossing of the feather band: positive grows the
 * subject, negative shrinks it. Because the matte is a coverage probability,
 * shifting the threshold is equivalent to a sub-pixel erode/dilate.
 */
export function subjectAlphaAt(
  matteValue: number,
  plan: Pick<
    SubjectSeparationPlan,
    "threshold" | "feather" | "edgeShift" | "invert" | "opacity"
  >,
): number {
  const value = Math.max(0, Math.min(1, matteValue));
  const center = clamp01(plan.threshold - plan.edgeShift);
  const band = Math.max(0.001, plan.feather);
  const start = Math.max(0, center - band);
  const end = Math.min(1, center + band);
  let alpha = value <= start ? 0 : value >= end ? 1 : (value - start) / (end - start);
  // Smoothstep the band so edges are not linear ramps.
  alpha = alpha * alpha * (3 - 2 * alpha);
  if (plan.invert) alpha = 1 - alpha;
  return alpha * clamp01(plan.opacity);
}

/** Separable box blur over RGB (alpha untouched) — a cheap, dependency-free
 * stand-in for the preview engine's gaussian blur. Radius is in pixels. */
export function boxBlurRgba(image: RgbaImage, radius: number): Uint8ClampedArray {
  const { width, height } = image;
  const radiusPx = Math.max(0, Math.round(radius));
  const source = image.data;
  const horizontal = new Uint8ClampedArray(width * height * 4);
  const output = new Uint8ClampedArray(width * height * 4);
  const span = radiusPx * 2 + 1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let offset = -radiusPx; offset <= radiusPx; offset += 1) {
        const sampleX = Math.max(0, Math.min(width - 1, x + offset));
        const index = (y * width + sampleX) * 4;
        r += source[index];
        g += source[index + 1];
        b += source[index + 2];
        count += 1;
      }
      const index = (y * width + x) * 4;
      horizontal[index] = r / count;
      horizontal[index + 1] = g / count;
      horizontal[index + 2] = b / count;
      horizontal[index + 3] = source[index + 3];
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let offset = -radiusPx; offset <= radiusPx; offset += 1) {
        const sampleY = Math.max(0, Math.min(height - 1, y + offset));
        const index = (sampleY * width + x) * 4;
        r += horizontal[index];
        g += horizontal[index + 1];
        b += horizontal[index + 2];
        a += horizontal[index + 3];
      }
      const index = (y * width + x) * 4;
      output[index] = r / span;
      output[index + 1] = g / span;
      output[index + 2] = b / span;
      output[index + 3] = a / span;
    }
  }

  return output;
}

export interface SubjectSeparationInput {
  source: RgbaImage;
  matte: AlphaMask;
  /** Required for `image-background`; resized by the caller to source size. */
  background?: RgbaImage;
}

/**
 * Composites one frame. Output size always matches the source; for cutout
 * presets the background pixels are written with alpha 0 so the result can be
 * encoded straight to PNG/WebM with transparency.
 */
export function composeSubjectSeparation(
  input: SubjectSeparationInput,
  plan: SubjectSeparationPlan,
): RgbaImage {
  const { source, matte } = input;
  const width = source.width;
  const height = source.height;
  if (matte.width !== width || matte.height !== height) {
    throw new Error(
      `Matte size ${matte.width}x${matte.height} does not match source ${width}x${height}`,
    );
  }
  const background =
    plan.backgroundMode === "image" && input.background
      ? input.background
      : null;
  if (plan.backgroundMode === "image" && !background) {
    throw new Error("image-background requires a background image");
  }

  const blurred =
    plan.backgroundMode === "blur" && plan.blurRadiusPx > 0
      ? boxBlurRgba(source, plan.blurRadiusPx)
      : null;

  const output = new Uint8ClampedArray(width * height * 4);

  for (let index = 0; index < width * height; index += 1) {
    const px = index * 4;
    const alpha = subjectAlphaAt(matte.data[index] / 255, plan);

    let bgR: number;
    let bgG: number;
    let bgB: number;
    let bgA: number;
    if (plan.backgroundMode === "transparent" || plan.backgroundMode === null) {
      bgR = 0;
      bgG = 0;
      bgB = 0;
      bgA = 0;
    } else if (plan.backgroundMode === "color" && plan.color) {
      bgR = plan.color.r;
      bgG = plan.color.g;
      bgB = plan.color.b;
      bgA = 255;
    } else if (background) {
      const bgIndex =
        (Math.min(height - 1, Math.floor(index / width)) * width +
          Math.min(width - 1, index % width)) *
        4;
      bgR = input.background!.data[bgIndex];
      bgG = input.background!.data[bgIndex + 1];
      bgB = input.background!.data[bgIndex + 2];
      bgA = input.background!.data[bgIndex + 3] || 255;
    } else if (blurred) {
      bgR = blurred[px];
      bgG = blurred[px + 1];
      bgB = blurred[px + 2];
      bgA = 255;
    } else {
      bgR = source.data[px];
      bgG = source.data[px + 1];
      bgB = source.data[px + 2];
      bgA = 255;
    }

    // Straight-alpha "over" composite of subject onto background.
    const outA = alpha + (bgA / 255) * (1 - alpha);
    if (outA <= 0) {
      output[px] = 0;
      output[px + 1] = 0;
      output[px + 2] = 0;
      output[px + 3] = 0;
      continue;
    }
    output[px] = (source.data[px] * alpha + bgR * (bgA / 255) * (1 - alpha)) / outA;
    output[px + 1] =
      (source.data[px + 1] * alpha + bgG * (bgA / 255) * (1 - alpha)) / outA;
    output[px + 2] =
      (source.data[px + 2] * alpha + bgB * (bgA / 255) * (1 - alpha)) / outA;
    output[px + 3] = outA * 255;
  }

  return { data: output, width, height };
}

export interface SeparationQualityReport {
  /** Fraction of pixels that are fully subject (alpha ≥ 0.95). */
  solidSubject: number;
  /** Fraction fully background (alpha ≤ 0.05). */
  solidBackground: number;
  /** Fraction in the feathered band (edge work). */
  edgePixels: number;
  averageCoverage: number;
  warnings: string[];
}

/** Cheap, provider-independent sanity report for a composed frame. */
export function assessSeparation(
  matte: AlphaMask,
  plan: Pick<SubjectSeparationPlan, "threshold" | "feather" | "edgeShift" | "invert" | "opacity">,
): SeparationQualityReport {
  let solidSubject = 0;
  let solidBackground = 0;
  let edges = 0;
  let coverageSum = 0;
  const total = Math.max(1, matte.width * matte.height);

  for (let index = 0; index < matte.width * matte.height; index += 1) {
    const alpha = subjectAlphaAt(matte.data[index] / 255, plan);
    coverageSum += alpha;
    if (alpha >= 0.95) solidSubject += 1;
    else if (alpha <= 0.05) solidBackground += 1;
    else edges += 1;
  }

  const averageCoverage = coverageSum / total;
  const warnings: string[] = [];
  if (averageCoverage < 0.005) {
    warnings.push("The matte covers almost none of the frame — segmentation likely failed.");
  }
  if (averageCoverage > 0.98) {
    warnings.push("The matte covers almost the whole frame — threshold may be too low.");
  }
  if (edges / total > 0.35) {
    warnings.push(
      "More than a third of the frame is in the feathered band — lower feather for a cleaner cut.",
    );
  }
  return {
    solidSubject: solidSubject / total,
    solidBackground: solidBackground / total,
    edgePixels: edges / total,
    averageCoverage,
    warnings,
  };
}
