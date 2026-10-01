import {
  SIGNATURE_EFFECT_ALIASES,
  SIGNATURE_EFFECT_NAMES,
} from "./shader-effects";

export type PromptGap = "tone" | "platform" | "content-direction" | "length" | "style";

export interface PromptExpansion {
  readonly expandedPrompt: string;
  readonly completenessScore: number;
  readonly questions: string[] | null;
  readonly rationale: string;
  readonly detectedGaps: PromptGap[];
}

/**
 * Score how complete a user prompt is for generating a professional edit.
 * Returns a score 0-1 and the list of missing dimensions.
 *
 * The scoring is multi-layered:
 * 1. Direct keyword matching (fast, catches explicit terms)
 * 2. Contextual inference (catches slang, implied intent, genre patterns)
 * 3. Structural analysis (sentence length, specificity, imperative mood)
 */
export function scorePromptCompleteness(prompt: string): {
  score: number;
  gaps: PromptGap[];
} {
  const lower = prompt.toLowerCase();
  const gaps: PromptGap[] = [];

  // ---- Tone detection ----
  // Direct tone keywords
  const directToneKeywords = [
    "cinematic", "dramatic", "funny", "epic", "chill", "energetic",
    "moody", "dark", "bright", "vibrant", "muted", "clean", "gritty",
    "professional", "casual", "playful", "serious", "emotional", "intense",
    "smooth", "dynamic", "static", "minimal", "maximal", "aggressive",
    "warm", "cool", "raw", "polished", "noir", "dreamy", "retro",
  ];
  // Contextual tone inference (slang, patterns)
  const contextualTonePatterns = [
    /\b(sick|fire|lit|insane|crazy|hard|dope|slaps|banger)\b/,
    /\b(soft|gentle|calm|peaceful|serene|relax)\b/,
    /\b(hype|pump|adrenaline|rush|fast|rapid)\b/,
    /\b(sad|melancholy|somber|heartbreak|emotional)\b/,
    /\b(funny|hilarious|comedy|laugh|humor|goofy)\b/,
    /\b(professional|corporate|business|formal)\b/,
    /\b(trendy|aesthetic|vibes|lo-fi|vintage|retro)\b/,
  ];
  const hasTone = directToneKeywords.some((kw) => lower.includes(kw))
    || contextualTonePatterns.some((re) => re.test(lower));
  if (!hasTone) gaps.push("tone");

  // ---- Platform detection ----
  const directPlatformKeywords = [
    "tiktok", "youtube", "instagram", "reels", "shorts", "stories",
    "twitter", "x.com", "linkedin", "facebook", "vimeo", "broadcast",
    "vertical", "horizontal", "square", "16:9", "9:16", "1:1",
    "landscape", "portrait", "uhd", "4k", "1080", "720",
  ];
  const contextualPlatformPatterns = [
    /\b(social|share|post|upload|publish)\b/,
    /\b(phone|mobile|desktop|tv|screen)\b/,
    /\b(reel|clip|short|highlight|montage)\b/,
  ];
  const hasPlatform = directPlatformKeywords.some((kw) => lower.includes(kw))
    || contextualPlatformPatterns.some((re) => re.test(lower));
  if (!hasPlatform) gaps.push("platform");

  // ---- Content direction detection ----
  const directContentKeywords = [
    "keep", "cut", "remove", "highlight", "focus", "include", "exclude",
    "opening", "ending", "middle", "intro", "outro", "best part",
    "moment", "scene", "shot", "segment", "chapter", "part",
    "the part where", "that moment", "the bit with",
  ];
  const contextualContentPatterns = [
    /\b(use|show|feature|showcase|display)\b/,
    /\b(start|begin|open|end|close|finish)\b/,
    /\b(best|worst|funniest|coolest|most)\b/,
    /\b(from|between|around|at)\s+\d/,
    /\b(clip|segment|part)\s+\d/,
  ];
  const hasContent = directContentKeywords.some((kw) => lower.includes(kw))
    || contextualContentPatterns.some((re) => re.test(lower));
  if (!hasContent) gaps.push("content-direction");

  // ---- Length detection ----
  const directLengthKeywords = [
    "second", "minute", "hour", "short", "long", "quick", "extended",
    "condensed", "trimmed", "fast", "slow", "30s", "60s", "30 sec",
    "60 sec", "30-second", "60-second", "hook", "teaser", "trailer",
    "full", "half", "quarter", "snippet",
  ];
  const contextualLengthPatterns = [
    /\b\d+\s*(sec|s|min|m)\b/,
    /\b(make|create|edit)\s+(it|this|that|a)\s+(short|quick|long)\b/,
    /\b(shorten|trim|cut down|condense)\b/,
  ];
  const hasLength = directLengthKeywords.some((kw) => lower.includes(kw))
    || contextualLengthPatterns.some((re) => re.test(lower));
  if (!hasLength) gaps.push("length");

  // ---- Style detection ----
  // Signature-effect names and their common spellings count as style: "make it
  // look like a VHS tape" or "give it a comic look" already names a look the
  // renderer can build, so the expansion should not ask about style again.
  const signatureStyleKeywords = [
    ...SIGNATURE_EFFECT_NAMES,
    ...Object.keys(SIGNATURE_EFFECT_ALIASES),
  ];
  const directStyleKeywords = [
    "effect", "transition", "color", "grade", "filter", "lut",
    "text", "title", "caption", "subtitle", "font", "animation",
    "motion", "speed", "slow-mo", "timelapse", "zoom", "pan",
    "blur", "glow", "vintage", "film", "grain", "shake",
    "whip", "glitch", "flash", "fade", "dissolve", "wipe",
  ];
  const contextualStylePatterns = [
    /\b(like|style of|similar to|reminiscent|inspired)\b/,
    /\b(look|feel|vibe|aesthetic)\b/,
    /\b(smooth|punchy|dynamic|kinetic)\b/,
  ];
  const hasStyle = directStyleKeywords.some((kw) => lower.includes(kw))
    || signatureStyleKeywords.some((kw) => lower.includes(kw))
    || contextualStylePatterns.some((re) => re.test(lower));
  if (!hasStyle) gaps.push("style");

  // ---- Structural bonus ----
  // Longer, more specific prompts get a small bonus
  const wordCount = prompt.split(/\s+/).length;
  const structuralBonus = wordCount > 15 ? 0.1 : wordCount > 8 ? 0.05 : 0;

  // Imperative mood bonus ("make", "create", "edit", "add", "remove")
  const imperativeBonus = /\b(make|create|edit|add|remove|cut|trim|put|place|sync)\b/i.test(prompt)
    ? 0.05
    : 0;

  const baseScore = 1 - gaps.length / 5;
  const score = Math.min(1, baseScore + structuralBonus + imperativeBonus);
  return { score, gaps };
}

/**
 * Generate targeted clarifying questions for detected gaps.
 * Questions are context-aware and adapt to what's already known.
 */
export function generateExpansionQuestions(gaps: PromptGap[]): string[] {
  const questions: string[] = [];
  const asked = new Set<PromptGap>();

  for (const gap of gaps) {
    if (asked.has(gap)) continue;
    asked.add(gap);

    switch (gap) {
      case "tone":
        questions.push("What vibe or mood are you going for? (e.g. cinematic, energetic, chill, dramatic, professional)");
        break;
      case "platform":
        questions.push("Where will this be posted? (e.g. TikTok, YouTube, Instagram Reels, or just a general edit)");
        break;
      case "content-direction":
        questions.push("Any specific moments to keep, cut, or highlight? Or should I pick the best parts?");
        break;
      case "length":
        questions.push("How long should the final edit be? (e.g. 30 seconds, 1 minute, or let me decide based on the footage)");
        break;
      case "style":
        questions.push("Any specific effects, transitions, or text styles you want? (e.g. smooth transitions, bold text, color grading)");
        break;
    }
    if (questions.length >= 3) break;
  }

  return questions;
}
