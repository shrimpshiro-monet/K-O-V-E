export interface DurationTarget {
  /** First mention's hi end, in seconds. Null when the prompt names no duration. */
  readonly target: number | null;
  /** Every raw matched substring, in order — quoted verbatim in the warning. */
  readonly mentions: readonly string[];
}

/**
 * Reads the brief's target length: first mention decides, ranges take the hi end.
 * "Cut a 45-second Short ... hit roughly one point every 12-15 seconds" → 45s.
 *
 * Lives in creation-schema so BOTH consumers see identical semantics: the eval
 * baseline's duration-fidelity measurement and the director plan normalizer
 * (which derives a targetDuration fallback from the brief instead of
 * manufacturing 0 when the LLM omits the field).
 */
export function promptDurationTarget(promptText: string): DurationTarget {
  const mentions: string[] = [];
  let target: number | null = null;
  const pattern =
    /(\d+(?:\.\d+)?)(?:\s*(?:-|–|—|to|through)\s*(\d+(?:\.\d+)?))?\s*-?\s*(seconds?|secs?|s|minutes?|mins?)(?![a-z0-9])/gi;
  for (const match of promptText.matchAll(pattern)) {
    mentions.push(match[0]);
    if (target !== null) continue;
    const lo = Number(match[1]);
    const hi = match[2] !== undefined ? Number(match[2]) : lo;
    const unit = match[3].toLowerCase();
    target = Math.max(lo, hi) * (unit.startsWith("min") ? 60 : 1);
  }
  return { target, mentions };
}

export function formatSeconds(value: number): string {
  return `${Math.round(value * 10) / 10}s`;
}
