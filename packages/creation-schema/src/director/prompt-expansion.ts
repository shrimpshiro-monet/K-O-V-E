export type PromptGap = "tone" | "platform" | "content-direction" | "length" | "style";

export interface PromptExpansion {
  readonly expandedPrompt: string;
  readonly completenessScore: number;
  readonly questions: string[] | null;
  readonly rationale: string;
  readonly detectedGaps: PromptGap[];
}

export function scorePromptCompleteness(prompt: string): {
  score: number;
  gaps: PromptGap[];
} {
  const lower = prompt.toLowerCase();
  const gaps: PromptGap[] = [];

  const toneKeywords = [
    "cinematic", "dramatic", "funny", "epic", "chill", "energetic",
    "moody", "dark", "bright", "vibrant", "muted", "clean", "gritty",
    "professional", "casual", "playful", "serious", "emotional", "intense",
    "smooth", "dynamic", "static", "minimal", "maximal",
  ];
  const hasTone = toneKeywords.some((kw) => lower.includes(kw));
  if (!hasTone) gaps.push("tone");

  const platformKeywords = [
    "tiktok", "youtube", "instagram", "reels", "shorts", "stories",
    "twitter", "x.com", "linkedin", "facebook", "vimeo", "broadcast",
    "vertical", "horizontal", "square", "16:9", "9:16", "1:1",
    "landscape", "portrait",
  ];
  const hasPlatform = platformKeywords.some((kw) => lower.includes(kw));
  if (!hasPlatform) gaps.push("platform");

  const contentKeywords = [
    "keep", "cut", "remove", "highlight", "focus", "include", "exclude",
    "opening", "ending", "middle", "intro", "outro", "best part",
    "moment", "scene", "shot", "segment", "chapter",
  ];
  const hasContent = contentKeywords.some((kw) => lower.includes(kw));
  if (!hasContent) gaps.push("content-direction");

  const lengthKeywords = [
    "second", "minute", "hour", "short", "long", "quick", "extended",
    "condensed", "trimmed", "fast", "slow", "30s", "60s", "30 sec",
    "60 sec", "30-second", "60-second", "hook", "teaser", "trailer",
  ];
  const hasLength = lengthKeywords.some((kw) => lower.includes(kw));
  if (!hasLength) gaps.push("length");

  const styleKeywords = [
    "effect", "transition", "color", "grade", "filter", "lut",
    "text", "title", "caption", "subtitle", "font", "animation",
    "motion", "speed", "slow-mo", "timelapse", "zoom", "pan",
  ];
  const hasStyle = styleKeywords.some((kw) => lower.includes(kw));
  if (!hasStyle) gaps.push("style");

  const score = 1 - gaps.length / 5;
  return { score, gaps };
}

export function generateExpansionQuestions(gaps: PromptGap[]): string[] {
  const questions: string[] = [];
  const asked = new Set<PromptGap>();

  for (const gap of gaps) {
    if (asked.has(gap)) continue;
    asked.add(gap);

    switch (gap) {
      case "tone":
        questions.push("What vibe or mood are you going for? (e.g. cinematic, energetic, chill, dramatic)");
        break;
      case "platform":
        questions.push("Where will this be posted? (e.g. TikTok, YouTube, Instagram Reels)");
        break;
      case "content-direction":
        questions.push("Any specific moments to keep, cut, or highlight?");
        break;
      case "length":
        questions.push("How long should the final edit be?");
        break;
      case "style":
        questions.push("Any specific effects, transitions, or text styles you want?");
        break;
    }
    if (questions.length >= 3) break;
  }

  return questions;
}
