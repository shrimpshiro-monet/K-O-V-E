/**
 * Read the rhythmic targets a reference video implies.
 *
 * The beat snap pass needs two things the engine measures but nothing consumed:
 * how fine the reference's cutting is in beats (so a plan can be quantised to the
 * same grid the reference uses) and how far off the beat its cuts actually sit
 * (so a cloned edit can reproduce that feel instead of landing dead-centre on
 * every beat). Neither is audio, so neither belongs to the renderer.
 */

export interface ReferenceBeatTargets {
  /** Median cut offset in seconds. Negative means the reference cuts early. */
  readonly cutOffsetSeconds?: number;
  /** Shot lengths in beats, for choosing the quantisation unit. */
  readonly shotLengthsInBeats?: readonly number[];
  readonly beatPeriodSeconds?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * The cut offset is only meaningful when the reference really does cut on the
 * beat. On a reference whose cuts land anywhere, the median distance to the
 * nearest beat is noise that would then be applied to every cut in the edit.
 */
const MIN_ON_BEAT_RATIO_FOR_OFFSET = 0.5;

const EMPTY: ReferenceBeatTargets = {};

export function referenceBeatTargets(referenceAnalysis: unknown): ReferenceBeatTargets {
  const root = asRecord(referenceAnalysis);
  const videos = Array.isArray(root?.videos) ? root.videos : [];
  if (videos.length === 0) return EMPTY;

  const reference =
    videos.find((video) => asRecord(video)?.role === "reference") ?? videos[0];
  const video = asRecord(reference);
  if (!video) return EMPTY;

  const segments = Array.isArray(video.segments) ? video.segments : [];
  const beats = [
    ...new Set(
      segments.flatMap((segment) => {
        const timestamps = asRecord(segment)?.beatTimestamps;
        return Array.isArray(timestamps)
          ? timestamps.map(asFiniteNumber).filter((value): value is number => value !== undefined)
          : [];
      }),
    ),
  ].sort((left, right) => left - right);

  const gaps: number[] = [];
  for (let index = 1; index < beats.length; index += 1) {
    const gap = beats[index]! - beats[index - 1]!;
    if (gap > 1e-6) gaps.push(gap);
  }
  const beatPeriodSeconds = median(gaps);

  const shotLengthsInBeats =
    beatPeriodSeconds > 0
      ? segments
          .map((segment) => {
            const record = asRecord(segment);
            const start = asFiniteNumber(record?.startTime);
            const end = asFiniteNumber(record?.endTime);
            return start !== undefined && end !== undefined && end > start
              ? (end - start) / beatPeriodSeconds
              : undefined;
          })
          .filter((value): value is number => value !== undefined)
      : [];

  const profile = asRecord(video.styleProfile);
  const cutOffsetMs = asFiniteNumber(profile?.cutOffsetMs);
  const cutOnBeatRatio = asFiniteNumber(profile?.cutOnBeatRatio);
  // A missing ratio means the analysis could not measure it (too few cuts in
  // the grid), which is not the same as measuring zero — but neither is
  // evidence that this reference cuts on the beat, so the offset is withheld.
  const offsetApplies =
    cutOffsetMs !== undefined &&
    cutOnBeatRatio !== undefined &&
    cutOnBeatRatio >= MIN_ON_BEAT_RATIO_FOR_OFFSET;

  return {
    ...(offsetApplies ? { cutOffsetSeconds: cutOffsetMs / 1000 } : {}),
    ...(shotLengthsInBeats.length > 0 ? { shotLengthsInBeats } : {}),
    ...(beatPeriodSeconds > 0 ? { beatPeriodSeconds } : {}),
  };
}
