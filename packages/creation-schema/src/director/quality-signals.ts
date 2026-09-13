export type SportsMomentEvent =
  | "action-peak"
  | "shot-release"
  | "crowd-reaction"
  | "celebration"
  | "dialogue-emphasis"
  | "unknown";

export interface RenderedFrameObservation {
  readonly timestamp: number;
  readonly sharpness: number;
  readonly subjectVisibility: number;
  readonly textLegibility: number;
  readonly audioEnergy?: number;
  readonly hasBlackFrame?: boolean;
}

export interface RenderedDraftReview {
  readonly score: number;
  readonly issues: readonly string[];
}

export function scoreSportsMoment(input: {
  readonly motionPeak?: number;
  readonly audioEnergy?: number;
  readonly facePresenceRatio?: number;
  readonly hasTalkingHead?: boolean;
  readonly hasDialogue?: boolean;
  readonly shotBoundaryAtStart?: boolean;
}): { score: number; event: SportsMomentEvent } {
  const motion = clamp(input.motionPeak ?? 0);
  const audio = clamp(input.audioEnergy ?? 0);
  const face = clamp(input.facePresenceRatio ?? 0);
  const score = clamp(
    motion * 0.5
      + audio * 0.25
      + face * 0.1
      + (input.shotBoundaryAtStart ? 0.1 : 0)
      + (input.hasTalkingHead || input.hasDialogue ? 0.05 : 0),
  );
  const event: SportsMomentEvent = input.hasTalkingHead || input.hasDialogue
    ? "dialogue-emphasis"
    : audio >= 0.75 && motion >= 0.65
      ? "crowd-reaction"
      : motion >= 0.8
        ? "shot-release"
        : motion >= 0.55
          ? "action-peak"
          : "unknown";
  return { score, event };
}

export function snapTimeToBeat(
  time: number,
  beatTimestamps: readonly number[],
  tolerance = 0.2,
): number {
  const nearest = beatTimestamps.reduce<{ time: number; distance: number } | undefined>(
    (best, beat) => {
      const distance = Math.abs(beat - time);
      return distance <= tolerance && (!best || distance < best.distance)
        ? { time: beat, distance }
        : best;
    },
    undefined,
  );
  return nearest?.time ?? time;
}

export function reviewRenderedDraft(
  observations: readonly RenderedFrameObservation[],
): RenderedDraftReview {
  if (observations.length === 0) return { score: 0, issues: ["No rendered frame observations were provided."] };
  const issues: string[] = [];
  const blackFrames = observations.filter((observation) => observation.hasBlackFrame).length;
  const lowSharpness = observations.filter((observation) => observation.sharpness < 0.25).length;
  const lowVisibility = observations.filter((observation) => observation.subjectVisibility < 0.35).length;
  const unreadableText = observations.filter((observation) => observation.textLegibility < 0.4).length;
  if (blackFrames > 0) issues.push(`${blackFrames} rendered frame(s) are black or empty.`);
  if (lowSharpness > 0) issues.push(`${lowSharpness} rendered frame(s) are too soft.`);
  if (lowVisibility > 0) issues.push(`${lowVisibility} rendered frame(s) lose the primary subject.`);
  if (unreadableText > 0) issues.push(`${unreadableText} rendered frame(s) have low text legibility.`);
  const penalty = (blackFrames * 0.3 + lowSharpness * 0.15 + lowVisibility * 0.2 + unreadableText * 0.1) / observations.length;
  return { score: Math.max(0, Math.min(1, 1 - penalty)), issues };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}