export type StyleProfilePacing = "fast" | "moderate" | "medium" | "slow" | "unknown";
export type StyleProfileCutStyle = "hard" | "soft" | "mixed" | "unknown";

export interface StyleProfile {
  readonly version: "1.0.0";
  readonly pacing: StyleProfilePacing;
  readonly cutsPerMinute: number;
  readonly medianShotDuration: number;
  readonly cutOnBeatRatio: number | null;
  readonly effectDensity: number;
  readonly transitionDensity: number;
  readonly textOverlayDensity: number;
  readonly shotTypeDistribution: Readonly<Record<string, number>>;
  readonly cutStyle: StyleProfileCutStyle;
  readonly effectPalette: readonly string[];
  readonly transitionPalette: readonly string[];
  readonly detectedBpm: number | null;
  readonly dialogueRatio: number;
  readonly musicRatio: number;
  readonly confidence: number;
}

export interface StyleProfileTarget {
  readonly pacing?: StyleProfilePacing;
  readonly cutsPerMinute?: readonly [number, number];
  readonly cutStyle?: StyleProfileCutStyle;
  readonly effectPalette?: readonly string[];
  readonly transitionPalette?: readonly string[];
}

export interface StyleProfileComparison {
  readonly score: number;
  readonly deviations: readonly string[];
}

export function compareStyleProfile(
  profile: StyleProfile,
  target: StyleProfileTarget,
): StyleProfileComparison {
  const scores: number[] = [];
  const deviations: string[] = [];

  if (target.cutsPerMinute) {
    const [minimum, maximum] = target.cutsPerMinute;
    if (profile.cutsPerMinute < minimum || profile.cutsPerMinute > maximum) {
      const distance = profile.cutsPerMinute < minimum
        ? minimum - profile.cutsPerMinute
        : profile.cutsPerMinute - maximum;
      scores.push(Math.max(0, 1 - distance / Math.max(1, maximum - minimum)));
      deviations.push(`cutsPerMinute ${profile.cutsPerMinute} is outside ${minimum}-${maximum}`);
    } else {
      scores.push(1);
    }
  }

  if (target.pacing) {
    const matches = pacingMatches(profile.pacing, target.pacing);
    scores.push(matches ? 1 : 0);
    if (!matches) {
      deviations.push(`pacing ${profile.pacing} does not match ${target.pacing}`);
    }
  }

  if (target.cutStyle) {
    scores.push(profile.cutStyle === target.cutStyle ? 1 : 0);
    if (profile.cutStyle !== target.cutStyle) {
      deviations.push(`cutStyle ${profile.cutStyle} does not match ${target.cutStyle}`);
    }
  }

  if (target.effectPalette) {
    scores.push(paletteOverlap(profile.effectPalette, target.effectPalette));
  }
  if (target.transitionPalette) {
    scores.push(paletteOverlap(profile.transitionPalette, target.transitionPalette));
  }

  return {
    score: scores.length > 0 ? scores.reduce((sum, value) => sum + value, 0) / scores.length : 1,
    deviations,
  };
}

function paletteOverlap(actual: readonly string[], target: readonly string[]): number {
  if (target.length === 0) return 1;
  const targetValues = new Set(target);
  return actual.filter((value) => targetValues.has(value)).length / target.length;
}

/**
 * "medium" and "moderate" describe the same pacing band but appear on
 * different sides of the pipeline (plan metadata says "medium", reference
 * analysis says "moderate"). Comparing them literally made every medium-paced
 * genre deviation permanently unfixable.
 */
export function pacingMatches(
  profile: StyleProfilePacing,
  target: StyleProfilePacing,
): boolean {
  const canonical = (value: StyleProfilePacing): string =>
    value === "moderate" || value === "medium" ? "medium" : value;
  return canonical(profile) === canonical(target);
}