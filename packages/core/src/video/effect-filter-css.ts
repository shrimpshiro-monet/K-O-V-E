import type { Effect } from "../types/timeline";

/**
 * The ONE CSS-filter interpretation of a clip effect's stored params.
 *
 * Every renderer path that turns clip effects into CSS filter strings (the
 * live effects engine's CSS batch, the Canvas2D fallback renderer, the video
 * engine's single-effect path, the unified effects processor) delegates here,
 * so the brightness/contrast/saturation scale can never drift between engines
 * again. The scale is the one true clip-effect param table
 * (types/clip-effect-params.ts):
 *
 * - brightness/temperature/tint `value` — percent offset, 0 = unchanged
 * - contrast/saturation `value` — CSS multiplier, 1 = unchanged
 * - hue `rotation` — degrees
 * - blur `radius` — pixels
 *
 * Returns "" for effects that are not CSS-routable (sharpen, vignette, grain,
 * shaders, …) — those have engine-specific pixel/shader passes.
 */

function readNumber(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  // Numeric strings ("50", ".8") are coerced, not ignored — models emit them,
  // and a silent fallback to identity would turn a visible effect into a no-op.
  if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) {
    return Number(raw);
  }
  return fallback;
}

export function cssFilterForEffect(effect: Effect): string {
  if (!effect.enabled) return "";
  const params = effect.params;

  switch (effect.type) {
    case "brightness":
      return `brightness(${1 + readNumber(params.value, 0) / 100})`;
    case "contrast":
      return `contrast(${readNumber(params.value, 1)})`;
    case "saturation":
      return `saturate(${readNumber(params.value, 1)})`;
    case "grayscale":
      return `grayscale(${readNumber(params.amount, 1)})`;
    case "sepia":
      return `sepia(${readNumber(params.amount, 1)})`;
    case "invert":
      return `invert(${readNumber(params.amount, 1)})`;
    case "hue":
      return `hue-rotate(${readNumber(params.rotation, 0)}deg)`;
    case "blur":
      return `blur(${Math.max(0, readNumber(params.radius, 0))}px)`;
    case "shadow": {
      const color =
        typeof params.color === "string" && params.color ? params.color : "#000000";
      return `drop-shadow(${readNumber(params.offsetX, 0)}px ${readNumber(params.offsetY, 0)}px ${Math.max(0, readNumber(params.blur, 0))}px ${color})`;
    }
    default:
      return "";
  }
}
