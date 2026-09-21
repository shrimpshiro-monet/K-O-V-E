/**
 * Canonical effect and transition type registries.
 *
 * The director LLM must only propose types that exist in these sets.
 * Any invented name (e.g. "zoom-punch", "warmth") is rejected at
 * validation time so materialize never silently no-ops.
 */

// ── Video filter / effect types ──────────────────────────────────────
// Source of truth: FilterType in packages/core/src/video/video-effects-engine.ts
// These are the types that `effect/add` actually recognizes.
export const KNOWN_EFFECT_TYPES = [
  "brightness",
  "contrast",
  "saturation",
  "hue",
  "blur",
  "sharpen",
  "vignette",
  "grain",
  "chromaKey",
  "temperature",
  "tint",
  "tonal",
  "shadow",
  "glow",
  "motion-blur",
  "radial-blur",
  "chromatic-aberration",
] as const;

export type KnownEffectType = (typeof KNOWN_EFFECT_TYPES)[number];

const EFFECT_TYPE_SET: ReadonlySet<string> = new Set<string>(KNOWN_EFFECT_TYPES);

/**
 * Map an LLM-proposed effect type string to a canonical known type,
 * or return `undefined` if no match exists.
 *
 * Handles common LLM inventions by mapping them to the nearest real
 * implementation:
 *  - "color-balance"  → undefined (not a filter effect; was never implemented)
 *  - "warmth"         → "temperature"
 *  - "zoom-punch"     → undefined (this is a transform/scale keyframe, not a filter)
 *  - "shake"          → undefined (this is a motion effect, not a filter)
 *  - "sepia"          → "tonal"
 *  - "film-grain"     → "grain"
 *  - "gaussianBlur"   → "blur"
 *  - "hue-saturation" → "hue"
 */
export function normalizeEffectType(raw: string | undefined | null): KnownEffectType | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return undefined;

  // Direct hit
  if (EFFECT_TYPE_SET.has(trimmed)) return trimmed as KnownEffectType;

  // Alias map — covers known LLM inventions and variant spellings
  const aliases: Record<string, KnownEffectType> = {
    "warmth": "temperature",
    "sepia": "tonal",
    "film-grain": "grain",
    "gaussianblur": "blur",
    "gaussian-blur": "blur",
    "hue-saturation": "hue",
    "color-wheel": "tonal",
    "colorwheels": "tonal",
    "sharpening": "sharpen",
    "motionblur": "motion-blur",
    "motion_blur": "motion-blur",
    "radialblur": "radial-blur",
    "radial_blur": "radial-blur",
    "chromaticaberration": "chromatic-aberration",
    "chromatic_aberration": "chromatic-aberration",
    "impact-fx": "glow",
    "impact": "glow",
    "punch": "chromatic-aberration",
    "punchy": "chromatic-aberration",
    "hit": "chromatic-aberration",
  };

  return aliases[trimmed];
}

/**
 * Return the full list of known effect types for use in prompts and validation.
 */
export function getKnownEffectTypes(): readonly KnownEffectType[] {
  return KNOWN_EFFECT_TYPES;
}

// ── Color grade special-case types ───────────────────────────────────
// These route to `clip/setColorGrading` in the materializer, not through
// the video-effects-engine filter pipeline. Shared between validation
// (validate.ts) and materialization (registry.ts) so both stay in sync.
const COLOR_GRADE_ALIASES: ReadonlySet<string> = new Set([
  "colorgrade",
  "color-grade",
  "color-grading",
  "color_grade",
  "color_grading",
  "colorgrading",
]);

/**
 * True if the effect type is a color-grade action that routes to
 * `clip/setColorGrading` rather than `effect/add`. Case-insensitive.
 */
export function isColorGradeType(raw: string | undefined | null): boolean {
  if (!raw || typeof raw !== "string") return false;
  return COLOR_GRADE_ALIASES.has(raw.trim().toLowerCase());
}

// ── Misplaced-feature hints ──────────────────────────────────────────
// When the LLM puts a structural feature (speed ramp, transform, transition,
// text) into effectSpecs, we reject it — but tell the LLM exactly where it
// belongs so the retry has a chance of succeeding. Without this, the model
// reads "unknown effect type" as "remove this" and drops the feature.
export const MISPLACED_FEATURE_HINTS: Readonly<Record<string, string>> = {
  "speed-ramp": "Speed ramps are not filter effects. Set `segment.speedRamp: { keyframes: [{ time, speed }] }` on the segment instead.",
  "speedramp": "Speed ramps are not filter effects. Set `segment.speedRamp` on the segment instead.",
  "speed_ramp": "Speed ramps are not filter effects. Set `segment.speedRamp` on the segment instead.",
  "speedramping": "Speed ramps are not filter effects. Set `segment.speedRamp` on the segment instead.",
  "zoom": "Zoom is a transform, not a filter effect. Use transform keyframes on the clip.",
  "zoom-punch": "Zoom is a transform, not a filter effect. Use transform keyframes on the clip.",
  "pan": "Pan is a transform, not a filter effect. Use transform keyframes on the clip.",
  "crop": "Crop is a transform, not a filter effect. Use transform keyframes on the clip.",
  "crossfade": "Transitions go in `plan.transitions[]`, not in effectSpecs.",
  "transition": "Transitions go in `plan.transitions[]`, not in effectSpecs.",
  "fade": "Transitions go in `plan.transitions[]`, not in effectSpecs.",
};

/**
 * Return the actionable hint for a misplaced feature, or undefined if the
 * type is just an unknown invention with no obvious correct home.
 */
export function getMisplacedFeatureHint(raw: string | undefined | null): string | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  return MISPLACED_FEATURE_HINTS[raw.trim().toLowerCase()];
}

// ── Transition types ─────────────────────────────────────────────────
// Source of truth: TRANSITION_TYPES in packages/core/src/types/effects.ts
export const KNOWN_TRANSITION_TYPES = [
  "crossfade",
  "dipToBlack",
  "dipToWhite",
  "wipe",
  "slide",
  "zoom",
  "push",
  "circleReveal",
  "blur",
  "whipPan",
  "radialWipe",
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
] as const;

export type KnownTransitionType = (typeof KNOWN_TRANSITION_TYPES)[number];

const TRANSITION_TYPE_SET: ReadonlySet<string> = new Set<string>(KNOWN_TRANSITION_TYPES);

/**
 * Map an LLM-proposed transition type string to a canonical known type,
 * or return `undefined` if no match exists.
 *
 * Handles common LLM inventions:
 *  - "hardCut" → undefined (hard cuts have no transition; use no transition entry)
 *  - "cut"     → undefined (same as hardCut)
 *  - "fade"    → "crossfade" (closest real implementation)
 *  - "dissolve"→ "crossfade"
 *  - "match-cut" → undefined (no implementation; closest is "flash" or "crossfade")
 *  - "jumpCut" → undefined (no implementation)
 */
export function normalizeTransitionType(raw: string | undefined | null): KnownTransitionType | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  // Direct hit
  if (TRANSITION_TYPE_SET.has(trimmed)) return trimmed as KnownTransitionType;

  // Alias map
  const lower = trimmed.toLowerCase();
  const aliases: Record<string, KnownTransitionType> = {
    "fade": "crossfade",
    "dissolve": "crossfade",
    "dip_to_black": "dipToBlack",
    "dip_to_white": "dipToWhite",
    "circle_reveal": "circleReveal",
    "diamond_reveal": "diamondReveal",
    "radial_wipe": "radialWipe",
    "split_reveal": "splitReveal",
    "film_burn": "filmBurn",
    "page_turn": "pageTurn",
    "color_split": "colorSplit",
    "whip_pan": "whipPan",
    "whip": "whipPan",
    "hardcut": "crossfade",
    "hard_cut": "crossfade",
    "cut": "crossfade",
    "match-cut": "flash",
    "match_cut": "flash",
    "jumpcut": "crossfade",
    "jump_cut": "crossfade",
  };

  return aliases[lower];
}

/**
 * Return the full list of known transition types for use in prompts and validation.
 */
export function getKnownTransitionTypes(): readonly KnownTransitionType[] {
  return KNOWN_TRANSITION_TYPES;
}
