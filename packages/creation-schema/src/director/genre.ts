export type CutStyle = "hard" | "soft" | "mixed";
export type MusicRole = "background" | "featured" | "rhythmic";
export type ColorMood = "warm" | "cool" | "neutral" | "vibrant";
export type TextStyleDensity = "none" | "minimal" | "moderate" | "heavy";

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
}

export type EditGenre = Genre;
