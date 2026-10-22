/**
 * ONE true parameter scale for clip effects.
 *
 * This table is the single source of truth for what a numeric effect param
 * MEANS — the storage scale the inspector UI writes, every renderer path
 * reads, and every model-facing surface must advertise:
 *
 * - `unit: "%"` — percent offset, 0 = unchanged (brightness, temperature,
 *   tint). The renderer applies `1 + value/100` (or `value/100` for additive
 *   channel shifts).
 * - `unit: "x"` — CSS-style multiplier, 1 = unchanged (contrast, saturation,
 *   color-grade gains). `value` is fed straight into `contrast()/saturate()`.
 * - `unit: "px"` / `"deg"` — absolute pixels / degrees.
 * - `unit: "mix"` — 0..1 blend amount, 1 = full effect.
 *
 * Everything that tells a model about effect params (EFFECT_PARAM_BLOCK in
 * the director prompt, the capability manifest, tool descriptions) is
 * generated from this table, and the agent paths clamp emitted values to
 * these ranges. Never hardcode param ranges in prompt text again.
 */

export interface ClipEffectParamSpec {
  readonly key: string;
  readonly min: number;
  readonly max: number;
  readonly default: number;
  readonly unit: "%" | "x" | "px" | "deg" | "mix";
  readonly note: string;
}

export interface ClipEffectSpec {
  readonly type: string;
  readonly params: readonly ClipEffectParamSpec[];
  readonly note?: string;
}

export const CLIP_EFFECT_PARAM_SPECS: readonly ClipEffectSpec[] = [
  {
    type: "brightness",
    params: [
      {
        key: "value",
        min: -100,
        max: 100,
        default: 0,
        unit: "%",
        note: "percent offset; 0 = unchanged (renders brightness(1 + value/100))",
      },
    ],
  },
  {
    type: "contrast",
    params: [
      {
        key: "value",
        min: 0,
        max: 2,
        default: 1,
        unit: "x",
        note: "CSS multiplier; 1 = unchanged (1.2 = +20% contrast)",
      },
    ],
    note: "NEVER a percent offset — contrast(50) blows the frame out",
  },
  {
    type: "saturation",
    params: [
      {
        key: "value",
        min: 0,
        max: 2,
        default: 1,
        unit: "x",
        note: "CSS multiplier; 1 = unchanged (0 = grayscale)",
      },
    ],
    note: "NEVER a percent offset — saturate(50) blows the frame out",
  },
  {
    type: "grayscale",
    params: [
      { key: "amount", min: 0, max: 1, default: 1, unit: "mix", note: "0 = off, 1 = full gray" },
    ],
  },
  {
    type: "sepia",
    params: [
      { key: "amount", min: 0, max: 1, default: 1, unit: "mix", note: "0 = off, 1 = full sepia" },
    ],
  },
  {
    type: "invert",
    params: [
      { key: "amount", min: 0, max: 1, default: 1, unit: "mix", note: "0 = off, 1 = full invert" },
    ],
  },
  {
    type: "hue",
    params: [
      { key: "rotation", min: -180, max: 180, default: 0, unit: "deg", note: "hue rotation in degrees" },
    ],
  },
  {
    type: "blur",
    params: [
      { key: "radius", min: 0, max: 100, default: 0, unit: "px", note: "gaussian radius; keep hit blurs ≤10 (the GPU path clamps to 10)" },
    ],
  },
  {
    type: "sharpen",
    params: [
      { key: "amount", min: 0, max: 100, default: 0, unit: "%", note: "unsharp strength" },
    ],
  },
  {
    type: "vignette",
    params: [
      { key: "amount", min: 0, max: 100, default: 0, unit: "%", note: "edge darkening strength" },
      { key: "midpoint", min: 0, max: 1, default: 0.5, unit: "mix", note: "where the falloff starts" },
      { key: "feather", min: 0, max: 1, default: 0.3, unit: "mix", note: "falloff softness" },
    ],
  },
  {
    type: "grain",
    params: [
      { key: "amount", min: 0, max: 100, default: 0, unit: "%", note: "film-grain strength" },
    ],
  },
  {
    type: "temperature",
    params: [
      { key: "value", min: -100, max: 100, default: 0, unit: "%", note: "cool (-) to warm (+) percent shift; 0 = unchanged" },
    ],
  },
  {
    type: "tint",
    params: [
      { key: "value", min: -100, max: 100, default: 0, unit: "%", note: "green (-) to magenta (+) percent shift; 0 = unchanged" },
    ],
  },
  {
    type: "tonal",
    params: [
      { key: "shadows", min: -1, max: 1, default: 0, unit: "x", note: "shadow-band lift; 0 = unchanged" },
      { key: "midtones", min: -1, max: 1, default: 0, unit: "x", note: "midtone-band lift; 0 = unchanged" },
      { key: "highlights", min: -1, max: 1, default: 0, unit: "x", note: "highlight-band lift; 0 = unchanged" },
    ],
  },
  {
    type: "shadow",
    params: [
      { key: "offsetX", min: -100, max: 100, default: 5, unit: "px", note: "shadow x offset" },
      { key: "offsetY", min: -100, max: 100, default: 5, unit: "px", note: "shadow y offset" },
      { key: "blur", min: 0, max: 100, default: 10, unit: "px", note: "shadow softness" },
      { key: "opacity", min: 0, max: 1, default: 0.8, unit: "mix", note: "shadow opacity" },
    ],
  },
  {
    type: "glow",
    params: [
      { key: "radius", min: 0, max: 100, default: 10, unit: "px", note: "glow spread" },
      { key: "intensity", min: 0, max: 3, default: 1, unit: "x", note: "glow strength" },
    ],
  },
  {
    type: "motion-blur",
    params: [
      { key: "distance", min: 0, max: 100, default: 20, unit: "px", note: "smear distance" },
      { key: "angle", min: 0, max: 360, default: 0, unit: "deg", note: "smear direction" },
    ],
  },
  {
    type: "radial-blur",
    params: [
      { key: "amount", min: 0, max: 100, default: 20, unit: "%", note: "blur strength" },
      { key: "centerX", min: 0, max: 100, default: 50, unit: "%", note: "blur origin x" },
      { key: "centerY", min: 0, max: 100, default: 50, unit: "%", note: "blur origin y" },
    ],
  },
  {
    type: "chromatic-aberration",
    params: [
      { key: "amount", min: 0, max: 50, default: 0, unit: "px", note: "RGB channel split" },
    ],
  },
  {
    type: "chromaKey",
    params: [
      { key: "tolerance", min: 0, max: 1, default: 0.3, unit: "mix", note: "key match width (keyColor is {r,g,b} 0..1)" },
      { key: "edgeSoftness", min: 0, max: 1, default: 0.1, unit: "mix", note: "matte edge feather" },
    ],
  },
  {
    type: "colorGrade",
    params: [
      { key: "contrast", min: 0.8, max: 1.5, default: 1, unit: "x", note: "clip-grade multiplier; 1 = unchanged" },
      { key: "saturation", min: 0.8, max: 1.5, default: 1, unit: "x", note: "clip-grade multiplier; 1 = unchanged" },
      { key: "brightness", min: 0.8, max: 1.2, default: 1, unit: "x", note: "clip-grade multiplier; 1 = unchanged" },
    ],
    note: "clip color grading (routes to clip/setColorGrading) — NOT a filter effect",
  },
];

const SPECS_BY_TYPE: ReadonlyMap<string, ClipEffectSpec> = new Map(
  CLIP_EFFECT_PARAM_SPECS.map((spec) => [spec.type, spec]),
);

/** Look up the canonical param table for one clip effect type. */
export function getClipEffectParamSpec(type: string): ClipEffectSpec | undefined {
  return SPECS_BY_TYPE.get(type);
}

/**
 * Clamp agent-supplied effect params into the canonical ranges. Finite numbers
 * (and numeric strings — models emit `"value": "50"` more often than anyone
 * wants) outside a param's range are clamped, so a model that follows the old
 * percent-scale claim for contrast can no longer blow out the frame; other
 * params pass through untouched. Missing params are not filled —
 * synthesis/defaults handle absence, this polices presence.
 */
export function clampClipEffectParams(
  type: string,
  params: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const spec = SPECS_BY_TYPE.get(type);
  if (!spec) return { ...params };
  const out: Record<string, unknown> = { ...params };
  for (const param of spec.params) {
    const raw = out[param.key];
    const numeric =
      typeof raw === "number" && Number.isFinite(raw)
        ? raw
        : typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))
          ? Number(raw)
          : undefined;
    if (numeric !== undefined) {
      out[param.key] = Math.min(param.max, Math.max(param.min, numeric));
    }
  }
  return out;
}
