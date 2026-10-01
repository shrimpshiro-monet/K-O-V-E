import type { EditPlan, PlannedEffect, PlannedTransition } from "./edit-plan";
import {
  isSignatureEffectType,
  resolveSignatureEffectName,
  SIGNATURE_EFFECT_NAMES,
} from "./shader-effects";

/**
 * Renderer-backed vocabulary for director plans.
 *
 * These lists are the boundary contract: anything outside them is silently
 * dropped or ignored by the renderer today, so plan validation rejects it
 * before commit.
 *
 * Source of truth (mirrored here because creation-schema must not depend on
 * @kove-advanced/core):
 * - transitions: `TRANSITION_TYPES` in packages/core/src/types/effects.ts,
 *   consumed by packages/core/src/video/transition-engine.ts.
 * - clip effects: the `VideoEffectsEngine` switch cases in
 *   packages/core/src/video/video-effects-engine.ts, mirrored by the web
 *   `VideoEffectType` union in apps/web/src/bridges/effects-bridge.ts.
 * A sync test in packages/agent asserts the transition list matches core.
 */
export const SUPPORTED_TRANSITION_TYPES = [
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
] as const;

export const SUPPORTED_CLIP_EFFECT_TYPES = [
  "brightness",
  "contrast",
  "saturation",
  "grayscale",
  "sepia",
  "invert",
  "hue",
  "blur",
  "sharpen",
  "vignette",
  "grain",
  "temperature",
  "tint",
  "tonal",
  "chromaKey",
  "shadow",
  "glow",
  "motion-blur",
  "radial-blur",
  "chromatic-aberration",
  "shader",
] as const;

/**
 * Every effect type a plan may name: engine filter effects, colour-grading
 * aliases, and the named signature shader effects (`shader-effects.ts`). Kept
 * separate from `SUPPORTED_CLIP_EFFECT_TYPES` — that list mirrors the engine's
 * own switch, while this one is what validation and error messages advertise.
 */
export const SUPPORTED_EFFECT_TYPES: readonly string[] = [
  ...SUPPORTED_CLIP_EFFECT_TYPES,
  ...SIGNATURE_EFFECT_NAMES,
];

/**
 * Plan effect types that materialize as clip color grading rather than a
 * rendered effect layer (see materializeEditPlan's colorGrade branch).
 */
export const COLOR_GRADE_EFFECT_TYPES = [
  "colorGrade",
  "color-grade",
  "color-grading",
  "color_grade",
  "color_grading",
  "colorGrading",
] as const;

/**
 * Transition names that mean "a hard cut". A cut is the ABSENCE of a rendered
 * transition, so plans may reference these freely — they are removed during
 * canonicalization instead of being emitted as no-op transition objects.
 */
export const CUT_TRANSITION_TYPES: ReadonlySet<string> = new Set([
  "hardCut",
  "hard-cut",
  "hard cut",
  "hardcut",
  "hard_cut",
  "cut",
  "jumpCut",
  "jump-cut",
  "jump cut",
  "jumpcut",
  "jump_cut",
  // A match cut is still a cut: adjacent similar compositions, no blend.
  "match-cut",
  "matchCut",
  "match cut",
  "matchcut",
  "match_cut",
  "none",
  "",
]);

/** Well-known transition names that map onto a supported rendered type. */
export const TRANSITION_TYPE_ALIASES: Readonly<Record<string, string>> = {
  fade: "crossfade",
  dissolve: "crossfade",
  // Common spellings for the second wave. Aliases keep a plan's intent instead
  // of rejecting it: "whip zoom" is a crossZoom, "datamosh" is a pixelSort.
  "whip-zoom": "crossZoom",
  whipzoom: "crossZoom",
  "zoom-punch": "crossZoom",
  "crash-zoom": "crossZoom",
  crashzoom: "crossZoom",
  "radial-blur-wipe": "zoomBlur",
  "zoom-blur-transition": "zoomBlur",
  smear: "motionSmear",
  "motion-blur-cut": "motionSmear",
  "directional-smear": "motionSmear",
  strobe: "strobeCut",
  "flash-cut-strobe": "strobeCut",
  "flicker-cut": "strobeCut",
  "shake-cut": "impactShake",
  "impact-hit": "impactShake",
  "camera-shake": "impactShake",
  "luma-dissolve": "lumaWipe",
  "luminance-wipe": "lumaWipe",
  "brightness-wipe": "lumaWipe",
  "ink-wipe": "inkBleed",
  "ink-reveal": "inkBleed",
  "blot-reveal": "inkBleed",
  "bleed-in": "inkBleed",
  "tile-flip-in": "tileFlip",
  "card-flip": "tileFlip",
  "flip-tiles": "tileFlip",
  "shutter-wipe": "sliceSlide",
  "band-slide": "sliceSlide",
  "slice-wipe": "sliceSlide",
  "light-leak-transition": "lightLeak",
  leak: "lightLeak",
  "leak-flare": "lightLeak",
  "vhs-cut": "vhsScan",
  "tape-wipe": "vhsScan",
  "vhs-glitch-cut": "vhsScan",
  "burn-through": "paperBurn",
  "burn-reveal": "paperBurn",
  "fire-wipe": "paperBurn",
  datamosh: "pixelSort",
  "pixel-sort-transition": "pixelSort",
  "sort-smear": "pixelSort",
  "film-roll": "filmRoll",
  "roll-up": "filmRoll",
  "projector-roll": "filmRoll",
};

/**
 * Map a requested transition type to what the renderer can actually draw.
 * Returns `null` when the request is a hard cut (nothing to render) or an
 * empty/no-op name — callers should drop those transitions entirely.
 * Returns the input unchanged when it is already a supported type.
 * Throws nothing: unsupported names come back unchanged for validation to
 * reject with a structured error.
 */
/** `"Whip Zoom"`, `"whip_zoom"` and `"whipZoom"` all normalize to `whip-zoom`. */
function transitionLookupKey(type: string): string {
  return type
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

export function canonicalizeTransitionType(type: string): string | null {
  const trimmed = type.trim();
  if (CUT_TRANSITION_TYPES.has(trimmed) || CUT_TRANSITION_TYPES.has(trimmed.toLowerCase())) {
    return null;
  }
  const alias =
    TRANSITION_TYPE_ALIASES[trimmed] ??
    TRANSITION_TYPE_ALIASES[trimmed.toLowerCase()] ??
    TRANSITION_TYPE_ALIASES[transitionLookupKey(trimmed)];
  if (alias) return alias;
  return trimmed;
}

export function isSupportedTransitionType(type: string): boolean {
  return (SUPPORTED_TRANSITION_TYPES as readonly string[]).includes(type);
}

/**
 * Text animation presets the title engine can actually animate (mirrors
 * `TextAnimationPreset` in packages/core/src/text/types.ts — creation-schema
 * must not depend on core). An unsupported name is not a crash: the preset is
 * stored on the clip and the renderer silently draws it as "none", which is
 * exactly the class of quiet no-op the director must not be allowed to plan.
 */
export const SUPPORTED_TEXT_ANIMATIONS = [
  "none",
  "typewriter",
  "fade",
  "slide-left",
  "slide-right",
  "slide-up",
  "slide-down",
  "scale",
  "blur",
  "bounce",
  "rotate",
  "wave",
  "shake",
  "pop",
  "glitch",
  "split",
  "flip",
  "word-by-word",
  "rainbow",
  "rise",
  "drop",
  "elastic",
  "swing",
  "zoom-blur",
  "cascade",
] as const;

export type SupportedTextAnimation = (typeof SUPPORTED_TEXT_ANIMATIONS)[number];

/**
 * Spellings that show up in prompts, genre templates, and LLM output that are
 * not the renderer's canonical preset ids. Mapped instead of rejected: the
 * genre templates themselves shipped `text-reveal-up` (a Motion text-animator
 * id) which the title engine reads as "no animation".
 */
export const TEXT_ANIMATION_ALIASES: Readonly<Record<string, SupportedTextAnimation>> = {
  "text-reveal-up": "slide-up",
  "text-reveal-down": "slide-down",
  "text-reveal-left": "slide-left",
  "text-reveal-right": "slide-right",
  "text-type-on": "typewriter",
  "text-fade-in": "fade",
  "text-pop": "pop",
  "text-bounce": "bounce",
  fadein: "fade",
  "fade-in": "fade",
  fadeout: "fade",
  "fade-out": "fade",
  slideup: "slide-up",
  slidedown: "slide-down",
  slideleft: "slide-left",
  slideright: "slide-right",
  scalein: "scale",
  scaleout: "scale",
  rotatein: "rotate",
  "zoom-in": "scale",
  zoomin: "scale",
  wordbyword: "word-by-word",
  "word-by-word-reveal": "word-by-word",
  karaoke: "word-by-word",
  shaking: "shake",
  wiggle: "wave",
};

/** Map a requested text animation to a renderer-backed preset id, or null. */
export function normalizeTextAnimation(raw: string | undefined | null): SupportedTextAnimation | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if ((SUPPORTED_TEXT_ANIMATIONS as readonly string[]).includes(lower)) {
    return lower as SupportedTextAnimation;
  }
  if ((SUPPORTED_TEXT_ANIMATIONS as readonly string[]).includes(trimmed)) {
    return trimmed as SupportedTextAnimation;
  }
  return TEXT_ANIMATION_ALIASES[lower] ?? null;
}

export function isSupportedTextAnimation(raw: string | undefined | null): boolean {
  return normalizeTextAnimation(raw) !== null;
}

export function isSupportedEffectType(type: string): boolean {
  return (
    (SUPPORTED_CLIP_EFFECT_TYPES as readonly string[]).includes(type) ||
    (COLOR_GRADE_EFFECT_TYPES as readonly string[]).includes(type) ||
    isSignatureEffectType(type)
  );
}

/**
 * Target palettes (genre style profiles) are suggestions, not commits:
 * translate known aliases and drop anything the renderer cannot draw so the
 * style comparison never penalizes a plan for a genre that references a
 * nonexistent effect or transition.
 */
export function canonicalizeTargetEffects(names: readonly string[]): readonly string[] {
  const out = new Set<string>();
  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    if (isSupportedEffectType(trimmed)) {
      out.add(trimmed);
      continue;
    }
    const alias = EFFECT_TARGET_ALIASES[trimmed] ?? EFFECT_TARGET_ALIASES[trimmed.toLowerCase()];
    if (alias && isSupportedEffectType(alias)) out.add(alias);
    // Unsupported suggestion with no known translation → drop.
  }
  return [...out];
}

export function canonicalizeTargetTransitions(names: readonly string[]): readonly string[] {
  const out = new Set<string>();
  for (const name of names) {
    const canonical = canonicalizeTransitionType(name);
    if (canonical !== null && isSupportedTransitionType(canonical)) out.add(canonical);
  }
  return [...out];
}

/** Aliases used only when canonicalizing style TARGETS (prompt suggestions). */
const EFFECT_TARGET_ALIASES: Readonly<Record<string, string>> = {
  warmth: "temperature",
  "color-balance": "temperature",
  "hue-saturation": "hue",
  "film-grain": "grain",
  "zoom-punch": "chromatic-aberration",
  // "shake" has no clip-effect equivalent; it is dropped rather than mapped.
};

/**
 * Canonicalize a plan's transitions before validation/commit:
 * hard cuts are removed (a cut needs no transition object), known aliases are
 * translated to supported types. `afterSegmentIndex` values are segment
 * indexes, so removing transition entries never renumbers anything.
 */
export function canonicalizePlanTransitions(plan: EditPlan): EditPlan {
  const transitions: PlannedTransition[] = [];
  for (const transition of plan.transitions) {
    const canonical = canonicalizeTransitionType(transition.type);
    if (canonical === null) continue; // hard cut — nothing to render
    transitions.push({ ...transition, type: canonical });
  }
  if (transitions.length === plan.transitions.length) return plan;
  return { ...plan, transitions };
}

/** Effects are validated strictly (no in-plan aliasing) — exported for tests. */
export function collectPlanEffectTypes(plan: EditPlan): string[] {
  const types: string[] = [];
  for (const effect of plan.effects as PlannedEffect[]) types.push(effect.type);
  for (const segment of plan.segments) {
    for (const type of segment.effects) types.push(type);
    for (const spec of segment.effectSpecs ?? []) types.push(spec.type);
  }
  return types;
}

/**
 * Canonical lookup for effect names, case-insensitively. Built from the
 * renderer-backed lists so an alias can never resolve to something the
 * renderer cannot draw.
 */
const EFFECT_CANONICAL_BY_LOWER: ReadonlyMap<string, string> = new Map(
  [...SUPPORTED_CLIP_EFFECT_TYPES, ...COLOR_GRADE_EFFECT_TYPES].map(
    (type) => [type.toLowerCase(), type] as const,
  ),
);

/**
 * Common LLM inventions and variant spellings, mapped to the nearest
 * renderer-supported type. `normalizeEditPlan` rewrites the plan with these
 * before validation, so an accepted alias reaches the materializer as a name
 * that actually renders. Targets that have no renderer equivalent (e.g.
 * "shake", "zoom-punch") are deliberately absent — they stay rejected.
 */
const EFFECT_TYPE_ALIASES: Readonly<Record<string, string>> = {
  warmth: "temperature",
  "film-grain": "grain",
  gaussianblur: "blur",
  "gaussian-blur": "blur",
  "hue-saturation": "hue",
  "color-wheel": "tonal",
  colorwheels: "tonal",
  sharpening: "sharpen",
  motionblur: "motion-blur",
  motion_blur: "motion-blur",
  radialblur: "radial-blur",
  radial_blur: "radial-blur",
  chromaticaberration: "chromatic-aberration",
  chromatic_aberration: "chromatic-aberration",
  "impact-fx": "glow",
  impact: "glow",
  punch: "chromatic-aberration",
  punchy: "chromatic-aberration",
  hit: "chromatic-aberration",
};

/** Map an LLM-proposed effect type to a renderer-backed name, or undefined. */
export function normalizeEffectType(raw: string | undefined | null): string | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  const key = raw.trim().toLowerCase();
  if (!key) return undefined;
  return (
    EFFECT_CANONICAL_BY_LOWER.get(key) ??
    EFFECT_TYPE_ALIASES[key] ??
    // Signature shader effects: "crt" → "scanlines", "vhs tape" → "vhs".
    resolveSignatureEffectName(key)
  );
}

/**
 * True if the effect type is a color-grade action that routes to
 * `clip/setColorGrading` rather than `effect/add`. Case-insensitive.
 */
export function isColorGradeType(raw: string | undefined | null): boolean {
  if (!raw || typeof raw !== "string") return false;
  const key = raw.trim().toLowerCase();
  return (COLOR_GRADE_EFFECT_TYPES as readonly string[]).some(
    (type) => type.toLowerCase() === key,
  );
}

/**
 * Structural features the LLM puts in effectSpecs by mistake. Rejecting them
 * with an actionable "it belongs here" hint is what makes the single repair
 * attempt succeed — without it the model reads "unknown effect" as "delete
 * this feature" and drops it.
 */
export const MISPLACED_FEATURE_HINTS: Readonly<Record<string, string>> = {
  "speed-ramp": "Speed ramps are not filter effects. Set `segment.speedRamp: { keyframes: [{ time, speed }] }` on the segment instead.",
  speedramp: "Speed ramps are not filter effects. Set `segment.speedRamp` on the segment instead.",
  speed_ramp: "Speed ramps are not filter effects. Set `segment.speedRamp` on the segment instead.",
  speedramping: "Speed ramps are not filter effects. Set `segment.speedRamp` on the segment instead.",
  zoom: "Zoom is a transform, not a filter effect. Use transform keyframes on the clip.",
  "zoom-punch": "Zoom is a transform, not a filter effect. Use transform keyframes on the clip.",
  pan: "Pan is a transform, not a filter effect. Use transform keyframes on the clip.",
  crop: "Crop is a transform, not a filter effect. Use transform keyframes on the clip.",
  crossfade: "Transitions go in `plan.transitions[]`, not in effectSpecs.",
  transition: "Transitions go in `plan.transitions[]`, not in effectSpecs.",
  fade: "Transitions go in `plan.transitions[]`, not in effectSpecs.",
};

/** Actionable hint for a misplaced feature, or undefined if there is none. */
export function getMisplacedFeatureHint(raw: string | undefined | null): string | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  return MISPLACED_FEATURE_HINTS[raw.trim().toLowerCase()];
}
