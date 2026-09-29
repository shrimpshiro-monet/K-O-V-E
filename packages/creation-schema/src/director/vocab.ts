import type { EditPlan, PlannedEffect, PlannedTransition } from "./edit-plan";

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
 * Plan effect types that materialize as clip color grading rather than a
 * rendered effect layer (see materializeEditPlan's colorGrade branch).
 */
export const COLOR_GRADE_EFFECT_TYPES = [
  "colorGrade",
  "color-grade",
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
  "cut",
  "jumpCut",
  "jump-cut",
  // A match cut is still a cut: adjacent similar compositions, no blend.
  "match-cut",
  "matchCut",
  "none",
  "",
]);

/** Well-known transition names that map onto a supported rendered type. */
export const TRANSITION_TYPE_ALIASES: Readonly<Record<string, string>> = {
  fade: "crossfade",
  dissolve: "crossfade",
};

/**
 * Map a requested transition type to what the renderer can actually draw.
 * Returns `null` when the request is a hard cut (nothing to render) or an
 * empty/no-op name — callers should drop those transitions entirely.
 * Returns the input unchanged when it is already a supported type.
 * Throws nothing: unsupported names come back unchanged for validation to
 * reject with a structured error.
 */
export function canonicalizeTransitionType(type: string): string | null {
  const trimmed = type.trim();
  if (CUT_TRANSITION_TYPES.has(trimmed)) return null;
  const alias = TRANSITION_TYPE_ALIASES[trimmed] ?? TRANSITION_TYPE_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;
  return trimmed;
}

export function isSupportedTransitionType(type: string): boolean {
  return (SUPPORTED_TRANSITION_TYPES as readonly string[]).includes(type);
}

export function isSupportedEffectType(type: string): boolean {
  return (
    (SUPPORTED_CLIP_EFFECT_TYPES as readonly string[]).includes(type) ||
    (COLOR_GRADE_EFFECT_TYPES as readonly string[]).includes(type)
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
