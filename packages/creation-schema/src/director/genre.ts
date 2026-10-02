export type CutStyle = "hard" | "soft" | "mixed";
export type MusicRole = "background" | "featured" | "rhythmic";
export type ColorMood = "warm" | "cool" | "neutral" | "vibrant";
export type TextStyleDensity = "none" | "minimal" | "moderate" | "heavy";

import type { EditDensityTarget } from "./density";
import type { CaptionStyleTemplate } from "./edit-plan";
import type { StyleProfileTarget } from "./style-profile";

export interface GenreRules {
  readonly pacing: "fast" | "medium" | "slow";
  readonly transitionPreference: readonly string[];
  readonly effectPalette: readonly string[];
  readonly textStyle: TextStyleDensity;
  readonly cutStyle: CutStyle;
  readonly colorMood?: ColorMood;
  readonly musicRole: MusicRole;
}

export interface Genre {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly rules: GenreRules;
  readonly captionTemplate?: CaptionStyleTemplate;
  readonly pacing?: "fast" | "medium" | "slow";
  readonly cutsPerMinuteTarget?: readonly [number, number];
  readonly effectPalette?: readonly string[];
  readonly transitionPalette?: readonly string[];
  readonly musicMoodHints?: readonly string[];
  readonly layoutHint?: "sequential" | "split-compare" | "pip-reaction";
  readonly styleProfile?: StyleProfileTarget;
  /**
   * How populated this genre's timelines are expected to be. Overrides the
   * pacing preset in `resolveDensityTarget` field by field, so a genre can
   * raise the cut rate without dropping its caption requirements (or the
   * reverse). See `density.ts`.
   */
  readonly densityTarget?: EditDensityTarget;
  /**
   * Signature shader looks this genre reaches for (`vhs`, `halftone`, `prism`,
   * … — see `shader-effects.ts`). Suggestions for the director, NOT part of
   * style scoring: a plan is never penalized for skipping them, but a genre
   * that names one gets it placed on a moment instead of on every shot.
   */
  readonly signatureEffects?: readonly string[];
}

export type EditGenre = Genre;
